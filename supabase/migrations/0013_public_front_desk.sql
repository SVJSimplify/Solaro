-- Phase 4: the public website front desk runs through the central tool registry.
-- Website visitors have no account, so their tool calls run as a "public" principal bound to one chat and one clinic.
-- Website bookings are requests that staff confirm, unless the clinic turns on auto-confirm.

-- Bookings remember where they came from and which chat asked, so a confirmation can be sent back to that chat.
alter table bookings add column if not exists conversation_id uuid references conversations(id) on delete set null;
alter table bookings add column if not exists source text not null default 'staff';
do $$ begin
  alter table bookings add constraint bookings_source_check check (source in ('staff','assistant','website')) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table bookings add constraint bookings_status_check check (status in ('requested','booked','cancelled')) not valid;  -- not valid: existing rows are left alone
exception when duplicate_object then null; end $$;
create index if not exists bookings_requested_idx on bookings(org_id,starts_at) where status='requested';

-- Clinic choice: website bookings wait for staff (default) or are confirmed straight away.
alter table settings add column if not exists auto_confirm_web boolean not null default false;

-- Idempotency records for public tool calls have no signed-in actor. Only the server (service role) can write those:
-- the existing policies still require actor = auth.uid() for signed-in users.
alter table tool_executions alter column actor drop not null;
alter table tool_executions add column if not exists principal text not null default 'user';
do $$ begin
  alter table tool_executions add constraint tool_exec_principal_check check (principal in ('user','public') and (actor is not null or principal='public'));
exception when duplicate_object then null; end $$;
