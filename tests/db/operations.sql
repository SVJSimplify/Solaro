-- Sanity checks for migrations 0016-0018. Run on a database built by rebuild.sh:
--   psql -v ON_ERROR_STOP=1 -d <db> -f tests/db/operations.sql      (everything runs in one transaction and is rolled back)
begin;
create function pg_temp.fails(q text, code text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlstate=code then return; end if; raise exception 'expected % but got % (%) for: %', code, sqlstate, sqlerrm, q; end;
  raise exception 'expected % but it succeeded: %', code, q;
end $$;
create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$ begin if cond is not true then raise exception 'FAILED: %', what; end if; end $$;

insert into auth.users(id,email) values('00000000-0000-0000-0000-0000000000a1','a@t'),('00000000-0000-0000-0000-0000000000b2','b@t');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1',false);
create temp table t as select create_org('Ops test') org;
update organizations set timezone='Asia/Kolkata' where id=(select org from t);
insert into doctors(org_id,name,specialty,services,days,start_time,end_time,slot) select org,'Dr. Test','',array['Cleaning'],array[0,1,2,3,4,5,6],'00:00','24:00',30 from t;
alter table t add doc uuid, add d1 timestamp, add soon timestamp;
update t set doc=(select id from doctors where org_id=t.org and name='Dr. Test'), d1=(clinic_now(org)::date+1)+time '10:00',
  soon=date_trunc('hour',clinic_now(org))+interval '2 hours';

-- create, double booking, grid, overlap
select pg_temp.ok((booking_create(org,'Asha','+15551230001','Cleaning',d1,doc)->>'ok')::boolean,'create') from t;
select pg_temp.ok((select count(*)=1 from outbox where kind='confirmation' and status='queued'),'confirmation queued, not sent') from t;
select pg_temp.fails(format('select booking_create(%L,%L,%L,%L,%L,%L)',org,'Ben','+15551230002','Cleaning',d1,doc),'23505') from t;
select pg_temp.fails(format('insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status) values(%L,%L,%L,%L,%L,%L,%L,%L)',org,'Off grid','+1','Cleaning',d1+interval '15 min',doc,'x','booked'),'23514') from t;
select pg_temp.fails(format('select booking_create(%L,%L,%L,%L,%L,%L)',org,'Ben','+15551230002','Whitening',d1+interval '1 hour',doc),'P0001') from t;
-- confirmed leave blocks, tentative leave does not, closed day blocks
insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,source) select t.org,be.id,(t.d1::date+1),'leave','confirmed','manual' from t join business_entities be on be.legacy_doctor_id=t.doc;
insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,source) select t.org,be.id,(t.d1::date+2),'leave','tentative','manual' from t join business_entities be on be.legacy_doctor_id=t.doc;
select pg_temp.fails(format('select booking_create(%L,%L,%L,%L,%L,%L)',org,'Cy','+15551230003','Cleaning',d1+interval '1 day',doc),'23514') from t;
select pg_temp.ok((booking_create(org,'Cy','+15551230003','Cleaning',d1+interval '2 days',doc)->>'ok')::boolean,'tentative leave does not block') from t;
insert into closures(org_id,date) select org,(d1::date+3)::text from t;
select pg_temp.fails(format('select booking_create(%L,%L,%L,%L,%L,%L)',org,'Di','+15551230004','Cleaning',d1+interval '3 days',doc),'23514') from t;
-- website request: first decision wins, patient is told once
insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status,source) select org,'Eve','+15551230005','Cleaning',d1+interval '1 hour',doc,'Dr. Test','requested','website' from t;
select pg_temp.ok((booking_decide(b.id,true)->>'ok')::boolean,'confirm') from bookings b where b.name='Eve';
select pg_temp.ok(not (booking_decide(b.id,false)->>'ok')::boolean and b.status='booked' and b.decided_at is not null,'second decision ignored') from bookings b where b.name='Eve';
select pg_temp.ok((select count(*)=1 from outbox o join bookings b on b.id=o.booking_id where b.name='Eve'),'one message for one decision');
-- reschedule: taken slot refused, free slot moves and re-arms the reminder
select pg_temp.fails(format('select booking_reschedule(%L,%L)',b.id,t.d1),'23505') from bookings b,t where b.name='Eve';
select pg_temp.ok((booking_reschedule(b.id,t.d1+interval '2 hours')->>'ok')::boolean,'reschedule') from bookings b,t where b.name='Eve';
select pg_temp.ok(b.starts_at=t.d1+interval '2 hours' and not b.reminded,'moved') from bookings b,t where b.name='Eve';
-- status after the visit
select pg_temp.fails(format('select booking_set_status(%L,%L)',b.id,'completed'),'P0001') from bookings b where b.name='Eve';
insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status) select org,'Past','+15551230006','Cleaning',d1-interval '2 days',doc,'x','booked' from t;
select pg_temp.ok(booking_set_status(b.id,'no_show')->>'status'='no_show','no-show') from bookings b where b.name='Past';
select pg_temp.ok(booking_set_status(b.id,'booked')->>'status'='booked','undo') from bookings b where b.name='Past';
select pg_temp.ok(booking_set_status(b.id,'completed')->>'status'='completed','completed') from bookings b where b.name='Past';
-- cancel frees the slot
select pg_temp.ok((booking_cancel(b.id)->>'ok')::boolean,'cancel') from bookings b where b.name='Asha';
select pg_temp.ok((booking_create(org,'Fay','+15551230007','Cleaning',d1,doc)->>'ok')::boolean,'slot free after cancel') from t;
-- reminders: once, server-side, clinic time
select pg_temp.ok((booking_create(org,'Gus','+15551230008','Cleaning',soon,doc,false)->>'ok')::boolean,'soon') from t;
select pg_temp.ok((queue_due_reminders()->>'queued')::int>=1,'reminder queued');
select pg_temp.ok((queue_due_reminders()->>'queued')::int=0,'reminder not queued twice');
select pg_temp.ok((select count(*)=1 from outbox o join bookings b on b.id=o.booking_id where b.name='Gus' and o.kind='reminder'),'one reminder');
-- delivery lifecycle
create temp table c as select * from outbox_claim(100);
select pg_temp.ok((select count(*)>0 and bool_and(status='processing') from c),'claimed');
select pg_temp.ok((select count(*)=0 from outbox_claim(100)),'nothing claimed twice');
select outbox_mark((select id from c limit 1),false,'provider 500');
select pg_temp.ok((select status='queued' and next_attempt_at>now() and last_error='provider 500' from outbox where id=(select id from c limit 1)),'retry with backoff');
select outbox_mark(id,true,'','SM1') from c offset 1;
select pg_temp.ok((select count(*)>0 from outbox where status='sent' and sent_at is not null),'sent');
-- insights
select pg_temp.ok((i->'appointments'->>'completed')::int=1 and (i->'appointments'->>'upcoming')::int>=3 and jsonb_array_length(i->'byDay')=30 and (i->'requests'->>'confirmed')::int=1
  and (i->'messages'->>'sent')::int>0,'insights: '||i::text) from (select insights_summary(org,30) i from t) x;
-- another clinic's user sees and changes nothing
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2',false);
select pg_temp.fails(format('select booking_cancel(%L)',b.id),'P0002') from bookings b where b.name='Fay';
select pg_temp.fails(format('select insights_summary(%L,30)',org),'42501') from t;
select pg_temp.fails(format('select booking_create(%L,%L,%L,%L,%L,%L)',org,'X','+1','Cleaning',d1+interval '5 hours',doc),'42501') from t;
select 'operations: all checks passed' result;
rollback;
