-- Per-clinic AI provider: each clinic can have its own OpenAI-compatible endpoint, model and key.
-- A clinic without its own endpoint uses the server's LLM_BASE_URL. The server's own key is only ever sent to the
-- server's endpoint (enforced in provider.ts), so a clinic endpoint can never receive it.

alter table organizations add column if not exists model_endpoint text;
alter table organizations drop constraint if exists model_endpoint_https;
alter table organizations add constraint model_endpoint_https check (
  model_endpoint is null or (
    model_endpoint ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
    -- no internal or metadata hosts
    and model_endpoint !~ '^https://(localhost|[0-9.]+|[^/]*\.(internal|local|localhost))([:/]|$)'
  ));

drop function if exists admin_list_orgs();
create function admin_list_orgs() returns table(id uuid, name text, plan text, daily_limit integer, daily_limit_override integer,
  used_today integer, key_hint text, model text, model_endpoint text, widget_enabled boolean, owner_email text, created_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  return query select o.id, o.name, o.plan, coalesce(o.daily_ai_override,p.daily_ai_limit), o.daily_ai_override, coalesce(u.calls,0),
      o.key_hint, o.model, o.model_endpoint, o.widget_enabled,
      (select au.email::text from members m join auth.users au on au.id=m.user_id where m.org_id=o.id and m.role='owner' order by m.created_at limit 1),
      o.created_at
    from organizations o join plans p on p.name=o.plan
    left join ai_usage u on u.org_id=o.id and u.day=current_date
    order by o.name;
end $$;
revoke execute on function admin_list_orgs() from public, anon;
grant execute on function admin_list_orgs() to authenticated;

-- Provider for one clinic: endpoint (blank = server default) and model (blank = server default).
create or replace function admin_set_org_provider(org uuid, p_endpoint text, p_model text) returns void
language plpgsql security definer set search_path=public as $$
declare ep text := nullif(rtrim(trim(coalesce(p_endpoint,'')),'/'),''); md text := nullif(trim(coalesce(p_model,'')),'');
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  if md is not null and md !~ '^[A-Za-z0-9._:/-]{1,80}$' then raise exception 'Model names use letters, numbers and . _ : / - only.' using errcode='22023'; end if;
  begin
    update organizations set model_endpoint=lower(substring(ep from '^https://[^/]+'))||coalesce(substring(ep from '^https://[^/]+(/.*)$'),''), model=md where id=org;
  exception when check_violation then
    raise exception 'Use the provider''s https:// API address, e.g. https://api.openai.com/v1' using errcode='22023';
  end;
  if not found then raise exception 'Clinic not found.' using errcode='PT404'; end if;
  perform write_audit(org,'admin.ai_provider','app',null,jsonb_build_object('text','AI provider set to '||coalesce(ep,'server default')||', model '||coalesce(md,'server default')));
end $$;
revoke execute on function admin_set_org_provider(uuid,text,text) from public, anon;
grant execute on function admin_set_org_provider(uuid,text,text) to authenticated;

-- Remove a clinic's own key: it goes back to the server default (only valid with the server endpoint).
create or replace function admin_clear_model_key(org uuid) returns void
language plpgsql security definer set search_path=public, vault as $$
declare sid uuid;
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  select model_secret_id into sid from organizations where id=org;
  if not found then raise exception 'Clinic not found.' using errcode='PT404'; end if;
  update organizations set model_secret_id=null, key_hint='' where id=org;
  if sid is not null then delete from vault.secrets where id=sid; end if;
  perform write_audit(org,'admin.ai_key','app',null,jsonb_build_object('text','Clinic AI key removed'));
end $$;
revoke execute on function admin_clear_model_key(uuid) from public, anon;
grant execute on function admin_clear_model_key(uuid) to authenticated;

-- Key changes are audited (never the key itself).
create or replace function admin_set_model_key(org uuid, p_key text) returns void
language plpgsql security definer set search_path=public, vault as $$
declare sid uuid; k text := trim(coalesce(p_key,''));
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  if length(k) < 8 or length(k) > 500 then raise exception 'That key does not look right.' using errcode='22023'; end if;
  select model_secret_id into sid from organizations where id=org;
  if not found then raise exception 'Clinic not found.' using errcode='PT404'; end if;
  if sid is null then
    sid := vault.create_secret(k, 'model_key_'||org::text||'_'||extract(epoch from now())::bigint, 'Model API key for one clinic');
    update organizations set model_secret_id=sid, key_hint=right(k,4) where id=org;
  else
    perform vault.update_secret(sid, k);
    update organizations set key_hint=right(k,4) where id=org;
  end if;
  perform write_audit(org,'admin.ai_key','app',null,jsonb_build_object('text','Clinic AI key replaced (ends '||right(k,4)||')'));
end $$;
revoke execute on function admin_set_model_key(uuid,text) from public, anon;
grant execute on function admin_set_model_key(uuid,text) to authenticated;
