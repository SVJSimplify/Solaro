create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null check (length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);
alter table services enable row level security;
create policy tenant_all on services for all using (is_member(org_id)) with check (is_member(org_id));
