-- Plans set each clinic's daily AI allowance. Platform admins manage plans, per-clinic model keys (stored in Vault) and limits.
-- Website chat: visitors get a session token (only its hash is stored) and never sign in.
-- Note: organizations.plan already existed (default 'trial'). The 'trial' plan and foreign key below were added after the first apply.

create table if not exists plans(
  name text primary key,
  label text not null,
  daily_ai_limit int not null check (daily_ai_limit > 0));
insert into plans(name,label,daily_ai_limit) values ('starter','Starter',100),('growth','Growth',500),('scale','Scale',2000) on conflict (name) do nothing;
insert into plans(name,label,daily_ai_limit) values ('trial','Trial',50) on conflict (name) do nothing;
alter table plans enable row level security;
create policy plans_read on plans for select to authenticated using (true);

alter table organizations
  add column if not exists plan text not null default 'trial',
  add column if not exists daily_ai_override int check (daily_ai_override > 0),
  add column if not exists model text not null default '',
  add column if not exists key_hint text not null default '',
  add column if not exists model_secret_id uuid,
  add column if not exists widget_enabled boolean not null default true;
alter table organizations alter column plan set default 'trial';
update organizations set plan='trial' where plan not in (select name from plans);
alter table organizations add constraint organizations_plan_fkey foreign key (plan) references plans(name);

create table if not exists platform_admins(user_id uuid primary key references auth.users on delete cascade);
alter table platform_admins enable row level security;

create or replace function is_platform_admin() returns boolean
language sql stable security definer set search_path=public as
$$ select exists(select 1 from platform_admins where user_id=auth.uid()) $$;
revoke all on function is_platform_admin() from public,anon;
grant execute on function is_platform_admin() to authenticated;

create table if not exists ai_usage(
  org_id uuid references organizations on delete cascade,
  day date not null default current_date,
  calls int not null default 0,
  primary key(org_id,day));
alter table ai_usage enable row level security;
create policy usage_read on ai_usage for select to authenticated using (is_member(org_id));

-- Platform admin functions. Each one checks is_platform_admin() itself.
create or replace function admin_set_org_ai(org uuid, p_plan text, p_override int, p_model text, p_widget boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  update organizations set plan=p_plan, daily_ai_override=p_override,
    model=coalesce(p_model,model), widget_enabled=coalesce(p_widget,widget_enabled)
    where id=org;
  if not found then raise exception 'Clinic not found'; end if;
end $$;

-- Stores or replaces a clinic's model key in Vault. The key is never returned to the app; only the last four characters are shown.
create or replace function admin_set_model_key(org uuid, p_key text)
returns void language plpgsql security definer set search_path=public, vault as $$
declare sid uuid; k text := trim(coalesce(p_key,''));
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  if length(k) < 8 then raise exception 'That key looks too short'; end if;
  select model_secret_id into sid from organizations where id=org;
  if not found then raise exception 'Clinic not found'; end if;
  if sid is null then
    sid := vault.create_secret(k, 'model_key_'||org::text, 'Model API key for one clinic');
    update organizations set model_secret_id=sid, key_hint=right(k,4) where id=org;
  else
    perform vault.update_secret(sid, k);
    update organizations set key_hint=right(k,4) where id=org;
  end if;
end $$;
revoke all on function admin_set_org_ai(uuid,text,int,text,boolean) from public,anon;
revoke all on function admin_set_model_key(uuid,text) from public,anon;
grant execute on function admin_set_org_ai(uuid,text,int,text,boolean) to authenticated;
grant execute on function admin_set_model_key(uuid,text) to authenticated;

-- Server-only (service role): decrypt one clinic's key, and count one AI call against today's limit.
create or replace function get_model_key(org uuid) returns text
language sql stable security definer set search_path=public, vault as
$$ select ds.decrypted_secret from organizations o join vault.decrypted_secrets ds on ds.id=o.model_secret_id where o.id=org $$;

create or replace function consume_ai_call(org uuid) returns boolean
language plpgsql security definer set search_path=public as $$
declare lim int; used int;
begin
  select coalesce(o.daily_ai_override,p.daily_ai_limit) into lim
    from organizations o join plans p on p.name=o.plan where o.id=org;
  if lim is null then return false; end if;
  insert into ai_usage(org_id,day,calls) values(org,current_date,0) on conflict do nothing;
  update ai_usage set calls=calls+1 where org_id=org and day=current_date and calls<lim returning calls into used;
  return used is not null;
end $$;
revoke all on function get_model_key(uuid) from public,anon,authenticated;
revoke all on function consume_ai_call(uuid) from public,anon,authenticated;
grant execute on function get_model_key(uuid) to service_role;
grant execute on function consume_ai_call(uuid) to service_role;

create table if not exists widget_sessions(
  conversation_id uuid primary key references conversations on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now());
alter table widget_sessions enable row level security;

create or replace function widget_start(org uuid)
returns table(conversation_id uuid, token text, org_name text, greeting text)
language plpgsql security definer set search_path=public as $$
declare cid uuid; t text; recent int;
begin
  perform 1 from organizations o where o.id=org and o.widget_enabled;
  if not found then raise exception 'Chat is not available for this clinic'; end if;
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
