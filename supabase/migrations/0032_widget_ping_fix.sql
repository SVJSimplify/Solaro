-- 0028 introduced "on conflict (org_id,origin)", which clashes with the parameter named origin (42702) and made every ping fail.
create or replace function widget_ping(key uuid, origin text) returns void
language plpgsql security definer set search_path=public as $$
declare org uuid := widget_org(key); o text := lower(rtrim(trim(widget_ping.origin),'/'));
begin
  if not hit_rate_limit('ping:ip:'||client_ip(), 60, 3600) then return; end if;
  if org is null or o is null or length(o)>200 then return; end if;
  if not exists(select 1 from organizations g where g.id=org and o = any(g.widget_origins)) then return; end if;
  insert into widget_installs as w (org_id, origin) values (org, o)
    on conflict on constraint widget_installs_pkey do update set last_seen=now() where w.last_seen < now()-interval '10 minutes';
end $$;
revoke execute on function widget_ping(uuid,text) from public;
grant execute on function widget_ping(uuid,text) to anon, authenticated;
