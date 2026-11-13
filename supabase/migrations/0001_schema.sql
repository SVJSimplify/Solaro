-- Solara schema: every business is an organization; every row carries org_id; RLS enforces isolation.
create table organizations(
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'trial',
  created_at timestamptz not null default now());

create table members(
  org_id uuid not null references organizations on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','staff')),
  created_at timestamptz not null default now(),
  primary key (org_id,user_id));

create table settings(
  org_id uuid primary key references organizations on delete cascade,
  greeting text not null default 'Hi! How can I help you today?',
  tone text not null default 'friendly',
  handoff_phone text);

create table kb(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  title text not null, body text not null, keywords text not null default '',
  created_at timestamptz not null default now());

create table conversations(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  customer text not null,
  channel text not null default 'Web chat',
  status text not null default 'handled' check (status in ('handled','handoff')),
  created_at timestamptz not null default now());

create table messages(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  conversation_id uuid not null references conversations on delete cascade,
  role text not null check (role in ('cust','bot','staff')),
  body text not null,
  created_at timestamptz not null default now());

-- starts_at is the business's wall-clock time (no timezone) for now; add organizations.timezone before sending reminders.
create table bookings(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations on delete cascade,
  name text not null, phone text not null, service text not null,
  starts_at timestamp not null,
  created_at timestamptz not null default now(),
  unique (org_id,starts_at));  -- database-level double-booking guard

create index on members(user_id);
create index on kb(org_id);
create index on conversations(org_id,created_at desc);
create index on messages(conversation_id,created_at);
create index on bookings(org_id,starts_at);

create function is_member(o uuid) returns boolean
language sql stable security definer set search_path=public as
$$ select exists(select 1 from members where org_id=o and user_id=auth.uid()) $$;
revoke all on function is_member(uuid) from public,anon;
grant execute on function is_member(uuid) to authenticated;

alter table organizations enable row level security;
alter table members enable row level security;
alter table settings enable row level security;
alter table kb enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table bookings enable row level security;

create policy org_read on organizations for select to authenticated using (is_member(id));
create policy org_update on organizations for update to authenticated using (is_member(id)) with check (is_member(id));
create policy members_read on members for select to authenticated using (user_id=auth.uid());
create policy tenant_all on settings for all to authenticated using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on kb for all to authenticated using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on conversations for all to authenticated using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on messages for all to authenticated using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on bookings for all to authenticated using (is_member(org_id)) with check (is_member(org_id));

-- The only way to create an organization: caller becomes its owner.
create function create_org(org_name text) returns uuid
language plpgsql security definer set search_path=public as $$
declare o uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists(select 1 from members where user_id=auth.uid()) then raise exception 'already in an organization'; end if;
  insert into organizations(name) values (left(trim(org_name),120)) returning id into o;
  insert into members(org_id,user_id,role) values (o,auth.uid(),'owner');
  insert into settings(org_id) values (o);
  return o;
end $$;
revoke all on function create_org(text) from public,anon;
grant execute on function create_org(text) to authenticated;

alter publication supabase_realtime add table conversations, messages, bookings, kb;
