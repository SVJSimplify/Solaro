-- 0037: WhatsApp (Meta Cloud API) as a per-clinic alternative to text messages for appointment reminders.
-- Additive. Rollback: restore queue_due_reminders() from 0036, drop function set_message_channel(uuid,text),
-- then optionally drop column organizations.message_channel. Existing clinics stay on 'sms'. outbox has no channel constraint, so 'whatsapp' rows need no change there.

alter table organizations add column if not exists message_channel text not null default 'sms';
alter table organizations drop constraint if exists organizations_message_channel_ok;
alter table organizations add constraint organizations_message_channel_ok check (message_channel in ('sms','whatsapp'));

-- organizations is column-locked (0028), so owners and admins change the channel through this function only.
create or replace function set_message_channel(p_org uuid, p_channel text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare who text; prev text;
begin
  if not can_manage(p_org) then raise exception 'Only owners and admins can change how patients are messaged.' using errcode='42501'; end if;
  if p_channel not in ('sms','whatsapp') then raise exception 'Unknown channel.' using errcode='P0001'; end if;
  select message_channel into prev from organizations where id=p_org;
  if prev is not distinct from p_channel then return jsonb_build_object('ok',true,'channel',p_channel); end if;
  update organizations set message_channel=p_channel where id=p_org;
  select email into who from auth.users where id=auth.uid();
  insert into audit_events(org_id,actor,action,target_type,detail) values(p_org,auth.uid(),'settings.message_channel','settings',
    jsonb_build_object('text','Patient messages set to '||case when p_channel='whatsapp' then 'WhatsApp' else 'SMS' end||' by '||coalesce(who,'staff')));
  return jsonb_build_object('ok',true,'channel',p_channel);
end $$;
revoke all on function set_message_channel(uuid,text) from public, anon;
grant execute on function set_message_channel(uuid,text) to authenticated;

-- outbox_claim(integer,text[]) from 0036 filters on x.channel = any(p_channels) and is channel-agnostic: it claims 'whatsapp' unchanged.

-- Reminders: same as 0036, but the text/WhatsApp message goes out on the clinic's channel.
-- WhatsApp rows carry the template name and its three body parameters (service, doctor, when) in outbox.data.
create or replace function queue_due_reminders() returns jsonb
language plpgsql security definer set search_path=public as $$
declare x int; r record; p int := 0; msg text; ch text; whn text;
begin
  for r in
    update bookings b set reminded=true
    where b.status='booked' and not b.reminded
      and b.starts_at > (now() at time zone 'UTC')-interval '13 hours' and b.starts_at <= (now() at time zone 'UTC')+interval '39 hours'
      and b.starts_at > clinic_now(b.org_id) and b.starts_at <= clinic_now(b.org_id)+interval '24 hours'
    returning b.*
  loop
    whn := to_char(r.starts_at,'Dy, Mon FMDD "at" FMHH12:MI AM');
    msg := 'Reminder: '||coalesce(nullif(r.service,''),'appointment')||coalesce(' with '||nullif(r.doctor,''),'')||' on '||whn||'.';
    select coalesce(o.message_channel,'sms') into ch from organizations o where o.id=r.org_id;
    if coalesce(r.phone,'')<>'' then
      if ch='whatsapp' then
        insert into outbox(org_id,channel,to_addr,body,data,kind,booking_id) values(r.org_id,'whatsapp',r.phone,msg,
          jsonb_build_object('template','reminder','params',jsonb_build_array(coalesce(nullif(r.service,''),'appointment'),coalesce(nullif(r.doctor,''),'our team'),whn)),'reminder',r.id);
      else
        insert into outbox(org_id,channel,to_addr,body,kind,booking_id) values(r.org_id,'sms',r.phone,msg,'reminder',r.id);
      end if;
    end if;
    p := p + push_patient(r.org_id,r.conversation_id,r.phone,(select name from organizations where id=r.org_id),msg,'reminder');
  end loop;
  update outbox set status='failed', last_error='Not sent within 24 hours. Check that a text-message or WhatsApp provider is connected.'
    where status='queued' and channel in ('sms','whatsapp') and created_at<now()-interval '24 hours';
  get diagnostics x = row_count;
  -- A notification that is a day old is no longer useful.
  update outbox set status='failed', last_error='Not delivered within 24 hours. Check that push notifications are connected.'
    where status='queued' and channel='push' and created_at<now()-interval '24 hours';
  return jsonb_build_object('push',p,'expired',x);
end $$;
