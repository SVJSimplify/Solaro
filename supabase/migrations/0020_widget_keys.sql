-- Each clinic gets a public widget key for its website embed. The key (not the internal org id) is what goes
-- on the clinic's website; it resolves to the clinic on the server, and rotating it disables old snippets.
alter table organizations add column if not exists widget_key uuid not null default gen_random_uuid();
create unique index if not exists organizations_widget_key_idx on organizations(widget_key);

-- Key -> clinic, only when the clinic's website chat is switched on.
create or replace function widget_org(k uuid) returns uuid
language sql stable security definer set search_path=public as $$
  select id from organizations where widget_key=k and widget_enabled $$;
revoke all on function widget_org(uuid) from public, anon, authenticated;

drop function if exists widget_start(uuid);
create function widget_start(key uuid)
returns table(conversation_id uuid, token text, org_name text, greeting text)
language plpgsql security definer set search_path=public as $$
declare org uuid := widget_org(key); cid uuid; t text; recent int;
begin
  if org is null then raise exception 'Chat is not available for this clinic'; end if;
  select count(*) into recent from conversations c
    where c.org_id=org and c.channel='Web chat' and c.created_at > now()-interval '1 hour';
  if recent >= 300 then raise exception 'Too many new chats right now. Please try again later.'; end if;
  insert into conversations(org_id,customer,channel,status) values(org,'Website visitor','Web chat','handled') returning id into cid;
  t := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into widget_sessions(conversation_id,token_hash) values(cid, encode(sha256(t::bytea),'hex'));
  return query select cid, t, o.name, coalesce(s.greeting,'Hi! How can I help you today?')
    from organizations o left join settings s on s.org_id=o.id where o.id=org;
end $$;
revoke all on function widget_start(uuid) from public;
grant execute on function widget_start(uuid) to anon, authenticated;

drop function if exists widget_info(uuid);
create function widget_info(key uuid) returns table(org_name text, greeting text)
language sql stable security definer set search_path=public as $$
  select o.name, coalesce(s.greeting,'Hi! How can I help you today?')
  from organizations o left join settings s on s.org_id=o.id where o.id=widget_org(key) $$;
revoke all on function widget_info(uuid) from public;
grant execute on function widget_info(uuid) to anon, authenticated;

drop function if exists widget_ping(uuid,text);
create function widget_ping(key uuid, origin text) returns void
language plpgsql security definer set search_path=public as $$
declare org uuid := widget_org(key); o text := lower(trim(origin));
begin
  if org is null or o is null or length(o)>200 or o !~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' then return; end if;
  if exists(select 1 from widget_installs w where w.org_id=org and w.origin=o) then
    update widget_installs set last_seen=now() where org_id=org and widget_installs.origin=o and last_seen<now()-interval '10 minutes';
  elsif (select count(*) from widget_installs w where w.org_id=org)<20 then
    insert into widget_installs(org_id,origin) values(org,o) on conflict do nothing;
  end if;
end $$;
revoke all on function widget_ping(uuid,text) from public;
grant execute on function widget_ping(uuid,text) to anon, authenticated;

-- Owners/admins read their clinic's key and can rotate it (old snippets stop working immediately).
create or replace function widget_key_get(p_org uuid) returns uuid
language sql stable security definer set search_path=public as $$
  select o.widget_key from organizations o join members m on m.org_id=o.id
  where o.id=p_org and m.user_id=auth.uid() and m.role in ('owner','admin') $$;
create or replace function widget_key_rotate(p_org uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare k uuid := gen_random_uuid();
begin
  if not exists(select 1 from members m where m.org_id=p_org and m.user_id=auth.uid() and m.role in ('owner','admin'))
    then raise exception 'Only an owner or admin can do this'; end if;
  update organizations set widget_key=k where id=p_org;
  return k;
end $$;
revoke all on function widget_key_get(uuid), widget_key_rotate(uuid) from public, anon;
grant execute on function widget_key_get(uuid), widget_key_rotate(uuid) to authenticated;
