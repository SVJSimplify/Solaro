-- Phase 3: conversational extraction, doctor role, one audit trail.
-- Additive. Nothing is dropped; the old audit table is renamed and kept as read-only history.
-- DO NOT apply to production until reviewed. Tested locally only (tests/db).

-- 1. Doctor role. Doctors read clinic information but cannot read customer data or change anything.
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid='members'::regclass and contype='c' and pg_get_constraintdef(oid) like '%role%';
  if c is not null then execute format('alter table members drop constraint %I',c); end if;
end $$;
alter table members add constraint members_role_check check (role in ('owner','admin','staff','doctor'));

create or replace function is_staff(o uuid) returns boolean
language sql stable security definer set search_path=public as
$$ select coalesce(my_role(o) in ('owner','admin','staff'), false) $$;
revoke all on function is_staff(uuid) from public,anon;
grant execute on function is_staff(uuid) to authenticated;

-- Customer data (chats, bookings, alerts, outbox) is for staff, admins and owners. Doctors do not see it.
do $$ declare t text; begin
  foreach t in array array['conversations','messages','bookings','alerts','outbox'] loop
    execute format('drop policy if exists tenant_all on %I',t);
    execute format('create policy staff_all on %I for all to authenticated using (is_staff(org_id)) with check (is_staff(org_id))',t);
  end loop;
end $$;

-- 2. The organisation's time zone, used to read "tomorrow" and "next Tuesday".
alter table organizations add column if not exists timezone text not null default 'UTC' check (length(timezone) between 1 and 64);

-- 3. Source attribution: the words the information came from.
alter table business_facts add column if not exists source_quote text not null default '' check (length(source_quote) <= 500);
alter table schedule_rules add column if not exists source_quote text not null default '' check (length(source_quote) <= 500);
alter table schedule_exceptions add column if not exists source_quote text not null default '' check (length(source_quote) <= 500);

-- 4. One audit trail. audit_events is the only store. The old table becomes read-only history, copied across once.
alter table audit rename to audit_legacy;
drop policy if exists tenant_all on audit_legacy;
create policy legacy_read on audit_legacy for select to authenticated using (is_member(org_id));
revoke insert, update, delete on audit_legacy from anon, authenticated;

insert into audit_events(id,org_id,action,target_type,detail,created_at)
select gen_random_uuid(), l.org_id, left(l.action,80), 'legacy', jsonb_build_object('text',left(l.detail,500),'legacy_id',l.id), l.created_at
from audit_legacy l
where not exists (select 1 from audit_events e where e.detail->>'legacy_id' = l.id::text);

-- The name the app already reads. Read-only view over audit_events.
create view audit with (security_invoker=true) as
  select id, org_id, action, coalesce(detail->>'text', left(detail::text,300)) as detail, created_at from audit_events;
grant select on audit to authenticated;

-- App-written events (booking, handoff, errors). The database fills in the actor.
create or replace function log_audit(p_org uuid, p_action text, p_text text default '') returns void
language plpgsql security definer set search_path=public as $$
begin
  if not is_member(p_org) then raise exception 'Not a member of this organisation' using errcode='42501'; end if;
  perform write_audit(p_org, left(coalesce(nullif(btrim(p_action),''),'event'),80), 'app', null, jsonb_build_object('text',left(coalesce(p_text,''),500)));
end $$;
revoke all on function log_audit(uuid,text,text) from public,anon;
grant execute on function log_audit(uuid,text,text) to authenticated;
alter publication supabase_realtime add table audit_events;
-- The currently deployed app still inserts into "audit". Keep that working: the insert lands in audit_events.
create or replace function audit_view_insert() returns trigger language plpgsql security definer set search_path=public as $$
begin perform log_audit(new.org_id,new.action,new.detail); return new; end $$;
create trigger audit_insert instead of insert on audit for each row execute function audit_view_insert();
grant insert on audit to authenticated;

-- 5. Patient information never belongs in business memory. Same rule as the application check.
create or replace function contains_patient_info(t text) returns boolean language sql immutable as $$
  select t ~* '[^\s@]+@[^\s@]+\.[a-z]{2,}'
    or regexp_replace(coalesce(t,''),'\d{4}-\d{2}-\d{2}','','g') ~ '\d([\s().-]?\d){7,}'
    or t ~* '\m(diagnos\w*|prescri\w*|medical record|mrn|test results?|lab results?|date of birth|dob)\M'
    or t ~* '\mpatient\s+(named|called|id|number)\M'
$$;

-- 6. Keep the new tables in step with the doctors and closures the booking engine still reads. One direction: legacy -> information.
create or replace function sync_doctor_info() returns trigger language plpgsql security definer set search_path=public as $$
declare eid uuid; d int; sm int; em int;
begin
  if tg_op='DELETE' then
    update business_entities set status='inactive', updated_at=now() where legacy_doctor_id=old.id;
    update schedule_rules set status='superseded' where source_reference='doctor:'||old.id::text and source='legacy_doctors' and status in ('confirmed','tentative','pending_approval');
    return old;
  end if;
  begin
    select id into eid from business_entities where legacy_doctor_id=new.id;
    if eid is null then
      insert into business_entities(org_id,kind,name,normalized_name,details,legacy_doctor_id)
        values(new.org_id,'doctor',btrim(new.name),lower(regexp_replace(btrim(new.name),'\s+',' ','g')),
          jsonb_build_object('specialty',new.specialty,'services',to_jsonb(new.services)),new.id) returning id into eid;
    else
      update business_entities set name=btrim(new.name), normalized_name=lower(regexp_replace(btrim(new.name),'\s+',' ','g')),
        details=jsonb_build_object('specialty',new.specialty,'services',to_jsonb(new.services)), status='active', updated_at=now() where id=eid;
    end if;
  exception when unique_violation then
    perform write_audit(new.org_id,'sync.skipped','doctor',new.id,jsonb_build_object('reason','duplicate name'));
    return new;
  end;
  if tg_op='UPDATE' and old.days is not distinct from new.days and old.start_time is not distinct from new.start_time
     and old.end_time is not distinct from new.end_time and old.slot is not distinct from new.slot then return new; end if;
  if new.start_time ~ '^\d{1,2}:\d{2}$' and new.end_time ~ '^\d{1,2}:\d{2}$' then
    sm:=split_part(new.start_time,':',1)::int*60+split_part(new.start_time,':',2)::int;
    em:=split_part(new.end_time,':',1)::int*60+split_part(new.end_time,':',2)::int;
    update schedule_rules set status='superseded' where source='legacy_doctors' and source_reference='doctor:'||new.id::text and status in ('confirmed','tentative','pending_approval');
    if em>sm and sm>=0 and em<=1440 then
      begin
        foreach d in array coalesce(new.days,'{}') loop
          if d between 0 and 6 then
            insert into schedule_rules(org_id,entity_id,weekday,start_min,end_min,slot_minutes,status,source,source_reference,effective_from)
              values(new.org_id,eid,d,sm,em,coalesce(new.slot,30),'confirmed','legacy_doctors','doctor:'||new.id::text,current_date);
          end if;
        end loop;
      exception when exclusion_violation then
        perform write_audit(new.org_id,'sync.conflict','doctor',new.id,jsonb_build_object('reason','overlaps recorded hours'));
      end;
    end if;
  end if;
  return new;
end $$;
create trigger doctors_sync after insert or update or delete on doctors for each row execute function sync_doctor_info();

create or replace function sync_closure_info() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='DELETE' then
    update schedule_exceptions set status='superseded', updated_at=now() where source_reference='closure:'||old.id::text and status in ('confirmed','tentative','pending_approval');
    return old;
  end if;
  if new.date ~ '^\d{4}-\d{2}-\d{2}$' and not exists(select 1 from schedule_exceptions where source_reference='closure:'||new.id::text) then
    begin
      insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,source_reference)
        values(new.org_id,null,new.date::date,'closure','confirmed','Clinic closed','legacy_closures','closure:'||new.id::text);
    exception when unique_violation or invalid_datetime_format or datetime_field_overflow then null;
    end;
  end if;
  return new;
end $$;
create trigger closures_sync after insert or delete on closures for each row execute function sync_closure_info();

-- 7. The one write path for extracted information. One call applies one item, in one transaction, and returns what happened.
--    The application resolves names and dates first; every rule that protects data is enforced here as well.
--    Business problems (duplicate, contradiction, protected confirmed data) come back as results, not errors.
--    Permission and malformed input raise.
create or replace function apply_information_item(p_org uuid, p_item jsonb, p_ref text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  role_ text := my_role(p_org);
  mgr boolean := coalesce(role_ in ('owner','admin'),false);
  typ text := p_item->>'type';
  st text := p_item->>'status';
  intent text := coalesce(p_item->>'intent','add');
  quote text := left(coalesce(p_item->>'source_quote',''),500);
  eid uuid := nullif(p_item->>'entity_id','')::uuid;
  tz text; today date; rec record; nid uuid; hit uuid;
  ok_entity boolean;
  res jsonb;
begin
  if role_ is null or role_='doctor' then raise exception 'You do not have permission to record information' using errcode='42501'; end if;
  if typ not in ('weekly_hours','exception','withdraw_exception','fact') or st not in ('tentative','confirmed') or intent not in ('add','correct') then
    raise exception 'Invalid item' using errcode='22023';
  end if;
  if st='confirmed' and not mgr then raise exception 'Only owners and admins can confirm information' using errcode='42501'; end if;
  if contains_patient_info(concat_ws(' ',p_item->>'note',p_item->>'value',p_item->>'key',quote)) then
    return jsonb_build_object('result','rejected','reason','PATIENT_INFORMATION','message','Patient information cannot be stored in business memory.');
  end if;
  select timezone into tz from organizations where id=p_org;
  today := (now() at time zone coalesce(tz,'UTC'))::date;
  if eid is not null then
    select exists(select 1 from business_entities where id=eid and org_id=p_org and status='active') into ok_entity;
    if not ok_entity then return jsonb_build_object('result','rejected','reason','ENTITY_NOT_FOUND','message','That person or service was not found in this clinic.'); end if;
  end if;

  -- Replay of an item that was already applied (same reference): report it, change nothing.
  select id into hit from (
    select id from schedule_rules where org_id=p_org and source_reference=p_ref
    union all select id from schedule_exceptions where org_id=p_org and source_reference=p_ref
    union all select id from business_facts where org_id=p_org and source_reference=p_ref) x limit 1;
  if hit is not null then return jsonb_build_object('result','duplicate','id',hit,'reason','REPLAYED','message','Already recorded.'); end if;

  begin
    if typ='weekly_hours' then
      if eid is null then raise exception 'entity required' using errcode='22023'; end if;
      select count(*) filter (where start_min=(p_item->>'start_min')::int and end_min=(p_item->>'end_min')::int and slot_minutes=(p_item->>'slot_minutes')::int) as same,
             count(*) as n, bool_or(status='confirmed') as any_confirmed, bool_and(status='tentative') as all_tentative,
             jsonb_agg(jsonb_build_object('id',id,'start_min',start_min,'end_min',end_min,'status',status)) as rows
        into rec from schedule_rules
        where entity_id=eid and org_id=p_org and weekday=(p_item->>'weekday')::int and status in ('confirmed','tentative','pending_approval')
          and int4range(start_min,end_min,'[)') && int4range((p_item->>'start_min')::int,(p_item->>'end_min')::int,'[)')
          and coalesce(effective_until,'infinity'::date) > today;
      if rec.n>0 then
        if rec.n=rec.same and not (st='confirmed' and rec.all_tentative) then
          return jsonb_build_object('result','duplicate','existing',rec.rows,'message','These hours are already recorded.');
        end if;
        if not (rec.n=rec.same and st='confirmed' and rec.all_tentative) then
          if intent<>'correct' then return jsonb_build_object('result','conflict','reason','CONTRADICTS_EXISTING','existing',rec.rows,'message','Different hours are already recorded for that day.'); end if;
          if rec.any_confirmed and not mgr then return jsonb_build_object('result','conflict','reason','CONFIRMED_PROTECTED','existing',rec.rows,'message','Confirmed hours can only be changed by an owner or admin.'); end if;
        end if;
        update schedule_rules set status='superseded' where id in (select (x->>'id')::uuid from jsonb_array_elements(rec.rows) x);
      end if;
      insert into schedule_rules(org_id,entity_id,weekday,start_min,end_min,slot_minutes,status,source,source_reference,source_quote,effective_from,created_by,approved_by,supersedes_id)
        values(p_org,eid,(p_item->>'weekday')::int,(p_item->>'start_min')::int,(p_item->>'end_min')::int,(p_item->>'slot_minutes')::int,st,'conversation',p_ref,quote,today,auth.uid(),
          case when st='confirmed' then auth.uid() end,
          (select (x->>'id')::uuid from jsonb_array_elements(coalesce(rec.rows,'[]'::jsonb)) x limit 1))
        returning id into nid;
      res := jsonb_build_object('result',case when rec.n>0 then 'superseded' else 'created' end,'id',nid,'previous',rec.rows);
      perform write_audit(p_org,'info.weekly_hours.'||(res->>'result'),'schedule_rule',nid,jsonb_build_object('ref',p_ref,'status',st,'source','conversation'));
      return res;

    elsif typ in ('exception','withdraw_exception') then
      if eid is null then raise exception 'entity required' using errcode='22023'; end if;
      select id, status into rec from schedule_exceptions
        where org_id=p_org and entity_id=eid and on_date=(p_item->>'on_date')::date and kind=p_item->>'kind' and status in ('confirmed','tentative','pending_approval') for update;
      if typ='withdraw_exception' then
        if not found then return jsonb_build_object('result','rejected','reason','ENTITY_NOT_FOUND','message','No such leave is recorded.'); end if;
        if rec.status='confirmed' and not mgr then return jsonb_build_object('result','conflict','reason','CONFIRMED_PROTECTED','message','Confirmed leave can only be withdrawn by an owner or admin.'); end if;
        update schedule_exceptions set status='superseded', updated_at=now() where id=rec.id;
        perform write_audit(p_org,'exception.withdrawn','schedule_exception',rec.id,jsonb_build_object('ref',p_ref,'quote',quote));
        return jsonb_build_object('result','withdrawn','id',rec.id,'previous',jsonb_build_array(jsonb_build_object('id',rec.id,'status',rec.status)));
      end if;
      if (p_item->>'on_date')::date < today then return jsonb_build_object('result','rejected','reason','DATE_PASSED','message','That date has already passed.'); end if;
      if found then
        if rec.status=st then return jsonb_build_object('result','duplicate','id',rec.id,'existing',jsonb_build_array(jsonb_build_object('id',rec.id,'status',rec.status)),'message','Already recorded.'); end if;
        if rec.status='confirmed' and st='tentative' and not (intent='correct' and mgr) then
          return jsonb_build_object('result','conflict','reason','CONFIRMED_PROTECTED','existing',jsonb_build_array(jsonb_build_object('id',rec.id,'status',rec.status)),'message','That leave is already confirmed. A tentative note does not replace it.');
        end if;
        update schedule_exceptions set status='superseded', updated_at=now() where id=rec.id;
      end if;
      insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,source_reference,source_quote,created_by,approved_by,supersedes_id)
        values(p_org,eid,(p_item->>'on_date')::date,p_item->>'kind',st,left(coalesce(p_item->>'note',''),500),'conversation',p_ref,quote,auth.uid(),
          case when st='confirmed' then auth.uid() end, rec.id) returning id into nid;
      res := jsonb_build_object('result',case when rec.id is not null then 'superseded' else 'created' end,'id',nid,
        'previous',case when rec.id is not null then jsonb_build_array(jsonb_build_object('id',rec.id,'status',rec.status)) end);
      perform write_audit(p_org,'info.exception.'||(res->>'result'),'schedule_exception',nid,jsonb_build_object('ref',p_ref,'status',st,'source','conversation'));
      return res;

    else -- fact
      select id, value, status into rec from business_facts
        where org_id=p_org and coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce(eid,'00000000-0000-0000-0000-000000000000'::uuid)
          and category=p_item->>'category' and key=p_item->>'key' and status in ('confirmed','tentative','pending_approval') for update;
      if found then
        if lower(btrim(rec.value))=lower(btrim(p_item->>'value')) and not (st='confirmed' and rec.status='tentative') then
          return jsonb_build_object('result','duplicate','id',rec.id,'existing',jsonb_build_array(jsonb_build_object('id',rec.id,'value',rec.value,'status',rec.status)),'message','Already recorded.');
        end if;
        if not (lower(btrim(rec.value))=lower(btrim(p_item->>'value')) and st='confirmed') then
          if intent<>'correct' then return jsonb_build_object('result','conflict','reason','CONTRADICTS_EXISTING','existing',jsonb_build_array(jsonb_build_object('id',rec.id,'value',rec.value,'status',rec.status)),'message','A different value is already recorded.'); end if;
          if rec.status='confirmed' and not mgr then return jsonb_build_object('result','conflict','reason','CONFIRMED_PROTECTED','existing',jsonb_build_array(jsonb_build_object('id',rec.id,'value',rec.value,'status',rec.status)),'message','Confirmed information can only be changed by an owner or admin.'); end if;
        end if;
        update business_facts set status='superseded', updated_at=now() where id=rec.id;
      else
        -- Same wording already saved under another key in the same category and scope.
        select id into hit from business_facts where org_id=p_org and category=p_item->>'category' and status in ('confirmed','tentative','pending_approval')
          and coalesce(entity_id,'00000000-0000-0000-0000-000000000000'::uuid)=coalesce(eid,'00000000-0000-0000-0000-000000000000'::uuid)
          and lower(btrim(value))=lower(btrim(p_item->>'value')) limit 1;
        if hit is not null then return jsonb_build_object('result','duplicate','id',hit,'reason','SAME_VALUE_OTHER_KEY','message','The same information is already saved under another name.'); end if;
      end if;
      insert into business_facts(org_id,entity_id,category,key,value,status,source,source_reference,source_quote,created_by,approved_by,supersedes_id)
        values(p_org,eid,p_item->>'category',p_item->>'key',p_item->>'value',st,'conversation',p_ref,quote,auth.uid(),case when st='confirmed' then auth.uid() end,rec.id)
        returning id into nid;
      res := jsonb_build_object('result',case when rec.id is not null then 'superseded' else 'created' end,'id',nid,
        'previous',case when rec.id is not null then jsonb_build_array(jsonb_build_object('id',rec.id,'value',rec.value,'status',rec.status)) end);
      perform write_audit(p_org,'info.fact.'||(res->>'result'),'business_fact',nid,jsonb_build_object('ref',p_ref,'status',st,'source','conversation'));
      return res;
    end if;
  exception when unique_violation or exclusion_violation then
    return jsonb_build_object('result','conflict','reason','CONTRADICTS_EXISTING','message','Another change to the same information happened at the same time. Check the current record.');
  end;
end $$;
revoke all on function apply_information_item(uuid,jsonb,text) from public,anon;
grant execute on function apply_information_item(uuid,jsonb,text) to authenticated;
