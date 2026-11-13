-- 0017: The database is the authority for appointments. Every path (dashboard, staff assistant, website chat) goes through
-- the same rules, and each staff action is one transaction: the change, its audit record and the patient's message.
-- Additive. Rollback: drop trigger bookings_validate, constraint bookings_no_overlap and the booking_* functions.

-- 1. Lifecycle: requested -> booked -> completed | no_show, or cancelled.
alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check check (status in ('requested','booked','cancelled','completed','no_show')) not valid;
alter table bookings add column if not exists duration_min int not null default 30;
alter table bookings add column if not exists updated_at timestamptz not null default now();
do $$ begin
  alter table bookings add constraint bookings_duration_check check (duration_min between 5 and 480);
exception when duplicate_object then null; end $$;
-- A doctor can never hold two overlapping appointments, whatever slot length they use (the unique index only caught equal start times).
do $$ begin
  alter table bookings add constraint bookings_no_overlap exclude using gist
    (doctor_id with =, tsrange(starts_at, starts_at + make_interval(mins => duration_min)) with &&) where (status<>'cancelled' and doctor_id is not null);
exception when duplicate_object or duplicate_table then null; end $$;
do $$ begin alter publication supabase_realtime add table schedule_exceptions; exception when others then null; end $$;

create or replace function hhmm_min(t text) returns int language sql immutable as $$ select split_part(t,':',1)::int*60+split_part(t,':',2)::int $$;

-- 2. Slot rules, checked on every write that places or re-places an appointment:
--    clinic open, doctor works that weekday and time on their slot grid, and no confirmed leave. Tentative leave never blocks.
create or replace function validate_booking() returns trigger language plpgsql security definer set search_path=public as $$
declare d doctors; m int; dt date;
begin
  new.updated_at := now();
  if new.status not in ('requested','booked') then return new; end if;
  if tg_op='UPDATE' and new.starts_at=old.starts_at and new.doctor_id is not distinct from old.doctor_id
     and (old.status=new.status or old.status in ('booked','completed','no_show')) then return new; end if;
  dt := new.starts_at::date; m := extract(hour from new.starts_at)::int*60+extract(minute from new.starts_at)::int;
  if exists(select 1 from closures c where c.org_id=new.org_id and c.date=dt::text)
     or exists(select 1 from schedule_exceptions e where e.org_id=new.org_id and e.kind='closure' and e.entity_id is null and e.status='confirmed'
               and e.on_date=dt and (e.start_min is null or (m>=e.start_min and m<e.end_min)))
  then raise exception 'The clinic is closed at that time.' using errcode='23514'; end if;
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
revoke all on function validate_booking() from public, anon, authenticated;
drop trigger if exists bookings_validate on bookings;
create trigger bookings_validate before insert or update on bookings for each row execute function validate_booking();

-- 3. Telling the patient. In the website chat when the appointment came from one, and always by text message.
--    The text is queued; the outbox records whether it was actually sent.
create or replace function booking_notify(b bookings, p_body text, p_kind text) returns void language plpgsql security definer set search_path=public as $$
begin
  if b.conversation_id is not null then
    insert into messages(org_id,conversation_id,role,body) values(b.org_id,b.conversation_id,'staff',p_body);
  end if;
  if coalesce(b.phone,'')<>'' then
    insert into outbox(org_id,channel,to_addr,body,kind,booking_id) values(b.org_id,'sms',b.phone,p_body,p_kind,b.id);
  end if;
end $$;
create or replace function booking_label(b bookings) returns text language sql stable as
$$ select coalesce(nullif(b.service,''),'appointment')||coalesce(' with '||nullif(b.doctor,''),'')||' on '||to_char(b.starts_at,'Dy, Mon FMDD "at" FMHH12:MI AM') $$;
create or replace function booking_audit(b bookings, p_action text, p_text text) returns void language sql security definer set search_path=public as
$$ select write_audit(b.org_id,p_action,'booking',b.id,jsonb_build_object('text',left(p_text,500))) $$;
revoke all on function booking_notify(bookings,text,text), booking_label(bookings), booking_audit(bookings,text,text) from public, anon, authenticated;

-- Locks the appointment and checks the caller is staff of its clinic. "Not found" for anyone else, so ids leak nothing.
create or replace function booking_for_staff(p_id uuid) returns bookings language plpgsql security definer set search_path=public as $$
declare b bookings;
begin
  select * into b from bookings where id=p_id for update;
  if not found or not is_staff(b.org_id) then raise exception 'Appointment not found.' using errcode='P0002'; end if;
  return b;
end $$;
revoke all on function booking_for_staff(uuid) from public, anon, authenticated;

-- 4. Staff actions.
create or replace function booking_create(p_org uuid, p_name text, p_phone text, p_service text, p_when timestamp, p_doctor uuid, p_notify boolean default true)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b bookings; d doctors;
begin
  if not is_staff(p_org) then raise exception 'You do not have permission for this clinic.' using errcode='42501'; end if;
  if btrim(coalesce(p_name,''))='' or btrim(coalesce(p_phone,''))='' then raise exception 'Name and phone are required.' using errcode='P0001'; end if;
  select * into d from doctors where id=p_doctor and org_id=p_org;
  if not found then raise exception 'Pick a doctor.' using errcode='P0001'; end if;
  if coalesce(p_service,'')<>'' and not (p_service = any(d.services)) then raise exception '% does not offer %.', d.name, p_service using errcode='P0001'; end if;
  begin
    insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status,source)
      values(p_org,left(btrim(p_name),120),left(btrim(p_phone),40),coalesce(p_service,''),p_when,d.id,d.name,'booked','staff') returning * into b;
  exception when unique_violation or exclusion_violation then
    raise exception 'That time was just taken. Pick another slot.' using errcode='23505';
  end;
  perform booking_audit(b,'booking',b.name||' with '||b.doctor||' at '||to_char(b.starts_at,'YYYY-MM-DD HH24:MI'));
  if p_notify and b.starts_at>clinic_now(p_org) then perform booking_notify(b,'You are booked: '||booking_label(b)||'. Reply or call us to change it.','confirmation'); end if;
  return jsonb_build_object('ok',true,'id',b.id,'doctor',b.doctor);
end $$;

-- Confirm or decline a website request. Only the first decision counts; a second caller is told it was already handled.
create or replace function booking_decide(p_id uuid, p_confirm boolean) returns jsonb language plpgsql security definer set search_path=public as $$
declare b bookings := booking_for_staff(p_id);
begin
  if b.status<>'requested' then return jsonb_build_object('ok',false,'status',b.status); end if;
  if p_confirm and b.starts_at<clinic_now(b.org_id) then raise exception 'That time has passed. Decline it, or move it to a new time.' using errcode='P0001'; end if;
  update bookings set status=case when p_confirm then 'booked' else 'cancelled' end where id=p_id returning * into b;
  perform booking_audit(b,case when p_confirm then 'booking.confirmed' else 'booking.declined' end,
    b.name||' with '||coalesce(nullif(b.doctor,''),'unassigned')||' at '||to_char(b.starts_at,'YYYY-MM-DD HH24:MI'));
  perform booking_notify(b,case when p_confirm then 'Good news: your '||booking_label(b)||' is confirmed. See you then!'
    else 'Sorry, we can''t offer '||to_char(b.starts_at,'Dy, Mon FMDD "at" FMHH12:MI AM')||'. Please choose another time, or reply and we''ll help.' end,
    case when p_confirm then 'confirmation' else 'decline' end);
  return jsonb_build_object('ok',true,'status',b.status);
end $$;

-- Move an appointment to another open slot (and optionally another doctor). Staff moving it confirms it.
create or replace function booking_reschedule(p_id uuid, p_when timestamp, p_doctor uuid default null) returns jsonb language plpgsql security definer set search_path=public as $$
declare b bookings := booking_for_staff(p_id); was timestamp := b.starts_at; did uuid := coalesce(p_doctor,b.doctor_id); d doctors;
begin
  if b.status not in ('requested','booked') then raise exception 'Only an upcoming appointment can be moved.' using errcode='P0001'; end if;
  select * into d from doctors where id=did and org_id=b.org_id;
  if not found then raise exception 'Pick a doctor.' using errcode='P0001'; end if;
  if p_when=b.starts_at and did is not distinct from b.doctor_id then raise exception 'It is already at that time.' using errcode='P0001'; end if;
  if coalesce(b.service,'')<>'' and not (b.service = any(d.services)) then raise exception '% does not offer %.', d.name, b.service using errcode='P0001'; end if;
  begin
    update bookings set starts_at=p_when, doctor_id=did, status='booked', reminded=false where id=p_id returning * into b;
  exception when unique_violation or exclusion_violation then
    raise exception 'That time was just taken. Pick another slot.' using errcode='23505';
  end;
  perform booking_audit(b,'booking.rescheduled',b.name||': '||to_char(was,'YYYY-MM-DD HH24:MI')||' → '||to_char(b.starts_at,'YYYY-MM-DD HH24:MI')||' with '||b.doctor);
  if b.starts_at>clinic_now(b.org_id) then perform booking_notify(b,'Your appointment has moved: '||booking_label(b)||'. Reply or call us if that does not work.','reschedule'); end if;
  return jsonb_build_object('ok',true,'doctor',b.doctor);
end $$;

create or replace function booking_cancel(p_id uuid, p_notify boolean default true) returns jsonb language plpgsql security definer set search_path=public as $$
declare b bookings := booking_for_staff(p_id);
begin
  if b.status not in ('requested','booked') then return jsonb_build_object('ok',false,'status',b.status); end if;
  update bookings set status='cancelled' where id=p_id returning * into b;
  perform booking_audit(b,'cancellation',b.name||' at '||to_char(b.starts_at,'YYYY-MM-DD HH24:MI'));
  if p_notify and b.starts_at>clinic_now(b.org_id) then perform booking_notify(b,'Your '||booking_label(b)||' has been cancelled. Reply or call us to book another time.','cancellation'); end if;
  return jsonb_build_object('ok',true,'status',b.status);
end $$;

-- After the visit: completed or no-show (and back to booked to undo a mis-click). Never before the appointment time.
create or replace function booking_set_status(p_id uuid, p_status text) returns jsonb language plpgsql security definer set search_path=public as $$
declare b bookings := booking_for_staff(p_id);
begin
  if p_status in ('completed','no_show') then
    if b.status not in ('booked','completed','no_show') then raise exception 'Only a confirmed appointment can be marked.' using errcode='P0001'; end if;
    if b.starts_at>clinic_now(b.org_id) then raise exception 'That appointment has not happened yet.' using errcode='P0001'; end if;
  elsif p_status='booked' then
    if b.status not in ('completed','no_show') then raise exception 'Nothing to undo.' using errcode='P0001'; end if;
  else raise exception 'Unknown status.' using errcode='22023'; end if;
  if b.status=p_status then return jsonb_build_object('ok',true,'status',b.status); end if;
  update bookings set status=p_status where id=p_id returning * into b;
  perform booking_audit(b,case p_status when 'booked' then 'booking.reopened' else 'booking.'||p_status end,b.name||' at '||to_char(b.starts_at,'YYYY-MM-DD HH24:MI'));
  return jsonb_build_object('ok',true,'status',b.status);
end $$;

revoke all on function booking_create(uuid,text,text,text,timestamp,uuid,boolean), booking_decide(uuid,boolean), booking_reschedule(uuid,timestamp,uuid),
  booking_cancel(uuid,boolean), booking_set_status(uuid,text) from public, anon;
grant execute on function booking_create(uuid,text,text,text,timestamp,uuid,boolean), booking_decide(uuid,boolean), booking_reschedule(uuid,timestamp,uuid),
  booking_cancel(uuid,boolean), booking_set_status(uuid,text) to authenticated;
