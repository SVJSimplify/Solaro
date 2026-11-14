-- Conversations can be ended by the team; a chat handed to the team stays with the team; cancellations carry a reason.
alter table conversations drop constraint if exists conversations_status_check;
alter table conversations add constraint conversations_status_check check (status in ('handled','handoff','closed'));
alter table conversations add column if not exists closed_at timestamptz;
alter table conversations add column if not exists closed_by uuid;
drop trigger if exists conversations_keep_open on conversations;
drop function if exists chat_keep_open_on_ai_error();
create or replace function alert_hands_off() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.convo is not null and coalesce(new.text,'') not like 'Patient cancelled%' then
    update conversations set status='handoff' where id=new.convo and status='handled';
  end if;
  return new;
end $$;
drop trigger if exists alerts_hand_off on alerts;
create trigger alerts_hand_off after insert on alerts for each row execute function alert_hands_off();
create or replace function messages_closed_guard() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.role in ('cust','bot') and exists(select 1 from conversations where id=new.conversation_id and status='closed') then
    raise exception 'This conversation has ended.' using errcode='P0001';
  end if;
  return new;
end $$;
drop trigger if exists messages_closed on messages;
create trigger messages_closed before insert on messages for each row execute function messages_closed_guard();
create or replace function conversation_close(p_id uuid, p_close boolean default true) returns jsonb
language plpgsql security definer set search_path=public as $$
declare c conversations;
begin
  select * into c from conversations where id=p_id;
  if not found or not is_staff(c.org_id) then raise exception 'Conversation not found.' using errcode='P0002'; end if;
  if p_close then
    update conversations set status='closed', closed_at=now(), closed_by=auth.uid() where id=p_id;
    insert into messages(org_id,conversation_id,role,body) values(c.org_id,p_id,'staff','This conversation has been closed by the team. Start a new chat any time if you need us.');
    insert into audit_events(org_id,actor,action,target_type,target_id,detail) values(c.org_id,auth.uid(),'chat.closed','conversation',p_id,jsonb_build_object('text',c.customer));
  else
    update conversations set status='handoff', closed_at=null, closed_by=null where id=p_id;
    insert into audit_events(org_id,actor,action,target_type,target_id,detail) values(c.org_id,auth.uid(),'chat.reopened','conversation',p_id,jsonb_build_object('text',c.customer));
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function conversation_close(uuid,boolean) from public, anon;
grant execute on function conversation_close(uuid,boolean) to authenticated;
alter table bookings add column if not exists cancel_reason text;
alter table bookings drop constraint if exists bookings_cancel_reason_len;
alter table bookings add constraint bookings_cancel_reason_len check (cancel_reason is null or length(cancel_reason)<=300);
