-- 0033 Data safety: every deleted clinic record is kept for 30 days and can be restored by a platform admin;
-- owners can export all of their clinic's data.

-- ── Trash ────────────────────────────────────────────────────────────────────
create table if not exists deleted_records (
  id uuid primary key default gen_random_uuid(),
  batch bigint not null default txid_current(),   -- everything removed by one action (a cascade shares one batch)
  org_id uuid,
  table_name text not null,
  row_id text,
  data jsonb not null,
  deleted_by uuid default auth.uid(),
  deleted_at timestamptz not null default now()
);
create index if not exists deleted_records_batch on deleted_records(batch);
create index if not exists deleted_records_org on deleted_records(org_id, deleted_at desc);
create index if not exists deleted_records_age on deleted_records(deleted_at);
alter table deleted_records enable row level security;   -- no policies: reached only through the admin functions below
revoke all on deleted_records from anon, authenticated;

create or replace function capture_delete() returns trigger
language plpgsql security definer set search_path=public as $$
declare j jsonb := to_jsonb(old);
begin
  insert into deleted_records(org_id, table_name, row_id, data)
  values (case when tg_table_name='organizations' then (j->>'id')::uuid else (j->>'org_id')::uuid end, tg_table_name, j->>'id', j);
  return old;
end $$;
revoke execute on function capture_delete() from public, anon, authenticated;

-- Restore order: parents before children.
create or replace function trash_tables() returns text[] language sql immutable as $$
  select array['organizations','settings','members','doctors','services','kb','closures','schedule_rules','schedule_exceptions',
               'business_entities','entity_relationships','business_facts','conversations','bookings','messages','alerts'] $$;

do $$ declare t text; begin
  foreach t in array trash_tables() loop
    execute format('drop trigger if exists keep_deleted on public.%I', t);
    execute format('create trigger keep_deleted after delete on public.%I for each row execute function capture_delete()', t);
  end loop;
end $$;

-- What was deleted recently, one row per action.
create or replace function admin_trash(p_days int default 30) returns table(batch bigint, org_id uuid, clinic text, deleted_at timestamptz,
  deleted_by text, summary jsonb, rows int)
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  return query
    select d.batch, min(d.org_id::text)::uuid, coalesce(min(o.name), min(d.data->>'name') filter (where d.table_name='organizations'), 'Deleted clinic'),
      min(d.deleted_at), (select u.email::text from auth.users u where u.id=min(d.deleted_by::text)::uuid),
      (select jsonb_object_agg(x.table_name, x.n) from (select d2.table_name, count(*) n from deleted_records d2 where d2.batch=d.batch group by 1) x),
      count(*)::int
    from deleted_records d left join organizations o on o.id=d.org_id
    where d.deleted_at > now()-make_interval(days=>least(greatest(p_days,1),30))
    group by d.batch order by min(d.deleted_at) desc limit 200;
end $$;

-- Put back everything one action deleted, parents first. Custom triggers are paused while the rows go back (they would
-- re-validate old bookings as "in the past" or re-run sync side effects that the trash already holds); foreign-key checks
-- stay on. Any failure rolls the whole restore back.
create or replace function admin_restore_batch(p_batch bigint) returns jsonb
language plpgsql security definer set search_path=public as $$
declare t text; n int; out jsonb := '{}'; total int := 0; orgs uuid[];
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  select array_agg(distinct org_id) into orgs from deleted_records where batch=p_batch;
  if orgs is null then raise exception 'Nothing to restore.' using errcode='PT404'; end if;
  foreach t in array trash_tables() loop execute format('alter table public.%I disable trigger user', t); end loop;
  foreach t in array trash_tables() loop
    execute format('insert into public.%1$I select (jsonb_populate_record(null::public.%1$I, d.data)).* from deleted_records d where d.batch=$1 and d.table_name=%2$L', t, t)
      using p_batch;
    get diagnostics n = row_count;
    if n>0 then out := out || jsonb_build_object(t,n); total := total+n; end if;
  end loop;
  foreach t in array trash_tables() loop execute format('alter table public.%I enable trigger user', t); end loop;
  delete from deleted_records where batch=p_batch;
  update organizations set info_changed_at=now() where id = any(orgs);
  perform write_audit(o, 'admin.restore', 'app', null, jsonb_build_object('text','Restored '||total||' deleted records'))
    from unnest(orgs) o where exists(select 1 from organizations where id=o);
  return out;
exception when unique_violation then
  raise exception 'Some of these records already exist again, so nothing was restored.' using errcode='23505';
when foreign_key_violation then
  raise exception 'This depends on something else that was deleted. Restore the earlier deletion first.' using errcode='23503';
end $$;

revoke execute on function admin_trash(int), admin_restore_batch(bigint) from public, anon;
grant execute on function admin_trash(int), admin_restore_batch(bigint) to authenticated;

-- 30 days, then gone for good.
create or replace function prune_operational_data() returns jsonb
language plpgsql security definer set search_path=public as $$
declare a int; b int; c int; d int; e int;
begin
  delete from rate_limits where window_start < now()-interval '1 day'; get diagnostics a = row_count;
  delete from patient_verifications where created_at < now()-interval '2 days'; get diagnostics b = row_count;
  delete from action_confirmations where expires_at < now()-interval '2 days'; get diagnostics c = row_count;
  delete from tool_executions where status='succeeded' and updated_at < now()-interval '30 days'; get diagnostics d = row_count;
  delete from deleted_records where deleted_at < now()-interval '30 days'; get diagnostics e = row_count;
  return jsonb_build_object('rate_limits',a,'patient_verifications',b,'action_confirmations',c,'tool_executions',d,'deleted_records',e);
end $$;

-- ── Owner export ─────────────────────────────────────────────────────────────
-- Everything that belongs to the clinic, as JSON. Secrets (AI key, widget sessions) are not included.
create or replace function export_clinic(p_org uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare t text; out jsonb := '{}'; rows jsonb;
begin
  if my_role(p_org) is distinct from 'owner' then raise exception 'Only the clinic owner can export its data.' using errcode='42501'; end if;
  perform throttle('export:'||p_org, 10, 3600);
  foreach t in array array['settings','doctors','services','kb','closures','schedule_rules','schedule_exceptions','business_entities',
                           'entity_relationships','business_facts','bookings','conversations','messages','alerts','audit_events'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)),''[]'') from public.%I x where x.org_id=$1', t) into rows using p_org;
    out := out || jsonb_build_object(t, rows);
  end loop;
  perform write_audit(p_org,'export','app',null,jsonb_build_object('text','Clinic data exported'));
  return jsonb_build_object('format','solara-export-v1','exported_at',now(),
    'clinic',(select jsonb_build_object('id',id,'name',name,'timezone',timezone,'plan',plan,'created_at',created_at) from organizations where id=p_org),
    'tables',out);
end $$;
revoke execute on function export_clinic(uuid) from public, anon;
grant execute on function export_clinic(uuid) to authenticated;
