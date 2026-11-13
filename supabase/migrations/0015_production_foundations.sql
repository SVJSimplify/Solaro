-- Production foundations: tenant checks that scale, indexes for the hot paths, a shared rate limiter, a read-only widget
-- lookup, and retention for operational tables. No data is changed; access rules stay exactly the same.

-- 1. Tenant checks that scale.
-- is_member(org_id) is a security-definer function, which Postgres cannot inline, so it ran once per row: a clinic's
-- inbox query evaluated it hundreds of thousands of times. my_org_ids() returns the caller's clinics once per query
-- (an InitPlan), and "org_id in (...)" lets the planner use the org_id indexes. The rules themselves do not change.
create or replace function my_org_ids() returns setof uuid
language sql stable security definer set search_path=public as
$$ select org_id from members where user_id=auth.uid() $$;
revoke all on function my_org_ids() from public, anon;
grant execute on function my_org_ids() to authenticated;

-- Customer data stays staff-only (owners, admins, staff; never doctors), exactly as migration 0010 set it.
create or replace function my_staff_org_ids() returns setof uuid
language sql stable security definer set search_path=public as
$$ select org_id from members where user_id=auth.uid() and role in ('owner','admin','staff') $$;
revoke all on function my_staff_org_ids() from public, anon;
grant execute on function my_staff_org_ids() to authenticated;

do $$ declare t text; begin
  foreach t in array array['conversations','messages','bookings','alerts','outbox'] loop
    execute format('drop policy if exists staff_all on %I',t);
    execute format('drop policy if exists tenant_all on %I',t);
    execute format('create policy staff_all on %I for all to authenticated using (org_id in (select my_staff_org_ids())) with check (org_id in (select my_staff_org_ids()))',t);
  end loop;
end $$;
-- Every member (doctors included) reads closures and the audit trail, as before.
drop policy if exists tenant_all on closures;
create policy tenant_all on closures for all to authenticated using (org_id in (select my_org_ids())) with check (org_id in (select my_org_ids()));
drop policy if exists audit_read on audit_events;
create policy audit_read on audit_events for select to authenticated using (org_id in (select my_org_ids()));

-- 2. Indexes for the queries the app and functions run most.
create index if not exists alerts_org_created on alerts(org_id, created_at desc);
create index if not exists outbox_org_created on outbox(org_id, created_at desc);
create index if not exists bookings_org_phone on bookings(org_id, phone, starts_at);
create index if not exists bookings_org_created on bookings(org_id, created_at);
create index if not exists messages_org_convo_created on messages(org_id, conversation_id, created_at);
create index if not exists doctors_org on doctors(org_id);
create index if not exists services_org on services(org_id);
create index if not exists closures_org on closures(org_id);
create index if not exists tool_executions_updated on tool_executions(updated_at);

-- 3. One rate limiter for every entry point. Fixed windows, one atomic upsert per hit, so concurrent requests cannot
-- slip past the limit. Only the server (service role) calls it.
create table if not exists rate_limits(
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start));
alter table rate_limits enable row level security;
revoke all on rate_limits from public, anon, authenticated;

create or replace function hit_rate_limit(p_key text, p_limit int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path=public as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds); n int;
begin
  insert into rate_limits(key,window_start,hits) values(left(p_key,200),w,1)
    on conflict (key,window_start) do update set hits=rate_limits.hits+1 returning hits into n;
  return n<=p_limit;
end $$;
revoke all on function hit_rate_limit(text,int,int) from public, anon, authenticated;
grant execute on function hit_rate_limit(text,int,int) to service_role;

-- 4. The website chat resumes a saved chat with this read-only lookup. Before, it called widget_start again, which
-- created a new empty conversation on every page load and used up the clinic's hourly chat allowance.
create or replace function widget_info(org uuid) returns table(org_name text, greeting text)
language sql stable security definer set search_path=public as $$
  select o.name, coalesce(s.greeting,'Hi! How can I help you today?')
  from organizations o left join settings s on s.org_id=o.id where o.id=org and o.widget_enabled $$;
revoke all on function widget_info(uuid) from public;
grant execute on function widget_info(uuid) to anon, authenticated;

-- 5. Retention for operational records that otherwise grow forever. Clinical and business records are never touched.
create or replace function prune_operational_data() returns jsonb
language plpgsql security definer set search_path=public as $$
declare a int; b int; c int; d int;
begin
  delete from rate_limits where window_start < now()-interval '1 day'; get diagnostics a = row_count;
  delete from patient_verifications where created_at < now()-interval '2 days'; get diagnostics b = row_count;
  delete from action_confirmations where expires_at < now()-interval '2 days'; get diagnostics c = row_count;
  delete from tool_executions where status='succeeded' and updated_at < now()-interval '30 days'; get diagnostics d = row_count;
  return jsonb_build_object('rate_limits',a,'patient_verifications',b,'action_confirmations',c,'tool_executions',d);
end $$;
revoke all on function prune_operational_data() from public, anon, authenticated;
grant execute on function prune_operational_data() to service_role;

-- Run it nightly when pg_cron is available (Supabase: Database → Extensions → pg_cron). Otherwise call it from a scheduler.
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('solara-prune','17 3 * * *','select prune_operational_data()');
  end if;
exception when others then raise notice 'pg_cron schedule skipped: %', sqlerrm; end $$;
