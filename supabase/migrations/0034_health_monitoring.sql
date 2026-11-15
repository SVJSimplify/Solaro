-- 0034 Health monitoring: checks every 5 minutes, platform alerts that open and resolve themselves, and a public
-- health summary (no details) for an external uptime monitor.

-- Failures the Edge Functions report (AI provider errors, SMS send errors). No patient data: kind + short reason only.
create table if not exists ops_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null,                  -- e.g. ai_failed, ai_rate_limited
  org_id uuid,
  detail text not null default ''
);
create index if not exists ops_events_recent on ops_events(kind, created_at desc);
alter table ops_events enable row level security;
revoke all on ops_events from anon, authenticated;

create table if not exists system_alerts (
  id bigint generated always as identity primary key,
  key text not null,                   -- one open alert per key
  severity text not null check (severity in ('critical','warning')),
  title text not null,
  detail text not null default '',
  opened_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text                     -- 'auto' or the admin's email
);
create unique index if not exists system_alerts_one_open on system_alerts(key) where resolved_at is null;
alter table system_alerts enable row level security;
revoke all on system_alerts from anon, authenticated;

-- All checks, with the reason each one is not ok. Thresholds are deliberately simple and explained in the text.
create or replace function system_health() returns jsonb
language plpgsql stable security definer set search_path=public, cron as $$
declare checks jsonb := '[]'; j record; last_ok timestamptz; n int; m int; size_mb numeric;
begin
  -- Scheduled jobs: each must have succeeded recently, and none failed in the last hour.
  for j in select * from (values ('solara-reminders','Appointment reminders',15),('solara-autopilot','Autopilot',15),
                                 ('solara-expire-info','Expiring information',130),('solara-prune','Nightly clean-up',1560)) v(job,label,mins) loop
    select max(d.end_time) into last_ok from cron.job_run_details d join cron.job c on c.jobid=d.jobid
      where c.jobname=j.job and d.status='succeeded';
    select count(*) into n from cron.job_run_details d join cron.job c on c.jobid=d.jobid
      where c.jobname=j.job and d.status='failed' and d.start_time>now()-interval '1 hour';
    checks := checks || jsonb_build_object('key','job:'||j.job,'label',j.label,
      'ok', last_ok is not null and last_ok>now()-make_interval(mins=>j.mins) and n=0,
      'severity','critical',
      'detail', case when last_ok is null then 'Has never run successfully.'
                     when n>0 then n||' failed run(s) in the last hour.'
                     when last_ok<=now()-make_interval(mins=>j.mins) then 'Last success '||to_char(last_ok at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC.'
                     else 'Last success '||to_char(last_ok at time zone 'UTC','HH24:MI')||' UTC.' end);
  end loop;

  -- Outgoing messages: nothing stuck in the queue, few failures.
  select count(*) into n from outbox where status='queued' and created_at<now()-interval '15 minutes';
  select count(*) into m from outbox where status='failed' and created_at>now()-interval '24 hours';
  checks := checks || jsonb_build_object('key','outbox','label','Outgoing messages','ok',n=0 and m<5,'severity','warning',
    'detail', case when n>0 then n||' message(s) waiting more than 15 minutes.' when m>=5 then m||' failed in the last 24 hours.' else 'Queue is moving.' end);

  -- AI provider: repeated failures in the last 15 minutes.
  select count(*) filter (where kind='ai_failed'), count(*) filter (where kind='ai_rate_limited') into n, m
    from ops_events where created_at>now()-interval '15 minutes';
  checks := checks || jsonb_build_object('key','ai','label','AI provider','ok',n+m<3,'severity','critical',
    'detail', case when n+m>=3 then (n+m)||' failed AI replies in 15 minutes'||case when m>0 then ' ('||m||' rate-limited)' else '' end||'.' else 'Answering normally.' end);

  -- Database size against the Free plan's 500 MB.
  size_mb := round(pg_database_size(current_database())/1048576.0,1);
  checks := checks || jsonb_build_object('key','db_size','label','Database size','ok',size_mb<400,'severity','warning',
    'detail', size_mb||' MB used'||case when size_mb>=400 then ' (Free plan limit is 500 MB).' else '.' end);

  return jsonb_build_object('checked_at',now(),
    'status', case when exists(select 1 from jsonb_array_elements(checks) c where not (c->>'ok')::bool and c->>'severity'='critical') then 'down'
                   when exists(select 1 from jsonb_array_elements(checks) c where not (c->>'ok')::bool) then 'degraded' else 'ok' end,
    'checks', checks);
end $$;
revoke execute on function system_health() from public, anon, authenticated;

-- Runs every 5 minutes: opens an alert when a check fails, resolves it when the check passes again.
create or replace function run_health_checks() returns jsonb
language plpgsql security definer set search_path=public as $$
declare h jsonb := system_health(); c jsonb;
begin
  for c in select * from jsonb_array_elements(h->'checks') loop
    if (c->>'ok')::bool then
      update system_alerts set resolved_at=now(), resolved_by='auto' where key=c->>'key' and resolved_at is null;
    else
      insert into system_alerts(key,severity,title,detail) values (c->>'key',c->>'severity',c->>'label',c->>'detail')
        on conflict (key) where resolved_at is null do update set last_seen=now(), detail=excluded.detail;
    end if;
  end loop;
  delete from ops_events where created_at<now()-interval '7 days';
  delete from system_alerts where resolved_at<now()-interval '90 days';
  return h;
end $$;
revoke execute on function run_health_checks() from public, anon, authenticated;

select cron.unschedule('solara-health') where exists(select 1 from cron.job where jobname='solara-health');
select cron.schedule('solara-health','*/5 * * * *','select public.run_health_checks()');

-- Public summary for uptime monitors: status only, never details.
create or replace function health_public() returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('status', h->>'status', 'checked_at', h->'checked_at',
    'checks', (select jsonb_object_agg(c->>'key', (c->>'ok')::bool) from jsonb_array_elements(h->'checks') c))
  from (select system_health() h) x $$;
revoke execute on function health_public() from public, anon, authenticated;

-- Admin: live checks, open alerts, recent history.
create or replace function admin_health() returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  return system_health() || jsonb_build_object(
    'open', coalesce((select jsonb_agg(to_jsonb(a) order by a.severity, a.opened_at desc) from system_alerts a where resolved_at is null),'[]'),
    'recent', coalesce((select jsonb_agg(to_jsonb(a) order by a.opened_at desc) from (select * from system_alerts where resolved_at is not null order by opened_at desc limit 20) a),'[]'));
end $$;

create or replace function admin_resolve_alert(p_id bigint) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  update system_alerts set resolved_at=now(), resolved_by=(select email from auth.users where id=auth.uid()) where id=p_id and resolved_at is null;
  if not found then raise exception 'Alert not found or already resolved.' using errcode='PT404'; end if;
end $$;
revoke execute on function admin_health(), admin_resolve_alert(bigint) from public, anon;
grant execute on function admin_health(), admin_resolve_alert(bigint) to authenticated;
