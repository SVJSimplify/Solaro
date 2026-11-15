-- 0036 Push notifications for the Solara Android app, and the missing link that delivers queued messages.
-- Staff devices get alerts for their clinic; patient devices get updates for chats they started in the app and,
-- once the phone number is proven (Firebase phone sign-in), for that number's appointments.

-- ── Delivery: wake the dispatcher every minute when something is due ─────────
-- outbox_kick() posts to the outbox-dispatch function; it needs pg_net and the function address in the vault.
create extension if not exists pg_net;
do $$ begin
  if not exists (select 1 from vault.secrets where name='outbox_dispatch_url') then
    perform vault.create_secret('https://wqhxpfzbvtkdwzehddjr.supabase.co/functions/v1/outbox-dispatch','outbox_dispatch_url','Where outbox_kick() sends its wake-up call');
  end if;
end $$;
select cron.unschedule('solara-outbox') where exists(select 1 from cron.job where jobname='solara-outbox');
select cron.schedule('solara-outbox','* * * * *','select public.outbox_kick()');

-- ── Outbox carries push messages too ─────────────────────────────────────────
alter table outbox add column if not exists title text not null default '';
alter table outbox add column if not exists data jsonb not null default '{}';

-- The dispatcher only claims channels it can send right now, so push keeps flowing while SMS is not set up.
drop function if exists outbox_claim(integer);
create or replace function outbox_claim(p_limit integer default 20, p_channels text[] default null) returns setof outbox
language plpgsql security definer set search_path=public as $$
begin
  return query update outbox o set status='processing', attempts=o.attempts+1, claimed_at=now()
    where o.id in (select x.id from outbox x
      where ((x.status='queued' and x.next_attempt_at<=now()) or (x.status='processing' and x.claimed_at<now()-interval '5 minutes'))
        and (p_channels is null or x.channel = any(p_channels))
      order by x.created_at limit greatest(1,least(coalesce(p_limit,20),100)) for update skip locked)
    returning o.*;
end $$;
revoke execute on function outbox_claim(integer,text[]) from public, anon, authenticated;
grant execute on function outbox_claim(integer,text[]) to service_role;

-- ── Devices ──────────────────────────────────────────────────────────────────
create table if not exists push_devices (
  id uuid primary key default gen_random_uuid(),
  token text not null unique check (length(token) between 20 and 4096),
  role text not null check (role in ('staff','patient')),
  user_id uuid references auth.users(id) on delete cascade,      -- staff
  org_id uuid references organizations(id) on delete cascade,    -- staff: the clinic they are signed in to
  phone text,                                                    -- patient: set only after Firebase phone sign-in
  firebase_uid text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  disabled_at timestamptz,
  check (role<>'staff' or (user_id is not null and org_id is not null))
);
create index if not exists push_devices_staff on push_devices(org_id) where role='staff' and disabled_at is null;
create index if not exists push_devices_phone on push_devices(phone) where role='patient' and disabled_at is null;
-- Which clinics (and chats) a patient device belongs to: a clinic can only reach patients who used it in the app.
create table if not exists push_links (
  device_id uuid not null references push_devices(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists push_links_unique on push_links(device_id, org_id, coalesce(conversation_id,'00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists push_links_conv on push_links(conversation_id);
alter table push_devices enable row level security;
alter table push_links enable row level security;
revoke all on push_devices, push_links from anon, authenticated;

-- Staff: register this phone for the clinic they are signed in to (re-registering moves it).
create or replace function register_staff_device(p_token text, p_org uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not is_member(p_org) then raise exception 'Not a member of this clinic' using errcode='42501'; end if;
  perform throttle('push_register:'||auth.uid(), 30, 3600);
  insert into push_devices(token,role,user_id,org_id) values (p_token,'staff',auth.uid(),p_org)
    on conflict (token) do update set role='staff', user_id=auth.uid(), org_id=p_org, phone=null, firebase_uid=null, last_seen=now(), disabled_at=null;
  delete from push_links l using push_devices d where d.token=p_token and l.device_id=d.id;
end $$;

-- Sign-out: stop notifications on this phone.
create or replace function unregister_device(p_token text) returns void
language sql security definer set search_path=public as $$
  update push_devices set disabled_at=now() where token=p_token and (user_id=auth.uid() or user_id is null) $$;

revoke execute on function register_staff_device(text,uuid), unregister_device(text) from public, anon;
grant execute on function register_staff_device(text,uuid), unregister_device(text) to authenticated;

-- ── Queueing ─────────────────────────────────────────────────────────────────
create or replace function push_staff(p_org uuid, p_title text, p_body text, p_link text, p_kind text) returns int
language plpgsql security definer set search_path=public as $$
declare n int;
begin
  insert into outbox(org_id,channel,to_addr,title,body,data,kind)
    select p_org,'push',d.token,left(p_title,80),left(p_body,180),jsonb_build_object('link',p_link,'audience','staff','org',p_org),p_kind
    from push_devices d where d.role='staff' and d.org_id=p_org and d.disabled_at is null
      and exists(select 1 from members m where m.org_id=p_org and m.user_id=d.user_id);
  get diagnostics n = row_count; return n;
end $$;

-- Patient devices linked to a chat, or to a verified phone number that used this clinic in the app.
create or replace function push_patient(p_org uuid, p_conversation uuid, p_phone text, p_title text, p_body text, p_kind text) returns int
language plpgsql security definer set search_path=public as $$
declare n int; k uuid := (select widget_key from organizations where id=p_org);
begin
  insert into outbox(org_id,channel,to_addr,title,body,data,kind)
    select distinct on (d.token) p_org,'push',d.token,left(p_title,80),left(p_body,180),
      jsonb_build_object('link','/widget?key='||k,'audience','patient','org',p_org),p_kind
    from push_devices d join push_links l on l.device_id=d.id and l.org_id=p_org
    where d.role='patient' and d.disabled_at is null
      and ((p_conversation is not null and l.conversation_id=p_conversation)
        or (coalesce(p_phone,'')<>'' and d.phone=p_phone));
  get diagnostics n = row_count; return n;
end $$;
revoke execute on function push_staff(uuid,text,text,text,text), push_patient(uuid,uuid,text,text,text,text) from public, anon, authenticated;

-- ── What triggers a notification ─────────────────────────────────────────────
-- Staff: a chat needs a person (urgent ones say so); a new website booking request.
create or replace function notify_staff_alert() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(new.text,'') like 'Patient cancelled%' then
    perform push_staff(new.org_id,'Appointment cancelled',coalesce(nullif(new.customer,''),'A patient')||' cancelled.','/bookings','alert');
  elsif new.reason in ('emergency','health_risk') then
    perform push_staff(new.org_id,'Urgent: patient needs a person',coalesce(nullif(new.customer,''),'A patient')||' — open the chat now.','/inbox?c='||new.convo,'urgent');
  else
    perform push_staff(new.org_id,'A chat needs a person',coalesce(nullif(new.customer,''),'A patient')||' is waiting in the Inbox.','/inbox?c='||new.convo,'handoff');
  end if;
  return new;
end $$;
drop trigger if exists alerts_push on alerts;
create trigger alerts_push after insert on alerts for each row execute function notify_staff_alert();

create or replace function notify_staff_request() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.status='requested' and (tg_op='INSERT' or old.status is distinct from 'requested') then
    perform push_staff(new.org_id,'New booking request',
      coalesce(nullif(new.name,''),'A patient')||' · '||coalesce(nullif(new.service,''),'appointment')||' · '||to_char(new.starts_at,'Dy DD Mon, FMHH12:MI AM'),
      '/bookings?view=day&date='||to_char(new.starts_at,'YYYY-MM-DD')||'&id='||new.id,'request');
  end if;
  return new;
end $$;
drop trigger if exists bookings_push on bookings;
create trigger bookings_push after insert or update of status on bookings for each row execute function notify_staff_request();

-- Patients: a staff reply in their chat (this also covers booking confirmations, which post into the chat).
create or replace function notify_patient_message() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.role='staff' then
    perform push_patient(new.org_id,new.conversation_id,null,(select name from organizations where id=new.org_id),new.body,'reply');
  end if;
  return new;
end $$;
drop trigger if exists messages_push on messages;
create trigger messages_push after insert on messages for each row execute function notify_patient_message();

-- Booking changes for bookings that have no chat (made by staff) reach the patient's verified app by phone.
create or replace function booking_notify(b bookings, p_body text, p_kind text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if b.conversation_id is not null then
    insert into messages(org_id,conversation_id,role,body) values(b.org_id,b.conversation_id,'staff',p_body);   -- also pushes to the chat's devices
  else
    perform push_patient(b.org_id,null,b.phone,(select name from organizations where id=b.org_id),p_body,p_kind);
  end if;
  if coalesce(b.phone,'')<>'' then
    insert into outbox(org_id,channel,to_addr,body,kind,booking_id) values(b.org_id,'sms',b.phone,p_body,p_kind,b.id);
  end if;
end $$;

-- Reminders: by text message (when connected) and to the patient's app.
create or replace function queue_due_reminders() returns jsonb
language plpgsql security definer set search_path=public as $$
declare x int; r record; p int := 0; msg text;
begin
  for r in
    update bookings b set reminded=true
    where b.status='booked' and not b.reminded
      and b.starts_at > (now() at time zone 'UTC')-interval '13 hours' and b.starts_at <= (now() at time zone 'UTC')+interval '39 hours'
      and b.starts_at > clinic_now(b.org_id) and b.starts_at <= clinic_now(b.org_id)+interval '24 hours'
    returning b.*
  loop
    msg := 'Reminder: '||coalesce(nullif(r.service,''),'appointment')||coalesce(' with '||nullif(r.doctor,''),'')||' on '||to_char(r.starts_at,'Dy, Mon FMDD "at" FMHH12:MI AM')||'.';
    if coalesce(r.phone,'')<>'' then
      insert into outbox(org_id,channel,to_addr,body,kind,booking_id) values(r.org_id,'sms',r.phone,msg,'reminder',r.id);
    end if;
    p := p + push_patient(r.org_id,r.conversation_id,r.phone,(select name from organizations where id=r.org_id),msg,'reminder');
  end loop;
  update outbox set status='failed', last_error='Not sent within 24 hours. Check that a text-message provider is connected.'
    where status='queued' and channel='sms' and created_at<now()-interval '24 hours';
  get diagnostics x = row_count;
  -- A notification that is a day old is no longer useful.
  update outbox set status='failed', last_error='Not delivered within 24 hours. Check that push notifications are connected.'
    where status='queued' and channel='push' and created_at<now()-interval '24 hours';
  return jsonb_build_object('push',p,'expired',x);
end $$;

-- A device the push service says no longer exists is switched off.
create or replace function push_device_gone(p_token text) returns void language sql security definer set search_path=public as $$
  update push_devices set disabled_at=now() where token=p_token $$;
revoke execute on function push_device_gone(text) from public, anon, authenticated;
grant execute on function push_device_gone(text) to service_role;
