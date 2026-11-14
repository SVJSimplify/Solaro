-- Where each clinic's website chat is installed, reported by embed.js on page load.
create table if not exists widget_installs(
  org_id uuid not null references organizations(id) on delete cascade,
  origin text not null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key(org_id, origin)
);
alter table widget_installs enable row level security;
drop policy if exists widget_installs_read on widget_installs;
create policy widget_installs_read on widget_installs for select
  using (exists(select 1 from members m where m.org_id=widget_installs.org_id and m.user_id=auth.uid()));

-- Public ping: validates input, caps 20 origins per clinic, writes at most once per 10 minutes per origin.
create or replace function widget_ping(org uuid, origin text) returns void
language plpgsql security definer set search_path=public as $$
declare o text := lower(trim(origin));
begin
  if o is null or length(o)>200 or o !~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' then return; end if;
  if not exists(select 1 from organizations where id=org) then return; end if;
  if exists(select 1 from widget_installs w where w.org_id=org and w.origin=o) then
    update widget_installs set last_seen=now() where org_id=org and widget_installs.origin=o and last_seen<now()-interval '10 minutes';
  elsif (select count(*) from widget_installs w where w.org_id=org)<20 then
    insert into widget_installs(org_id,origin) values(org,o) on conflict do nothing;
  end if;
end $$;
revoke all on function widget_ping(uuid,text) from public;
grant execute on function widget_ping(uuid,text) to anon, authenticated;
