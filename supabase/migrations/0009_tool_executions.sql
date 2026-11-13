-- Phase 2: tool reliability. Idempotency records for write tools, and the database functions write tools call.
-- Every write checks the actor's role inside the database as well as in the application, so a bug in one layer cannot bypass the other.

create table tool_executions(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  tool_name text not null check (length(tool_name) between 1 and 80),
  tool_version int not null check (tool_version >= 1),
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  input_hash text not null check (length(input_hash) = 64),
  actor uuid not null references auth.users on delete cascade,
  status text not null check (status in ('started','interrupted','succeeded','failed')),
  result jsonb,
  error_code text,
  attempts int not null default 1 check (attempts >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, tool_name, idempotency_key));

alter table tool_executions enable row level security;
create policy tool_exec_read on tool_executions for select to authenticated using (is_member(org_id));
create policy tool_exec_insert on tool_executions for insert to authenticated
  with check (actor = auth.uid() and is_member(org_id));
create policy tool_exec_update on tool_executions for update to authenticated
  using (actor = auth.uid() and is_member(org_id)) with check (actor = auth.uid() and is_member(org_id));
revoke delete on tool_executions from anon, authenticated;

-- Creates a leave or unavailability record for one doctor. Owners and admins may confirm; any member may add a tentative record.
-- Insert and audit happen in one transaction.
create or replace function create_schedule_exception(p_entity uuid, p_on_date date, p_kind text, p_status text,
  p_note text, p_source_ref text)
returns uuid language plpgsql security definer set search_path=public as $$
declare org uuid; nid uuid;
begin
  if p_kind not in ('leave','unavailable') or p_status not in ('tentative','confirmed') then
    raise exception 'Invalid kind or status' using errcode='22023';
  end if;
  if p_on_date < current_date then raise exception 'That date has already passed' using errcode='22023'; end if;
  select e.org_id into org from business_entities e where e.id=p_entity and e.status='active';
  if not found then raise exception 'Doctor not found' using errcode='P0002'; end if;
  if not is_member(org) then raise exception 'Not a member of this organisation' using errcode='42501'; end if;
  if p_status='confirmed' and not can_manage(org) then
    raise exception 'Only owners and admins can confirm' using errcode='42501';
  end if;
  insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,source_reference,created_by)
    values(org,p_entity,p_on_date,p_kind,p_status,left(coalesce(p_note,''),500),'manual',left(coalesce(p_source_ref,''),200),auth.uid())
    returning id into nid;
  perform write_audit(org,'exception.created','schedule_exception',nid,
    jsonb_build_object('status',p_status,'kind',p_kind,'ref',p_source_ref));
  return nid;
end $$;
revoke all on function create_schedule_exception(uuid,date,text,text,text,text) from public, anon;
grant execute on function create_schedule_exception(uuid,date,text,text,text,text) to authenticated;
