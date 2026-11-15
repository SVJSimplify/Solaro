-- 0035 Business readiness: staff invites and team management, in-app support tickets, and a setup checklist.

-- ── Team ─────────────────────────────────────────────────────────────────────
create table if not exists team_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('admin','staff','doctor')),
  token_hash text not null unique,
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);
create index if not exists team_invites_org on team_invites(org_id) where accepted_at is null;
alter table team_invites enable row level security;
revoke all on team_invites from anon, authenticated;

-- Members and pending invites. Everyone in the clinic sees the team; only owners/admins see invites.
create or replace function team_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_member(p_org) then raise exception 'Not a member of this clinic' using errcode='42501'; end if;
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',u.email,'role',m.role,'joined',m.created_at,'me',m.user_id=auth.uid())
                 order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.email)
               from members m join auth.users u on u.id=m.user_id where m.org_id=p_org),'[]'),
    'invites', case when can_manage(p_org) then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'expires_at',i.expires_at) order by i.created_at desc)
               from team_invites i where i.org_id=p_org and i.accepted_at is null and i.expires_at>now()),'[]') else '[]' end);
end $$;

-- Creates an invite and returns the one-time secret for the join link (only its hash is stored).
create or replace function team_invite(p_org uuid, p_email text, p_role text) returns text
language plpgsql security definer set search_path=public as $$
declare e text := lower(trim(p_email)); tok text; r text := my_role(p_org);
begin
  if r not in ('owner','admin') then raise exception 'Only an owner or admin can invite people.' using errcode='42501'; end if;
  if p_role not in ('admin','staff','doctor') then raise exception 'Choose admin, staff or doctor.' using errcode='22023'; end if;
  if p_role='admin' and r<>'owner' then raise exception 'Only the owner can invite another admin.' using errcode='42501'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.' using errcode='22023'; end if;
  if exists(select 1 from members m join auth.users u on u.id=m.user_id where m.org_id=p_org and lower(u.email)=e) then
    raise exception 'That person is already on your team.' using errcode='23505'; end if;
  perform throttle('team_invite:'||p_org, 30, 3600);
  delete from team_invites where org_id=p_org and email=e and accepted_at is null;
  tok := encode(extensions.gen_random_bytes(32),'hex');
  insert into team_invites(org_id,email,role,token_hash,invited_by) values (p_org,e,p_role,encode(sha256(tok::bytea),'hex'),auth.uid());
  perform write_audit(p_org,'team.invite','app',null,jsonb_build_object('text','Invited '||e||' as '||p_role));
  return tok;
end $$;

create or replace function team_revoke_invite(p_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare o uuid; e text;
begin
  select org_id, email into o, e from team_invites where id=p_id and accepted_at is null;
  if o is null or not can_manage(o) then raise exception 'Invite not found.' using errcode='PT404'; end if;
  delete from team_invites where id=p_id;
  perform write_audit(o,'team.revoke','app',null,jsonb_build_object('text','Cancelled the invite for '||e));
end $$;

-- The invited person, signed in with the invited email, joins the clinic.
create or replace function accept_invite(p_token text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare i team_invites; me record;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode='42501'; end if;
  perform throttle('accept_invite:'||auth.uid(), 10, 3600);
  select * into i from team_invites where token_hash=encode(sha256(coalesce(p_token,'')::bytea),'hex');
  if i.id is null or i.accepted_at is not null or i.expires_at<now() then
    raise exception 'This invite link is no longer valid. Ask your clinic for a new one.' using errcode='PT404'; end if;
  select email, email_confirmed_at into me from auth.users where id=auth.uid();
  if lower(me.email)<>i.email then raise exception 'This invite is for %. Sign in with that email address.', i.email using errcode='42501'; end if;
  if me.email_confirmed_at is null then raise exception 'Please confirm your email address first.' using errcode='42501'; end if;
  insert into members(org_id,user_id,role) values (i.org_id,auth.uid(),i.role) on conflict (org_id,user_id) do nothing;
  update team_invites set accepted_at=now(), accepted_by=auth.uid() where id=i.id;
  perform write_audit(i.org_id,'team.join','app',null,jsonb_build_object('text',i.email||' joined as '||i.role));
  return jsonb_build_object('org_id',i.org_id,'role',i.role,'clinic',(select name from organizations where id=i.org_id));
end $$;

create or replace function team_set_role(p_org uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path=public as $$
declare cur text;
begin
  if my_role(p_org) is distinct from 'owner' then raise exception 'Only the owner can change roles.' using errcode='42501'; end if;
  if p_role not in ('admin','staff','doctor') then raise exception 'Choose admin, staff or doctor.' using errcode='22023'; end if;
  select role into cur from members where org_id=p_org and user_id=p_user;
  if cur is null then raise exception 'Not on this team.' using errcode='PT404'; end if;
  if cur='owner' then raise exception 'The owner''s role cannot be changed.' using errcode='42501'; end if;
  update members set role=p_role where org_id=p_org and user_id=p_user;
  perform write_audit(p_org,'team.role','app',p_user,jsonb_build_object('text','Role changed to '||p_role));
end $$;

create or replace function team_remove(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path=public as $$
declare r text := my_role(p_org); cur text; e text;
begin
  if r not in ('owner','admin') then raise exception 'Only an owner or admin can remove people.' using errcode='42501'; end if;
  select m.role, u.email into cur, e from members m join auth.users u on u.id=m.user_id where m.org_id=p_org and m.user_id=p_user;
  if cur is null then raise exception 'Not on this team.' using errcode='PT404'; end if;
  if cur='owner' then raise exception 'The owner cannot be removed.' using errcode='42501'; end if;
  if cur='admin' and r<>'owner' then raise exception 'Only the owner can remove an admin.' using errcode='42501'; end if;
  if p_user=auth.uid() then raise exception 'You cannot remove yourself.' using errcode='42501'; end if;
  delete from members where org_id=p_org and user_id=p_user;
  perform write_audit(p_org,'team.remove','app',null,jsonb_build_object('text','Removed '||e));
end $$;

-- ── Support ──────────────────────────────────────────────────────────────────
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  subject text not null check (length(subject) between 3 and 140),
  category text not null check (category in ('question','problem','urgent','feature','account')),
  status text not null default 'open' check (status in ('open','answered','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists support_messages (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  author uuid references auth.users(id) on delete set null,
  from_solara boolean not null default false,
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists support_tickets_org on support_tickets(org_id, updated_at desc);
create index if not exists support_tickets_status on support_tickets(status, updated_at desc);
create index if not exists support_messages_ticket on support_messages(ticket_id, created_at);
alter table support_tickets enable row level security;
alter table support_messages enable row level security;
revoke all on support_tickets, support_messages from anon, authenticated;

create or replace function support_thread(t support_tickets) returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'body',m.body,'from_solara',m.from_solara,'at',m.created_at,
    'author',(select email from auth.users where id=m.author)) order by m.created_at),'[]') from support_messages m where m.ticket_id=t.id $$;
revoke execute on function support_thread(support_tickets) from public, anon, authenticated;

create or replace function support_create(p_org uuid, p_subject text, p_category text, p_body text) returns uuid
language plpgsql security definer set search_path=public as $$
declare t uuid;
begin
  if not is_member(p_org) then raise exception 'Not a member of this clinic' using errcode='42501'; end if;
  perform throttle('support:'||auth.uid(), 10, 3600);
  insert into support_tickets(org_id,created_by,subject,category) values (p_org,auth.uid(),trim(p_subject),p_category) returning id into t;
  insert into support_messages(ticket_id,author,body) values (t,auth.uid(),trim(p_body));
  return t;
exception when check_violation then
  raise exception 'Add a subject (3 to 140 characters) and a message.' using errcode='22023';
end $$;

create or replace function support_mine(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_member(p_org) then raise exception 'Not a member of this clinic' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('messages',support_thread(t)) order by t.status='closed', t.updated_at desc)
    from support_tickets t where t.org_id=p_org),'[]');
end $$;

create or replace function support_reply(p_ticket uuid, p_body text, p_as_solara boolean default false) returns void
language plpgsql security definer set search_path=public as $$
declare t support_tickets; solara boolean;
begin
  select * into t from support_tickets where id=p_ticket;
  if t.id is null or not (is_member(t.org_id) or is_platform_admin()) then raise exception 'Ticket not found.' using errcode='PT404'; end if;
  -- Solara support = a platform admin answering from the Admin support inbox.
  solara := coalesce(p_as_solara,false) and is_platform_admin();
  if not solara and not is_member(t.org_id) then raise exception 'Ticket not found.' using errcode='PT404'; end if;
  if length(trim(coalesce(p_body,'')))=0 then raise exception 'Write a reply first.' using errcode='22023'; end if;
  perform throttle('support:'||auth.uid(), 60, 3600);
  insert into support_messages(ticket_id,author,from_solara,body) values (p_ticket,auth.uid(),solara,trim(p_body));
  update support_tickets set status=case when solara then 'answered' else 'open' end, updated_at=now() where id=p_ticket;
end $$;

create or replace function support_set_status(p_ticket uuid, p_status text) returns void
language plpgsql security definer set search_path=public as $$
declare t support_tickets;
begin
  select * into t from support_tickets where id=p_ticket;
  if t.id is null or not (is_member(t.org_id) or is_platform_admin()) then raise exception 'Ticket not found.' using errcode='PT404'; end if;
  if p_status not in ('open','closed') then raise exception 'Status must be open or closed.' using errcode='22023'; end if;
  update support_tickets set status=p_status, updated_at=now() where id=p_ticket;
end $$;

create or replace function admin_support(p_status text default null) returns jsonb
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('clinic',o.name,'messages',support_thread(t))
      order by case t.status when 'open' then 0 when 'answered' then 1 else 2 end, case when t.category='urgent' then 0 else 1 end, t.updated_at desc)
    from support_tickets t join organizations o on o.id=t.org_id where p_status is null or t.status=p_status),'[]');
end $$;

-- ── Setup checklist ──────────────────────────────────────────────────────────
create or replace function setup_status(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare s settings;
begin
  if not is_member(p_org) then raise exception 'Not a member of this clinic' using errcode='42501'; end if;
  select * into s from settings where org_id=p_org;
  return jsonb_build_array(
    jsonb_build_object('key','hours','label','Set your opening hours','href','/knowledge','done',coalesce(s.hours,'{}'::jsonb)<>'{}'::jsonb),
    jsonb_build_object('key','handoff','label','Add the phone number patients are given when a person takes over','href','/settings','done',coalesce(s.handoff_phone,'')<>''),
    jsonb_build_object('key','answers','label','Add at least 5 answers to common questions','href','/knowledge',
      'done',(select count(*) from kb where org_id=p_org and not coalesce(managed,false))>=5),
    jsonb_build_object('key','team','label','Invite your team','href','/settings#team',
      'done',(select count(*) from members where org_id=p_org)>1 or exists(select 1 from team_invites where org_id=p_org)),
    jsonb_build_object('key','website','label','Allow your website','href','/install',
      'done',(select cardinality(widget_origins) from organizations where id=p_org)>0),
    jsonb_build_object('key','live','label','Put the chat on your website','href','/install',
      'done',exists(select 1 from widget_installs where org_id=p_org and last_seen>now()-interval '14 days')),
    jsonb_build_object('key','test','label','Try a test chat as a patient','href','/demo',
      'done',exists(select 1 from conversations where org_id=p_org)));
end $$;

do $$ declare f text; begin
  foreach f in array array['team_list(uuid)','team_invite(uuid,text,text)','team_revoke_invite(uuid)','accept_invite(text)','team_set_role(uuid,uuid,text)',
    'team_remove(uuid,uuid)','support_create(uuid,text,text,text)','support_mine(uuid)','support_reply(uuid,text,boolean)','support_set_status(uuid,text)',
    'admin_support(text)','setup_status(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
