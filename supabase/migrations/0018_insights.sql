-- 0018: Insights computed in the database from every record in the period, in the clinic's own time zone.
-- (The dashboard used to count whatever the browser had loaded, which under-counted busy clinics and used the viewer's clock.)
-- Read-only. Rollback: drop function insights_summary(uuid,int).
create or replace function insights_summary(p_org uuid, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare tz text := clinic_tz(p_org); n int := greatest(1,least(coalesce(p_days,30),366));
  nowl timestamp := (now() at time zone tz)::timestamp; today date := nowl::date; d0 date := today-(n-1);
  t0 timestamptz := d0::timestamp at time zone tz; c record; q record; a record; r jsonb;
begin
  if not is_staff(p_org) then raise exception 'You do not have permission for this clinic.' using errcode='42501'; end if;
  -- Chats started in the period. After hours: weekends, before 8am or from 6pm, clinic time.
  select count(*) chats, count(*) filter (where status='handoff' or alerted) handed,
    count(*) filter (where extract(dow from created_at at time zone tz) in (0,6) or extract(hour from created_at at time zone tz)<8 or extract(hour from created_at at time zone tz)>=18) after
    into c from conversations where org_id=p_org and created_at>=t0;
  -- Website requests made in the period.
  select count(*) total, count(*) filter (where status in ('booked','completed','no_show') and requested_at is not null) confirmed,
    count(*) filter (where status in ('booked','completed','no_show') and requested_at is null) auto,
    count(*) filter (where status='cancelled' and decided_at is not null) declined, count(*) filter (where status='requested') pending,
    percentile_cont(0.5) within group (order by extract(epoch from decided_at-requested_at)/60) filter (where decided_at>=requested_at) med
    into q from bookings where org_id=p_org and source='website' and coalesce(requested_at,created_at)>=t0;
  -- Appointments whose time falls in the period (by appointment date, not by when they were entered).
  select count(*) filter (where status<>'cancelled') scheduled, count(*) filter (where status='completed') completed, count(*) filter (where status='no_show') no_show,
    count(*) filter (where status='cancelled') cancelled, count(*) filter (where status='booked' and starts_at<nowl) unmarked
    into a from bookings where org_id=p_org and starts_at>=d0 and starts_at<today+1;
  r := jsonb_build_object('days',n,'from',d0,'to',today,
    'chats',c.chats,'handedOff',c.handed,'handledBySolara',c.chats-c.handed,'automationRate',case when c.chats>0 then round((c.chats-c.handed)::numeric/c.chats,4) end,'afterHours',c.after,
    'replies',(select count(*) from messages m join conversations v on v.id=m.conversation_id where v.org_id=p_org and v.created_at>=t0 and m.role='bot'),
    'reasons',coalesce((select jsonb_agg(jsonb_build_object('reason',reason,'n',k) order by k desc) from (select coalesce(nullif(reason,''),'other') reason,count(*) k from alerts where org_id=p_org and created_at>=t0 group by 1) x),'[]'),
    'requests',jsonb_build_object('total',q.total,'confirmed',q.confirmed,'autoBooked',q.auto,'declined',q.declined,'pending',q.pending,'medianMinutesToDecide',q.med),
    'appointments',jsonb_build_object('scheduled',a.scheduled,'completed',a.completed,'noShow',a.no_show,'cancelled',a.cancelled,'unmarked',a.unmarked,
      'noShowRate',case when a.completed+a.no_show>0 then round(a.no_show::numeric/(a.completed+a.no_show),4) end,
      'cancelRate',case when a.scheduled+a.cancelled>0 then round(a.cancelled::numeric/(a.scheduled+a.cancelled),4) end,
      'created',(select count(*) from bookings where org_id=p_org and created_at>=t0),
      'upcoming',(select count(*) from bookings where org_id=p_org and status in ('requested','booked') and starts_at>=nowl and starts_at<today+8)),
    'bookingsAll',(select count(*) from bookings where org_id=p_org and created_at>=t0 and status<>'cancelled'),
    'byDay',(select jsonb_agg(jsonb_build_object('date',g::date,'n',coalesce(k,0),'cancelled',coalesce(x,0)) order by g) from generate_series(d0::timestamp,today::timestamp,interval '1 day') g
      left join (select starts_at::date dd,count(*) filter (where status<>'cancelled') k,count(*) filter (where status='cancelled') x from bookings where org_id=p_org and starts_at>=d0 and starts_at<today+1 group by 1) s on s.dd=g::date),
    'byDoctor',coalesce((select jsonb_agg(jsonb_build_object('label',l,'n',k) order by k desc) from (select coalesce(nullif(doctor,''),'Unassigned') l,count(*) k from bookings where org_id=p_org and status<>'cancelled' and starts_at>=d0 and starts_at<today+1 group by 1) x),'[]'),
    'byService',coalesce((select jsonb_agg(jsonb_build_object('label',l,'n',k) order by k desc) from (select coalesce(nullif(service,''),'Not set') l,count(*) k from bookings where org_id=p_org and status<>'cancelled' and starts_at>=d0 and starts_at<today+1 group by 1) x),'[]'),
    'bySource',coalesce((select jsonb_agg(jsonb_build_object('label',l,'n',k) order by k desc) from (select source l,count(*) k from bookings where org_id=p_org and status<>'cancelled' and starts_at>=d0 and starts_at<today+1 group by 1) x),'[]'),
    'selfService',(select jsonb_build_object('cancelled',count(*) filter (where action='patient.cancelled'),'rescheduled',count(*) filter (where action='patient.rescheduled')) from audit_events where org_id=p_org and created_at>=t0 and action in ('patient.cancelled','patient.rescheduled')),
    'messages',(select jsonb_build_object('waiting',count(*) filter (where status in ('queued','processing')),'sent',count(*) filter (where status='sent'),'failed',count(*) filter (where status='failed')) from outbox where org_id=p_org and created_at>=t0));
  return r;
end $$;
revoke all on function insights_summary(uuid,int) from public, anon;
grant execute on function insights_summary(uuid,int) to authenticated;
create index if not exists conversations_org_created on conversations(org_id, created_at desc);
create index if not exists audit_events_org_created on audit_events(org_id, created_at desc);
