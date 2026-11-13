-- Phase 5: patient self-service (verified by a texted code) and pilot metrics.

-- One-time codes for website visitors. Only the server (service role) reads or writes these; codes are stored hashed.
create table if not exists patient_verifications(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  phone text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now());
alter table patient_verifications enable row level security;   -- no policies: server only
revoke all on patient_verifications from public, anon, authenticated;
create index if not exists patient_verifications_convo on patient_verifications(conversation_id, created_at desc);
create index if not exists patient_verifications_phone on patient_verifications(org_id, phone, created_at desc);

-- When a booking was requested and when staff decided, for "time to confirm".
alter table bookings add column if not exists requested_at timestamptz;
alter table bookings add column if not exists decided_at timestamptz;
create or replace function stamp_booking_request() returns trigger language plpgsql set search_path=public as $$
begin
  if new.status='requested' and (tg_op='INSERT' or old.status is distinct from 'requested' or old.starts_at is distinct from new.starts_at) then
    new.requested_at:=now(); new.decided_at:=null;
  elsif tg_op='UPDATE' and old.status='requested' and new.status<>'requested' then
    new.decided_at:=now();
  end if;
  return new;
end $$;
revoke all on function stamp_booking_request() from public, anon, authenticated;
drop trigger if exists bookings_stamp_request on bookings;
create trigger bookings_stamp_request before insert or update on bookings for each row execute function stamp_booking_request();
