-- 0016: Outgoing messages get a real delivery lifecycle, and reminders move from the staff browser to the database.
-- Additive. Rollback: drop the functions and cron jobs below; the new outbox columns are harmless if left.

-- Clinic-local time helpers. An unknown time zone falls back to UTC instead of failing the caller.
create or replace function clinic_tz(p_org uuid) returns text language sql stable security definer set search_path=public as
$$ select coalesce((select o.timezone from organizations o where o.id=p_org and exists(select 1 from pg_timezone_names n where n.name=o.timezone)),'UTC') $$;
create or replace function clinic_now(p_org uuid) returns timestamp language sql stable security definer set search_path=public as
$$ select (now() at time zone clinic_tz(p_org))::timestamp $$;
revoke all on function clinic_tz(uuid), clinic_now(uuid) from public, anon;
grant execute on function clinic_tz(uuid), clinic_now(uuid) to authenticated, service_role;

-- 1. Outbox lifecycle: queued -> processing -> sent | failed (retries go back to queued with a backoff).
--    "sent" means the provider accepted it. Nothing is ever recorded as sent by the app itself.
alter table outbox add column if not exists kind text not null default 'message';
alter table outbox add column if not exists booking_id uuid references bookings(id) on delete set null;
alter table outbox add column if not exists attempts int not null default 0;
alter table outbox add column if not exists last_error text not null default '';
alter table outbox add column if not exists next_attempt_at timestamptz not null default now();
alter table outbox add column if not exists claimed_at timestamptz;
alter table outbox add column if not exists sent_at timestamptz;
alter table outbox add column if not exists provider_id text not null default '';
-- Rows written before delivery existed were labelled "sent" but never left the database. Say so.
update outbox set status='failed', last_error='Recorded before message delivery was connected. Never sent.' where status='sent' and sent_at is null;
alter table outbox alter column status set default 'queued';
do $$ begin
  alter table outbox add constraint outbox_status_check check (status in ('queued','processing','sent','failed')) not valid;
exception when duplicate_object then null; end $$;
create index if not exists outbox_due on outbox(next_attempt_at) where status in ('queued','processing');

-- Staff may read the outbox and queue a message. Only the server changes delivery state.
create or replace function outbox_guard() returns trigger language plpgsql set search_path=public as $$
begin new.status:='queued'; new.attempts:=0; new.sent_at:=null; new.claimed_at:=null; new.provider_id:=''; new.last_error:=''; new.next_attempt_at:=now(); return new; end $$;
drop trigger if exists outbox_guard on outbox;
create trigger outbox_guard before insert on outbox for each row execute function outbox_guard();
drop policy if exists staff_all on outbox;
drop policy if exists staff_read on outbox;
drop policy if exists staff_queue on outbox;
create policy staff_read on outbox for select to authenticated using (org_id in (select my_staff_org_ids()));
create policy staff_queue on outbox for insert to authenticated with check (org_id in (select my_staff_org_ids()));

-- Atomic claim for the sender. Also picks up rows a crashed sender left in "processing" (at-least-once delivery).
create or replace function outbox_claim(p_limit int default 20) returns setof outbox language plpgsql security definer set search_path=public as $$
begin
  return query update outbox o set status='processing', attempts=o.attempts+1, claimed_at=now()
    where o.id in (select x.id from outbox x where (x.status='queued' and x.next_attempt_at<=now()) or (x.status='processing' and x.claimed_at<now()-interval '5 minutes')
                   order by x.created_at limit greatest(1,least(coalesce(p_limit,20),100)) for update skip locked)
    returning o.*;
end $$;
create or replace function outbox_mark(p_id uuid, p_ok boolean, p_error text default '', p_provider_id text default '') returns void
language sql security definer set search_path=public as $$
  update outbox set
    status=case when p_ok then 'sent' when attempts>=5 then 'failed' else 'queued' end,
    sent_at=case when p_ok then now() else sent_at end,
    provider_id=case when p_ok then left(coalesce(p_provider_id,''),100) else provider_id end,
    last_error=case when p_ok then '' else left(coalesce(p_error,''),300) end,
    next_attempt_at=case when p_ok then next_attempt_at else now()+make_interval(mins => power(2,attempts)::int) end,
    claimed_at=null
  where id=p_id and status='processing';
$$;
revoke all on function outbox_claim(int), outbox_mark(uuid,boolean,text,text), outbox_guard() from public, anon, authenticated;
grant execute on function outbox_claim(int), outbox_mark(uuid,boolean,text,text) to service_role;

-- 2. Reminders. One statement claims each due appointment and queues its reminder, so it can never be sent twice,
--    and it runs whether or not anyone has the dashboard open. "Due" is judged in each clinic's own time zone.
create index if not exists bookings_reminder_due on bookings(starts_at) where status='booked' and not reminded;
create or replace function queue_due_reminders() returns jsonb language plpgsql security definer set search_path=public as $$
declare n int; x int;
begin
  with due as (
    update bookings b set reminded=true
    where b.status='booked' and not b.reminded
      and b.starts_at > (now() at time zone 'UTC')-interval '13 hours' and b.starts_at <= (now() at time zone 'UTC')+interval '39 hours'   -- index-friendly bound covering every time zone
      and b.starts_at > clinic_now(b.org_id) and b.starts_at <= clinic_now(b.org_id)+interval '24 hours'
    returning b.*)
  insert into outbox(org_id,channel,to_addr,body,kind,booking_id)
    select org_id,'sms',phone,'Reminder: '||coalesce(nullif(service,''),'appointment')||coalesce(' with '||nullif(doctor,''),'')||' on '||to_char(starts_at,'Dy, Mon FMDD "at" FMHH12:MI AM')||'.','reminder',id
    from due where coalesce(phone,'')<>'';
  get diagnostics n = row_count;
  -- A message nobody could send for a day is a failure staff must see, not a queue that grows quietly.
  update outbox set status='failed', last_error='Not sent within 24 hours. Check that a text-message provider is connected.' where status='queued' and created_at<now()-interval '24 hours';
  get diagnostics x = row_count;
  return jsonb_build_object('queued',n,'expired',x);
end $$;
revoke all on function queue_due_reminders() from public, anon, authenticated;
grant execute on function queue_due_reminders() to service_role;

-- 3. The sender runs as an Edge Function (outbox-dispatch). pg_cron wakes it only when something is due.
--    The shared token is generated here and never leaves the database: the function asks outbox_dispatch_check to verify it.
do $$ begin
  if not exists(select 1 from vault.secrets where name='outbox_dispatch_token') then
    perform vault.create_secret(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),'outbox_dispatch_token','Shared secret between pg_cron and the outbox-dispatch function');
  end if;
exception when others then raise notice 'dispatch token skipped: %', sqlerrm; end $$;
create or replace function outbox_dispatch_check(p_token text) returns boolean language sql stable security definer set search_path=public as
$$ select exists(select 1 from vault.decrypted_secrets where name='outbox_dispatch_token' and decrypted_secret=p_token) $$;
-- outbox_dispatch_url (vault) holds this project's function URL, so no environment is hard-coded in a migration.
create or replace function outbox_kick() returns boolean language plpgsql security definer set search_path=public as $$
declare u text; t text;
begin
  if not exists(select 1 from outbox where (status='queued' and next_attempt_at<=now()) or (status='processing' and claimed_at<now()-interval '5 minutes')) then return false; end if;
  select decrypted_secret into u from vault.decrypted_secrets where name='outbox_dispatch_url';
  select decrypted_secret into t from vault.decrypted_secrets where name='outbox_dispatch_token';
  if u is null or t is null then return false; end if;
  perform net.http_post(url:=u, headers:=jsonb_build_object('content-type','application/json','x-dispatch-token',t), body:='{}'::jsonb);
  return true;
end $$;
revoke all on function outbox_dispatch_check(text), outbox_kick() from public, anon, authenticated;
grant execute on function outbox_dispatch_check(text) to service_role;

-- 4. Schedules. Guarded so a database without pg_cron (local tests) still builds.
do $$ begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('solara-reminders','*/5 * * * *','select public.queue_due_reminders()');
    -- The sender is switched on separately, once outbox-dispatch is deployed and a text provider is connected (see README, Operations).
    perform cron.schedule('solara-prune','17 3 * * *','select public.prune_operational_data()');
    perform cron.schedule('solara-expire-info','7 * * * *','select public.expire_information()');
  end if;
exception when others then raise notice 'schedules skipped: %', sqlerrm; end $$;
