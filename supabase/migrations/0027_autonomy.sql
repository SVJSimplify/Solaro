-- How much Solara may do on its own.
--  assisted (default): safe work is automatic; risky actions wait for staff approval.
--  full: the owner has accepted the risks in writing; Solara also takes the risky actions itself.
alter table settings add column if not exists autonomy text not null default 'assisted';
alter table settings drop constraint if exists settings_autonomy_ok;
alter table settings add constraint settings_autonomy_ok check (autonomy in ('assisted','full'));
alter table settings add column if not exists autonomy_ack jsonb;
-- Auto-confirming website bookings is a risky action, so it now follows the autonomy mode.
update settings set auto_confirm_web=(autonomy='full');

create or replace function set_autonomy(p_org uuid, p_mode text, p_confirm text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare who text; nm text;
begin
  if not exists(select 1 from members where org_id=p_org and user_id=auth.uid() and role='owner')
    then raise exception 'Only the clinic owner can change how much Solara does on its own.' using errcode='42501'; end if;
  if p_mode not in ('assisted','full') then raise exception 'Unknown mode.' using errcode='P0001'; end if;
  select name into nm from organizations where id=p_org;
  select email into who from auth.users where id=auth.uid();
  if p_mode='full' and lower(btrim(coalesce(p_confirm,'')))<>lower(btrim(nm)) then
    raise exception 'Type the clinic name exactly to confirm.' using errcode='P0001'; end if;
  insert into settings(org_id) values(p_org) on conflict(org_id) do nothing;
  update settings set autonomy=p_mode, auto_confirm_web=(p_mode='full'),
    autonomy_ack=case when p_mode='full' then jsonb_build_object('user_id',auth.uid(),'email',who,'at',now(),'version',1,
      'statement','I understand that Solara will confirm bookings and take other listed actions without staff approval, that it can make mistakes, and that I accept responsibility for the actions it takes on my clinic''s behalf.')
      else autonomy_ack end
  where org_id=p_org;
  insert into audit_events(org_id,actor,action,target_type,detail) values(p_org,auth.uid(),
    case when p_mode='full' then 'autonomy.full_on' else 'autonomy.full_off' end,'settings',
    jsonb_build_object('text',case when p_mode='full' then 'Full autonomy turned on by '||coalesce(who,'the owner')||' (risks accepted)' else 'Full autonomy turned off by '||coalesce(who,'the owner') end));
  return jsonb_build_object('ok',true,'mode',p_mode);
end $$;
revoke all on function set_autonomy(uuid,text,text) from public, anon;
grant execute on function set_autonomy(uuid,text,text) to authenticated;

-- Autopilot: runs every 5 minutes. Each step is small, re-checked by the database rules, and written to the activity log.
create or replace function autopilot() returns jsonb
language plpgsql security definer set search_path=public as $$
declare b bookings; c record; expired int:=0; confirmed int:=0; skipped int:=0; ended int:=0;
begin
  -- Safe, always: a website request whose time passed before anyone decided is closed, and the patient is told.
  for b in select bk.* from bookings bk where bk.status='requested' and bk.starts_at<clinic_now(bk.org_id) for update skip locked loop
    begin
      update bookings set status='cancelled', cancel_reason='Not confirmed before the appointment time' where id=b.id returning * into b;
      perform booking_audit(b,'booking.expired',b.name||' at '||to_char(b.starts_at,'YYYY-MM-DD HH24:MI')||': request was not confirmed in time (closed by Solara)');
      perform booking_notify(b,'Sorry, we could not confirm your request for '||to_char(b.starts_at,'Dy, Mon FMDD "at" FMHH12:MI AM')||' in time. Please choose a new time and we''ll take care of it.','decline');
      expired:=expired+1;
    exception when others then skipped:=skipped+1;
    end;
  end loop;

  -- Full autonomy only: confirm pending website requests that still fit the schedule. Anything that no longer fits stays for staff.
  for b in select bk.* from bookings bk join settings s on s.org_id=bk.org_id
           where s.autonomy='full' and bk.status='requested' and bk.starts_at>=clinic_now(bk.org_id) for update of bk skip locked loop
    begin
      update bookings set status='booked' where id=b.id returning * into b;
      perform booking_audit(b,'booking.confirmed',b.name||' with '||coalesce(nullif(b.doctor,''),'unassigned')||' at '||to_char(b.starts_at,'YYYY-MM-DD HH24:MI')||' (confirmed by Solara, full autonomy)');
      perform booking_notify(b,'Good news: your '||booking_label(b)||' is confirmed. See you then!','confirmation');
      confirmed:=confirmed+1;
    exception when others then skipped:=skipped+1;   -- left as a request for staff to decide
    end;
  end loop;

  -- Safe, always: a chat Solara is handling that has been silent for 7 days is ended (never one waiting for the team).
  for c in select cv.id, cv.org_id, cv.customer from conversations cv
           where cv.status='handled' and cv.created_at<now()-interval '7 days'
             and not exists(select 1 from messages m where m.conversation_id=cv.id and m.created_at>now()-interval '7 days') loop
    update conversations set status='closed', closed_at=now() where id=c.id;
    insert into audit_events(org_id,action,target_type,target_id,detail) values(c.org_id,'chat.closed','conversation',c.id,jsonb_build_object('text',c.customer||' (idle 7 days, ended by Solara)'));
    ended:=ended+1;
  end loop;
  return jsonb_build_object('expired',expired,'confirmed',confirmed,'left_for_staff',skipped,'chats_ended',ended);
end $$;
revoke all on function autopilot() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname='solara-autopilot';
select cron.schedule('solara-autopilot','*/5 * * * *','select public.autopilot()');
