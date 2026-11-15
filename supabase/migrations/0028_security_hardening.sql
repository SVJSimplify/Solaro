-- 0028 Security hardening (pentest 2026-11-14 follow-up).
-- Every block is additive or narrows access; no patient data is changed.

-- ── 1. Column-level write lock on organizations ──────────────────────────────
-- Found during remediation: the owner_update policy let an owner write every column, including plan,
-- daily_ai_override (billing bypass) and model_secret_id (point AI calls at another clinic's stored key).
-- The app never writes this table directly; only name and timezone stay writable, everything else goes
-- through security-definer RPCs (admin_set_org_ai, widget_key_rotate, set_widget_origins).
revoke insert, update, delete, truncate on organizations from anon, authenticated;
grant update (name, timezone) on organizations to authenticated;

-- ── 2. Column-level write lock on settings ──────────────────────────────────
-- Autonomy and hours must go through set_autonomy (owner-only, typed confirmation) and set_clinic_hours.
-- Before this, an admin could write settings.autonomy='full' directly and skip both checks.
revoke insert, update, delete, truncate on settings from anon, authenticated;
grant insert (org_id, greeting, tone, handoff_phone) on settings to authenticated;
grant update (org_id, greeting, tone, handoff_phone) on settings to authenticated;

-- ── 3. No anonymous table access, no TRUNCATE for API roles ─────────────────
-- Anonymous visitors only ever use the widget RPCs. TRUNCATE ignores RLS, so API roles never get it.
do $$ declare t record; begin
  for t in select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p') loop
    execute format('revoke all on public.%I from anon', t.relname);
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t.relname);
  end loop;
end $$;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- ── 4. Functions: nothing callable anonymously except the widget RPCs ───────
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
           and p.proname not in ('widget_start','widget_info','widget_ping','widget_frame_origins') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public, anon;
-- Internal helpers: only called from other security-definer functions.
revoke execute on function clinic_day(uuid,date), clinic_now(uuid), clinic_tz(uuid) from authenticated;

-- ── 5. Rate limiting by client IP for anonymous endpoints ────────────────────
-- Cloudflare sets cf-connecting-ip and overwrites any client-supplied value, so it is preferred.
create or replace function client_ip() returns text language sql stable set search_path=public as $$
  select coalesce(
    nullif(trim(nullif(current_setting('request.headers',true),'')::json->>'cf-connecting-ip'),''),
    nullif(trim(split_part(nullif(current_setting('request.headers',true),'')::json->>'x-forwarded-for',',',1)),''),
    'unknown') $$;
revoke execute on function client_ip() from public, anon, authenticated;

-- Raised as SQLSTATE PT429 so the API answers HTTP 429.
create or replace function throttle(p_key text, p_limit int, p_window int) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not hit_rate_limit(p_key, p_limit, p_window) then
    raise exception 'Too many requests. Please wait a moment and try again.' using errcode='PT429';
  end if;
end $$;
revoke execute on function throttle(text,int,int) from public, anon, authenticated;

-- ── 6. Widget origin allowlist ───────────────────────────────────────────────
alter table organizations add column if not exists widget_origins text[] not null default '{}';
alter table organizations drop constraint if exists widget_origins_max;
alter table organizations add constraint widget_origins_max check (cardinality(widget_origins) <= 20);
-- Keep every site the chat is already running on, so nothing that works today breaks.
update organizations o set widget_origins=coalesce((select array_agg(distinct w.origin order by w.origin) from widget_installs w where w.org_id=o.id),'{}')
 where widget_origins='{}';

create or replace function widget_origin_valid(o text) returns boolean language sql immutable as $$
  select o ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$'
      or o ~ '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$' $$;

-- Owners and admins set the sites allowed to show their chat. Sites no longer allowed drop out of the install list.
create or replace function set_widget_origins(p_org uuid, p_origins text[]) returns text[]
language plpgsql security definer set search_path=public as $$
declare clean text[]; bad text;
begin
  if not can_manage(p_org) then raise exception 'Only an owner or admin can change this.' using errcode='42501'; end if;
  select coalesce(array_agg(distinct lower(rtrim(trim(x),'/')) order by lower(rtrim(trim(x),'/'))),'{}') into clean
    from unnest(coalesce(p_origins,'{}')) x where trim(x)<>'';
  select x into bad from unnest(clean) x where not widget_origin_valid(x) limit 1;
  if bad is not null then raise exception 'Not a valid website address: %. Use the form https://www.yourclinic.com', bad using errcode='22023'; end if;
  if cardinality(clean)>20 then raise exception 'Up to 20 websites.' using errcode='22023'; end if;
  update organizations set widget_origins=clean where id=p_org;
  delete from widget_installs where org_id=p_org and not (origin = any(clean));
  perform write_audit(p_org,'widget_origins','app',null,jsonb_build_object('text','Website chat allowed on: '||coalesce(nullif(array_to_string(clean,', '),''),'no websites')));
  return clean;
end $$;
revoke execute on function set_widget_origins(uuid,text[]) from public, anon;
grant execute on function set_widget_origins(uuid,text[]) to authenticated;

create or replace function widget_origins_get(p_org uuid) returns text[]
language sql stable security definer set search_path=public as $$
  select widget_origins from organizations where id=p_org and is_member(p_org) $$;
revoke execute on function widget_origins_get(uuid) from public, anon;
grant execute on function widget_origins_get(uuid) to authenticated;

-- Read by the website host (Vercel middleware) to build the chat page's frame-ancestors policy.
-- These are the public websites the clinic chose to show the chat on, so they are not secret.
create or replace function widget_frame_origins(key uuid) returns text[]
language sql stable security definer set search_path=public as $$
  select coalesce((select widget_origins from organizations where id=widget_org(key)),'{}') $$;
revoke execute on function widget_frame_origins(uuid) from public;
grant execute on function widget_frame_origins(uuid) to anon, authenticated;

-- ── 7. Widget RPCs: allowlisted telemetry + per-IP limits + proper HTTP codes ─
-- Telemetry only refreshes sites the clinic has approved, so outsiders cannot add origins.
create or replace function widget_ping(key uuid, origin text) returns void
language plpgsql security definer set search_path=public as $$
declare org uuid := widget_org(key); o text := lower(rtrim(trim(origin),'/'));
begin
  if not hit_rate_limit('ping:ip:'||client_ip(), 60, 3600) then return; end if;
  if org is null or o is null or length(o)>200 then return; end if;
  if not exists(select 1 from organizations where id=org and o = any(widget_origins)) then return; end if;
  insert into widget_installs(org_id,origin) values(org,o)
    on conflict (org_id,origin) do update set last_seen=now() where widget_installs.last_seen<now()-interval '10 minutes';
end $$;

create or replace function widget_start(key uuid) returns table(conversation_id uuid, token text, org_name text, greeting text)
language plpgsql security definer set search_path=public as $$
declare org uuid := widget_org(key); cid uuid; t text;
begin
  perform throttle('widget_start:ip:'||client_ip(), 20, 3600);
  if org is null then raise exception 'Chat is not available for this clinic.' using errcode='PT404'; end if;
  perform throttle('widget_start:org:'||org, 300, 3600);
  insert into conversations(org_id,customer,channel,status) values(org,'Website visitor','Web chat','handled') returning id into cid;
  t := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into widget_sessions(conversation_id,token_hash) values(cid, encode(sha256(t::bytea),'hex'));
  return query select cid, t, o.name, coalesce(s.greeting,'Hi! How can I help you today?')
    from organizations o left join settings s on s.org_id=o.id where o.id=org;
end $$;

create or replace function widget_info(key uuid) returns table(org_name text, greeting text)
language plpgsql security definer set search_path=public as $$
begin
  perform throttle('widget_info:ip:'||client_ip(), 300, 3600);
  return query select o.name, coalesce(s.greeting,'Hi! How can I help you today?')
    from organizations o left join settings s on s.org_id=o.id where o.id=widget_org(key);
end $$;
revoke execute on function widget_start(uuid), widget_info(uuid), widget_ping(uuid,text) from public;
grant execute on function widget_start(uuid), widget_info(uuid), widget_ping(uuid,text) to anon, authenticated;

-- ── 8. Account farming: one new clinic per confirmed email, globally throttled ─
create or replace function create_org(org_name text) returns uuid
language plpgsql security definer set search_path=public as $$
declare o uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if (select email_confirmed_at from auth.users where id=auth.uid()) is null then
    raise exception 'Please confirm your email address first.' using errcode='42501'; end if;
  if exists(select 1 from members where user_id=auth.uid()) then raise exception 'already in an organization'; end if;
  perform throttle('create_org:ip:'||client_ip(), 3, 3600);
  perform throttle('create_org:global', 60, 3600);
  insert into organizations(name) values (left(trim(org_name),120)) returning id into o;
  insert into members(org_id,user_id,role) values (o,auth.uid(),'owner');
  insert into settings(org_id) values (o);
  return o;
end $$;
revoke execute on function create_org(text) from public, anon;
grant execute on function create_org(text) to authenticated;

-- ── 9. Not-found answers HTTP 404 instead of 500 ────────────────────────────
-- PostgREST turns SQLSTATE PTxyz into HTTP xyz; P0002 had no mapping and became a 500.
do $$ declare f record; def text; begin
  for f in select p.oid from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
           and pg_get_functiondef(p.oid) like '%errcode=''P0002''%' loop
    def := replace(pg_get_functiondef(f.oid), 'errcode=''P0002''', 'errcode=''PT404''');
    execute def;
  end loop;
end $$;
