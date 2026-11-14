-- A chat's inbox name becomes the patient's name and phone as soon as a booking carries them.
create or replace function booking_names_chat() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.conversation_id is not null and coalesce(new.name,'')<>'' then
    update conversations set customer=left(new.name||' · '||coalesce(new.phone,''),120)
    where id=new.conversation_id and customer is distinct from left(new.name||' · '||coalesce(new.phone,''),120);
  end if;
  return new;
end $$;
drop trigger if exists bookings_name_chat on bookings;
create trigger bookings_name_chat after insert or update of name,phone,conversation_id on bookings
  for each row execute function booking_names_chat();

-- A temporary AI failure (fallback reply) alerts the team but must not park a website chat with the team.
create or replace function chat_keep_open_on_ai_error() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.status='handoff' and old.status is distinct from 'handoff' and new.channel='Web chat'
     and (select body from messages where conversation_id=new.id and role='bot' order by created_at desc limit 1)
         = 'Thanks for your message. I’ve passed it to our team and they’ll follow up shortly.' then
    new.status:=old.status;
  end if;
  return new;
end $$;
drop trigger if exists conversations_keep_open on conversations;
create trigger conversations_keep_open before update of status on conversations
  for each row execute function chat_keep_open_on_ai_error();

update conversations c set status='handled'
where c.channel='Web chat' and c.status='handoff'
  and (select body from messages where conversation_id=c.id and role='bot' order by created_at desc limit 1)
      = 'Thanks for your message. I’ve passed it to our team and they’ll follow up shortly.';
