-- Columns the app already writes locally, so the Supabase backend stores the same data.
alter table bookings
  add column if not exists doctor_id uuid,
  add column if not exists doctor text not null default '',
  add column if not exists status text not null default 'booked',
  add column if not exists reminded boolean not null default false;
alter table conversations add column if not exists alerted boolean not null default false;
alter table kb add column if not exists starter boolean not null default false;

create table if not exists doctors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  specialty text not null default '',
  services text[] not null default '{}',
  days int[] not null default '{}',
  start_time text not null default '08:00',
  end_time text not null default '17:00',
  slot int not null default 30,
  created_at timestamptz not null default now()
);
create table if not exists closures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  date text not null,
  created_at timestamptz not null default now()
);
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  convo uuid references conversations(id) on delete cascade,
  customer text not null default '',
  reason text not null default 'other',
  text text not null default '',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists audit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  action text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  channel text not null,
  to_addr text not null default '',
  body text not null default '',
  status text not null default 'sent',
  created_at timestamptz not null default now()
);

do $$ begin
  alter table bookings add constraint bookings_doctor_fk foreign key (doctor_id) references doctors(id) on delete set null;
exception when duplicate_object then null; end $$;

alter table doctors enable row level security;
alter table closures enable row level security;
alter table alerts enable row level security;
alter table audit enable row level security;
alter table outbox enable row level security;
create policy tenant_all on doctors for all using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on closures for all using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on alerts for all using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on audit for all using (is_member(org_id)) with check (is_member(org_id));
create policy tenant_all on outbox for all using (is_member(org_id)) with check (is_member(org_id));

alter publication supabase_realtime add table doctors, closures, alerts, services, audit, outbox;

-- 0004: one booking per doctor and time (not per org), cancelled rows don't block rebooking.
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid='bookings'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (org_id, starts_at)';
  if c is not null then execute format('alter table bookings drop constraint %I', c); end if;
end $$;
create unique index if not exists bookings_doctor_slot_key on bookings (doctor_id, starts_at) where status <> 'cancelled' and doctor_id is not null;
