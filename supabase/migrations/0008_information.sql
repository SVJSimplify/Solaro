-- Phase 1: Information (business memory). Additive and non-destructive.
-- Existing kb, doctors and closures rows are COPIED into the new structure; the originals stay in place and the booking engine keeps reading them.
-- No patient names, phone numbers or medical data are stored here. Bookings are referenced by id only.

create extension if not exists btree_gist;

-- Entities: doctors, staff, services, locations. Duplicate detection is enforced per organisation and kind.
create table business_entities(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  kind text not null check (kind in ('doctor','staff','service','location','other')),
  name text not null check (length(btrim(name)) between 1 and 120),
  normalized_name text not null check (length(normalized_name) between 1 and 120),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object' and pg_column_size(details) <= 4000),
  status text not null default 'active' check (status in ('active','inactive')),
  legacy_doctor_id uuid unique references doctors(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create unique index business_entities_active_name on business_entities(org_id, kind, normalized_name) where status='active';
create index business_entities_org on business_entities(org_id);

-- Relationships between entities, e.g. a doctor who covers a service or a staff member who works with a doctor.
create table entity_relationships(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  from_entity_id uuid not null references business_entities on delete cascade,
  to_entity_id uuid not null references business_entities on delete cascade,
  relation text not null check (relation in ('covers','works_with','reports_to','offers')),
  status text not null default 'confirmed' check (status in ('confirmed','tentative','pending_approval','rejected','superseded','expired')),
  created_at timestamptz not null default now(),
  check (from_entity_id <> to_entity_id));

-- Facts: profile, hours, services, procedures, policies, FAQs, staff notes and temporary events.
-- Current facts are unique per organisation, entity, category and key. Corrections supersede the old row; history is kept.
create table business_facts(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  entity_id uuid references business_entities on delete cascade,
  category text not null check (category in ('profile','hours','service','procedure','policy','faq','staff','event','other')),
  key text not null check (length(btrim(key)) between 1 and 200),
  value text not null check (length(btrim(value)) between 1 and 5000),
  status text not null check (status in ('confirmed','tentative','pending_approval','rejected','superseded','expired')),
  source text not null check (source in ('manual','import','conversation','legacy_kb','system')),
  source_reference text not null default '' check (length(source_reference) <= 200),
  confidence numeric(3,2) not null default 1 check (confidence between 0 and 1),
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  created_by uuid references auth.users on delete set null,
  approved_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  supersedes_id uuid references business_facts(id) on delete set null,
  check (effective_until is null or effective_until > effective_from));
create unique index business_facts_current on business_facts(org_id, coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid), category, key)
  where status in ('confirmed','tentative','pending_approval');
create index business_facts_lookup on business_facts(org_id, category, key);

-- Recurring weekly hours. Weekday uses JavaScript numbering (0 = Sunday), matching the booking engine. Times are minutes from midnight.
create table schedule_rules(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  entity_id uuid not null references business_entities on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_min int not null check (start_min between 0 and 1439),
  end_min int not null check (end_min between 1 and 1440),
  slot_minutes int not null default 30 check (slot_minutes between 5 and 240),
  status text not null default 'confirmed' check (status in ('confirmed','tentative','pending_approval','rejected','superseded','expired')),
  source text not null check (source in ('manual','import','conversation','legacy_doctors','system')),
  source_reference text not null default '' check (length(source_reference) <= 200),
  effective_from date not null default current_date,
  effective_until date,
  created_by uuid references auth.users on delete set null,
  approved_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  supersedes_id uuid references schedule_rules(id) on delete set null,
  check (end_min > start_min),
  check (effective_until is null or effective_until > effective_from));
-- Two live rules for the same doctor, weekday and overlapping times and dates are a contradiction and are rejected.
alter table schedule_rules add constraint schedule_rules_no_overlap exclude using gist (
  entity_id with =, weekday with =, int4range(start_min,end_min,'[)') with &&,
  daterange(effective_from, coalesce(effective_until,'infinity'::date),'[)') with &&)
  where (status in ('confirmed','tentative','pending_approval'));

-- Date-specific exceptions: leave, unavailability, custom hours, and whole-clinic closures (entity_id null).
create table schedule_exceptions(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  entity_id uuid references business_entities on delete cascade,
  on_date date not null,
  kind text not null check (kind in ('leave','unavailable','custom_hours','closure')),
  start_min int check (start_min between 0 and 1439),
  end_min int check (end_min between 1 and 1440),
  status text not null check (status in ('confirmed','tentative','pending_approval','rejected','superseded','expired')),
  note text not null default '' check (length(note) <= 500),
  source text not null check (source in ('manual','import','conversation','legacy_closures','system')),
  source_reference text not null default '' check (length(source_reference) <= 200),
  created_by uuid references auth.users on delete set null,
  approved_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  supersedes_id uuid references schedule_exceptions(id) on delete set null,
  check ((kind='closure') = (entity_id is null)),
  check ((kind='custom_hours') = (start_min is not null and end_min is not null and end_min > start_min)));
create unique index schedule_exceptions_current on schedule_exceptions(org_id, coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid), on_date, kind)
  where status in ('confirmed','tentative','pending_approval');
create index schedule_exceptions_date on schedule_exceptions(org_id, on_date);

-- Append-only audit trail. Written only by database functions.
create table audit_events(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  actor uuid,
  action text not null check (length(action) between 1 and 80),
  target_type text not null check (length(target_type) between 1 and 40),
  target_id uuid,
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 8000),
  created_at timestamptz not null default now());
create index audit_events_org on audit_events(org_id, created_at desc);

-- Keep supersession inside one organisation.
create or replace function check_supersedes_same_org() returns trigger language plpgsql as $$
declare ok boolean;
begin
  if new.supersedes_id is null then return new; end if;
  if tg_table_name='business_facts' then
    select exists(select 1 from business_facts f where f.id=new.supersedes_id and f.org_id=new.org_id) into ok;
  else
    select exists(select 1 from schedule_exceptions f where f.id=new.supersedes_id and f.org_id=new.org_id) into ok;
  end if;
  if not ok then raise exception 'supersedes_id must belong to the same organisation' using errcode='23514'; end if;
  return new;
end $$;
create trigger business_facts_supersedes before insert on business_facts for each row execute function check_supersedes_same_org();
create trigger schedule_exceptions_supersedes before insert on schedule_exceptions for each row execute function check_supersedes_same_org();

-- Only the database writes audit rows. Authenticated users can read their own organisation's trail.
create or replace function write_audit(p_org uuid, p_action text, p_type text, p_target uuid, p_detail jsonb)
returns void language sql security definer set search_path=public as $$
  insert into audit_events(org_id,actor,action,target_type,target_id,detail) values(p_org,auth.uid(),p_action,p_type,p_target,coalesce(p_detail,'{}'::jsonb));
$$;
revoke all on function write_audit(uuid,text,text,uuid,jsonb) from public,anon,authenticated;

-- Row level security. Members read their organisation. Owners and admins write. Staff may only add tentative items, and only as themselves.
alter table business_entities enable row level security;
alter table entity_relationships enable row level security;
alter table business_facts enable row level security;
alter table schedule_rules enable row level security;
alter table schedule_exceptions enable row level security;
alter table audit_events enable row level security;

create policy entities_read on business_entities for select to authenticated using (is_member(org_id));
create policy entities_manage on business_entities for all to authenticated using (can_manage(org_id)) with check (can_manage(org_id));
create policy relationships_read on entity_relationships for select to authenticated using (is_member(org_id));
create policy relationships_manage on entity_relationships for all to authenticated using (can_manage(org_id)) with check (can_manage(org_id));
create policy rules_read on schedule_rules for select to authenticated using (is_member(org_id));
create policy rules_manage on schedule_rules for all to authenticated using (can_manage(org_id)) with check (can_manage(org_id));
create policy audit_read on audit_events for select to authenticated using (is_member(org_id));

create policy facts_read on business_facts for select to authenticated using (is_member(org_id));
create policy facts_manager_insert on business_facts for insert to authenticated with check (can_manage(org_id));
create policy facts_member_tentative on business_facts for insert to authenticated
  with check (is_member(org_id) and status='tentative' and created_by=auth.uid());
create policy exc_read on schedule_exceptions for select to authenticated using (is_member(org_id));
create policy exc_manager_insert on schedule_exceptions for insert to authenticated with check (can_manage(org_id));
create policy exc_member_tentative on schedule_exceptions for insert to authenticated
  with check (is_member(org_id) and status='tentative' and created_by=auth.uid());

-- Facts and exceptions cannot be edited or deleted directly. Corrections go through the functions below, so history is kept.
revoke update, delete on business_facts, schedule_exceptions, audit_events from anon, authenticated;

-- Corrections. Confirming needs an owner or admin. Tentative items may be added by any member.
create or replace function supersede_fact(p_old uuid, p_value text, p_status text default 'confirmed',
  p_source text default 'manual', p_source_ref text default '')
returns uuid language plpgsql security definer set search_path=public as $$
declare r business_facts; nid uuid;
begin
  select * into r from business_facts where id=p_old for update;
  if not found then raise exception 'Information item not found' using errcode='P0002'; end if;
  if not is_member(r.org_id) then raise exception 'Not a member of this organisation' using errcode='42501'; end if;
  if p_status<>'tentative' and not can_manage(r.org_id) then raise exception 'Only owners and admins can confirm information' using errcode='42501'; end if;
  if r.status not in ('confirmed','tentative','pending_approval') then raise exception 'That item is already % and cannot be corrected', r.status using errcode='P0001'; end if;
  update business_facts set status='superseded', updated_at=now() where id=p_old;
  insert into business_facts(org_id,entity_id,category,key,value,status,source,source_reference,confidence,effective_from,effective_until,created_by,supersedes_id)
    values(r.org_id,r.entity_id,r.category,r.key,p_value,p_status,p_source,p_source_ref,r.confidence,r.effective_from,r.effective_until,auth.uid(),p_old)
    returning id into nid;
  perform write_audit(r.org_id,'fact.superseded','business_fact',nid,jsonb_build_object('replaces',p_old,'status',p_status,'source',p_source));
  return nid;
end $$;

create or replace function supersede_exception(p_old uuid, p_status text, p_note text default null,
  p_source text default 'manual', p_source_ref text default '')
returns uuid language plpgsql security definer set search_path=public as $$
declare r schedule_exceptions; nid uuid;
begin
  select * into r from schedule_exceptions where id=p_old for update;
  if not found then raise exception 'Exception not found' using errcode='P0002'; end if;
  if not is_member(r.org_id) then raise exception 'Not a member of this organisation' using errcode='42501'; end if;
  if p_status<>'tentative' and not can_manage(r.org_id) then raise exception 'Only owners and admins can confirm changes' using errcode='42501'; end if;
  if r.status not in ('confirmed','tentative','pending_approval') then raise exception 'That exception is already % and cannot be corrected', r.status using errcode='P0001'; end if;
  update schedule_exceptions set status='superseded', updated_at=now() where id=p_old;
  insert into schedule_exceptions(org_id,entity_id,on_date,kind,start_min,end_min,status,note,source,source_reference,created_by,supersedes_id)
    values(r.org_id,r.entity_id,r.on_date,r.kind,r.start_min,r.end_min,p_status,coalesce(p_note,r.note),p_source,p_source_ref,auth.uid(),p_old)
    returning id into nid;
  perform write_audit(r.org_id,'exception.superseded','schedule_exception',nid,jsonb_build_object('replaces',p_old,'status',p_status));
  return nid;
end $$;

-- Expiry for temporary information. Confirmed history is kept. Run from a scheduled job with the service role.
create or replace function expire_information() returns jsonb
language plpgsql security definer set search_path=public as $$
declare nf int; ne int;
begin
  update business_facts set status='expired', updated_at=now()
    where status in ('tentative','pending_approval','confirmed') and effective_until is not null and effective_until <= now();
  get diagnostics nf = row_count;
  update schedule_exceptions set status='expired', updated_at=now()
    where status in ('tentative','pending_approval') and on_date < current_date;
  get diagnostics ne = row_count;
  return jsonb_build_object('facts_expired',nf,'exceptions_expired',ne);
end $$;
revoke all on function expire_information() from public,anon,authenticated;
grant execute on function expire_information() to service_role;
revoke all on function supersede_fact(uuid,text,text,text,text) from public,anon;
revoke all on function supersede_exception(uuid,text,text,text,text) from public,anon;
grant execute on function supersede_fact(uuid,text,text,text,text) to authenticated;
grant execute on function supersede_exception(uuid,text,text,text,text) to authenticated;

-- Read views. Confirmed unavailability is separate from tentative, so tentative leave never looks confirmed.
create view current_unavailability with (security_invoker=true) as
  select id, org_id, entity_id, on_date, kind, note from schedule_exceptions
  where status='confirmed' and kind in ('leave','unavailable','closure');
create view tentative_unavailability with (security_invoker=true) as
  select id, org_id, entity_id, on_date, kind, note from schedule_exceptions
  where status='tentative' and kind in ('leave','unavailable','closure');

-- Backfill from the existing tables. Idempotent: re-running adds nothing. Stops with an error on data it cannot map safely.
do $$
declare dup record;
begin
  -- Doctors whose names collide after normalisation cannot be mapped safely. Stop and report.
  select org_id, lower(regexp_replace(btrim(name),'\s+',' ','g')) as n, count(*) into dup
    from doctors group by 1,2 having count(*)>1 limit 1;
  if found then raise exception 'Duplicate doctor name % in one organisation: resolve before migrating', dup.n; end if;
end $$;

insert into business_entities(org_id,kind,name,normalized_name,details,legacy_doctor_id)
select d.org_id,'doctor',btrim(d.name),lower(regexp_replace(btrim(d.name),'\s+',' ','g')),
  jsonb_build_object('specialty',d.specialty,'services',to_jsonb(d.services)),d.id
from doctors d
where not exists (select 1 from business_entities e where e.legacy_doctor_id=d.id);

insert into schedule_rules(org_id,entity_id,weekday,start_min,end_min,slot_minutes,status,source,source_reference,effective_from)
select e.org_id, e.id, wd.day::smallint,
  split_part(d.start_time,':',1)::int*60+split_part(d.start_time,':',2)::int,
  split_part(d.end_time,':',1)::int*60+split_part(d.end_time,':',2)::int,
  d.slot,'confirmed','legacy_doctors','doctor:'||d.id::text, current_date
from doctors d
join business_entities e on e.legacy_doctor_id=d.id
cross join lateral unnest(d.days) as wd(day)
where d.start_time ~ '^\d{1,2}:\d{2}$' and d.end_time ~ '^\d{1,2}:\d{2}$' and wd.day between 0 and 6
  and not exists (select 1 from schedule_rules r where r.source_reference='doctor:'||d.id::text and r.weekday=wd.day);

insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,source_reference,created_at)
select c.org_id,null,c.date::date,'closure','confirmed','Clinic closed (imported)','legacy_closures','closure:'||c.id::text,c.created_at
from closures c
where c.date ~ '^\d{4}-\d{2}-\d{2}$'
  and not exists (select 1 from schedule_exceptions x where x.source_reference='closure:'||c.id::text);

insert into business_facts(org_id,entity_id,category,key,value,status,source,source_reference,effective_from,created_at)
select k.org_id,null,'faq',
  case when row_number() over (partition by k.org_id, lower(btrim(k.title)) order by k.created_at, k.id) = 1
       then btrim(k.title) else btrim(k.title)||' ('||row_number() over (partition by k.org_id, lower(btrim(k.title)) order by k.created_at, k.id)||')' end,
  k.body,'confirmed','legacy_kb','kb:'||k.id::text,k.created_at,k.created_at
from kb k
where not exists (select 1 from business_facts f where f.source_reference='kb:'||k.id::text);
