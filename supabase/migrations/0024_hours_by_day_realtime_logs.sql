-- Clinic hours per weekday, edited in Knowledge. One copy: settings.hours. Everything else reads it.
-- {"1":{"start":"13:00","end":"22:00"},"6":{"start":"14:00","end":"18:00"}}  (0=Sunday; a missing day is closed)

create or replace function valid_hours(h jsonb) returns boolean language sql immutable as $$
  select h is not null and jsonb_typeof(h)='object' and not exists(
    select 1 from jsonb_each(h) e
    where e.key !~ '^[0-6]$' or jsonb_typeof(e.value)<>'object'
       or coalesce(e.value->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(e.value->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$'
       or (e.value->>'start') >= (e.value->>'end')) $$;

alter table settings add column if not exists hours jsonb;
update settings s set hours=(select jsonb_object_agg(d::text,jsonb_build_object('start',s.open_start,'end',s.open_end)) from unnest(s.open_days) d)
  where s.hours is null and s.open_start is not null;
update settings set hours='{"1":{"start":"09:00","end":"17:00"},"2":{"start":"09:00","end":"17:00"},"3":{"start":"09:00","end":"17:00"},"4":{"start":"09:00","end":"17:00"},"5":{"start":"09:00","end":"17:00"}}' where hours is null;
alter table settings alter column hours set default '{"1":{"start":"09:00","end":"17:00"},"2":{"start":"09:00","end":"17:00"},"3":{"start":"09:00","end":"17:00"},"4":{"start":"09:00","end":"17:00"},"5":{"start":"09:00","end":"17:00"}}';
alter table settings alter column hours set not null;
alter table settings drop constraint if exists settings_hours_valid;
alter table settings add constraint settings_hours_valid check (valid_hours(hours));

-- Retire the single-range hours and the doctor clamping that came with them.
drop trigger if exists doctors_within_clinic on doctors;
drop trigger if exists settings_hours_changed on settings;
drop trigger if exists settings_hours_answer on settings;
drop function if exists doctor_within_clinic();
drop function if exists clinic_hours_changed();
alter table settings drop constraint if exists settings_hours_ok;
alter table settings drop column if exists open_days, drop column if exists open_start, drop column if exists open_end;
drop function if exists hours_text(int[],text,text);

-- The clinic's open range on a date, or null when closed.
create or replace function clinic_day(p_org uuid, p_date date) returns jsonb
language sql stable security definer set search_path=public as $$
  select hours->(extract(dow from p_date)::int::text) from settings where org_id=p_org $$;

-- The Hours answer in Knowledge is written from the hours and marked as managed (edited through the hours editor only).
alter table kb add column if not exists managed boolean not null default false;

create or replace function hours_text(h jsonb) returns text language plpgsql immutable as $$
declare n text[]:=array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  parts text[]:='{}'; closed text[]:='{}'; i int:=1; j int; r text; nx text; order_ int[]:=array[1,2,3,4,5,6,0];
  rng text;
begin
  while i<=7 loop
    r:=case when h ? order_[i]::text then fmt_hm(h->order_[i]::text->>'start')||' to '||fmt_hm(h->order_[i]::text->>'end') end;
    if r is null then closed:=closed||n[order_[i]+1]; i:=i+1; continue; end if;
    j:=i;
    loop
      exit when j>=7;
      nx:=case when h ? order_[j+1]::text then fmt_hm(h->order_[j+1]::text->>'start')||' to '||fmt_hm(h->order_[j+1]::text->>'end') end;
      exit when nx is distinct from r;
      j:=j+1;
    end loop;
    rng:=case when j-i>=2 then n[order_[i]+1]||' to '||n[order_[j]+1] when j>i then n[order_[i]+1]||' and '||n[order_[j]+1] else n[order_[i]+1] end;
    parts:=parts||(rng||' '||r);
    i:=j+1;
  end loop;
  if array_length(parts,1) is null then return 'The clinic is currently closed every day.'; end if;
  return 'Open '||array_to_string(parts,'; ')||'.'||case when array_length(closed,1) is null then '' else ' Closed '||array_to_string(closed,', ')||'.' end;
end $$;

create or replace function sync_hours_answer() returns trigger
language plpgsql security definer set search_path=public as $$
declare txt text:=hours_text(new.hours);
begin
  update kb set body=txt, managed=true where org_id=new.org_id and lower(title)='hours' and (body is distinct from txt or not managed);
  if not exists(select 1 from kb where org_id=new.org_id and lower(title)='hours') then
    insert into kb(org_id,title,body,keywords,managed) values(new.org_id,'Hours',txt,'hours open opening closing time today saturday sunday',true);
  end if;
  return new;
end $$;
drop trigger if exists settings_hours_answer on settings;
create trigger settings_hours_answer after insert or update of hours on settings for each row execute function sync_hours_answer();

-- The managed Hours answer can only change through the hours.
create or replace function kb_guard_managed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if current_setting('solara.hours_sync',true)='on' then return coalesce(new,old); end if;
  if tg_op='DELETE' and old.managed then raise exception 'Clinic hours are edited in the hours section of Knowledge.' using errcode='P0001'; end if;
  if tg_op='UPDATE' and old.managed and auth.uid() is not null and (new.body is distinct from old.body or new.title is distinct from old.title) then
    raise exception 'Clinic hours are edited in the hours section of Knowledge.' using errcode='P0001'; end if;
  return coalesce(new,old);
end $$;
drop trigger if exists kb_managed_guard on kb;
create trigger kb_managed_guard before update or delete on kb for each row execute function kb_guard_managed();

-- Owners and admins set the hours; the value is validated by the check constraint.
create or replace function set_clinic_hours(p_org uuid, p_hours jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not exists(select 1 from members where org_id=p_org and user_id=auth.uid() and role in ('owner','admin'))
    then raise exception 'Only an owner or admin can change clinic hours.' using errcode='42501'; end if;
  if not valid_hours(p_hours) then raise exception 'Each open day needs a start and an end time, with the end after the start.' using errcode='P0001'; end if;
  perform set_config('solara.hours_sync','on',true);
  insert into settings(org_id,hours) values(p_org,p_hours) on conflict(org_id) do update set hours=excluded.hours;
  perform set_config('solara.hours_sync','off',true);
  insert into audit_events(org_id,actor,action,target_type,detail) values(p_org,auth.uid(),'hours.changed','settings',jsonb_build_object('text',hours_text(p_hours)));
  return p_hours;
end $$;
revoke all on function set_clinic_hours(uuid,jsonb) from public, anon;
grant execute on function set_clinic_hours(uuid,jsonb) to authenticated;

-- Write every clinic's Hours answer now.
select set_config('solara.hours_sync','on',false);
update settings set hours=hours;
select set_config('solara.hours_sync','off',false);

-- Bookings: the database enforces clinic hours per weekday and refuses times that have already passed (clinic time).
create or replace function validate_booking() returns trigger
language plpgsql security definer set search_path=public as $$
declare d doctors; m int; dt date; day jsonb;
begin
  new.updated_at := now();
  if new.status not in ('requested','booked') then return new; end if;
  if tg_op='UPDATE' and new.starts_at=old.starts_at and new.doctor_id is not distinct from old.doctor_id
     and (old.status=new.status or old.status in ('booked','completed','no_show')) then return new; end if;
  dt := new.starts_at::date; m := extract(hour from new.starts_at)::int*60+extract(minute from new.starts_at)::int;
  if (tg_op='INSERT' or new.starts_at is distinct from old.starts_at) and new.starts_at < clinic_now(new.org_id) then
    raise exception 'That time has already passed.' using errcode='23514'; end if;
  if exists(select 1 from closures c where c.org_id=new.org_id and c.date=dt::text)
     or exists(select 1 from schedule_exceptions e where e.org_id=new.org_id and e.kind='closure' and e.entity_id is null and e.status='confirmed'
               and e.on_date=dt and (e.start_min is null or (m>=e.start_min and m<e.end_min)))
  then raise exception 'The clinic is closed at that time.' using errcode='23514'; end if;
  day := clinic_day(new.org_id, dt);
  if exists(select 1 from settings where org_id=new.org_id) and
     (day is null or m < hhmm_min(day->>'start') or m+new.duration_min > hhmm_min(day->>'end')) then
    raise exception 'That is outside the clinic''s opening hours.' using errcode='23514'; end if;
  if new.doctor_id is null then return new; end if;
  select * into d from doctors where id=new.doctor_id and org_id=new.org_id;
  if not found then raise exception 'That doctor is not part of this clinic.' using errcode='23514'; end if;
  if not (extract(dow from new.starts_at)::int = any(d.days)) or m<hhmm_min(d.start_time) or m+new.duration_min>hhmm_min(d.end_time)
     or (m-hhmm_min(d.start_time)) % d.slot <> 0
  then raise exception '% does not work at that time.', d.name using errcode='23514'; end if;
  if exists(select 1 from schedule_exceptions e join business_entities be on be.id=e.entity_id
            where e.org_id=new.org_id and be.legacy_doctor_id=d.id and e.status='confirmed' and e.kind in ('leave','unavailable')
              and e.on_date=dt and (e.start_min is null or (m>=e.start_min and m<e.end_min)))
  then raise exception '% is away at that time.', d.name using errcode='23514'; end if;
  new.doctor := d.name;
  return new;
end $$;

-- Live updates for hours too.
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='settings') then
    alter publication supabase_realtime add table settings; end if;
end $$;

-- Install check: ignore Vercel preview deployments (they are not the clinic's site), and let owners remove a site.
delete from widget_installs where origin ~ '^https://[a-z0-9-]+-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$';
create or replace function widget_ping(key uuid, origin text) returns void
language plpgsql security definer set search_path=public as $$
declare org uuid := widget_org(key); o text := lower(trim(origin));
begin
  if org is null or o is null or length(o)>200 or o !~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$'
     or o ~ '^https://[a-z0-9-]+-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$' then return; end if;
  if exists(select 1 from widget_installs w where w.org_id=org and w.origin=o) then
    update widget_installs set last_seen=now() where org_id=org and widget_installs.origin=o and last_seen<now()-interval '10 minutes';
  elsif (select count(*) from widget_installs w where w.org_id=org)<20 then
    insert into widget_installs(org_id,origin) values(org,o) on conflict do nothing;
  end if;
end $$;
drop policy if exists widget_installs_delete on widget_installs;
create policy widget_installs_delete on widget_installs for delete
  using (exists(select 1 from members m where m.org_id=widget_installs.org_id and m.user_id=auth.uid() and m.role in ('owner','admin')));

-- Deleting logs: owners and admins only, by id or by period. Appointments and chats are never touched.
-- kind: activity (audit_events), messages (outbox, finished only), handoffs (alerts). Returns how many were removed.
create or replace function delete_logs(p_org uuid, p_kind text, p_ids uuid[] default null, p_from timestamptz default null, p_to timestamptz default null)
returns int language plpgsql security definer set search_path=public as $$
declare n int;
begin
  if not exists(select 1 from members where org_id=p_org and user_id=auth.uid() and role in ('owner','admin'))
    then raise exception 'Only an owner or admin can delete logs.' using errcode='42501'; end if;
  if p_ids is null and p_from is null and p_to is null then raise exception 'Choose entries or a period to delete.' using errcode='P0001'; end if;
  if p_kind='activity' then
    delete from audit_events where org_id=p_org and (p_ids is null or id=any(p_ids))
      and (p_from is null or created_at>=p_from) and (p_to is null or created_at<p_to);
  elsif p_kind='messages' then
    delete from outbox where org_id=p_org and status in ('sent','failed') and (p_ids is null or id=any(p_ids))
      and (p_from is null or created_at>=p_from) and (p_to is null or created_at<p_to);
  elsif p_kind='handoffs' then
    delete from alerts where org_id=p_org and (p_ids is null or id=any(p_ids))
      and (p_from is null or created_at>=p_from) and (p_to is null or created_at<p_to);
  else raise exception 'Unknown log type.' using errcode='P0001'; end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function delete_logs(uuid,text,uuid[],timestamptz,timestamptz) from public, anon;
grant execute on function delete_logs(uuid,text,uuid[],timestamptz,timestamptz) to authenticated;
