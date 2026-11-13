-- The admin clinic list also returns the saved daily-limit override, so the panel can show it.
drop function if exists admin_list_orgs();
create function admin_list_orgs()
returns table(id uuid, name text, plan text, daily_limit int, daily_limit_override int, used_today int, key_hint text, model text, widget_enabled boolean)
language plpgsql stable security definer set search_path=public as $$
begin
  if not is_platform_admin() then raise exception 'Not a platform admin' using errcode='42501'; end if;
  return query select o.id, o.name, o.plan, coalesce(o.daily_ai_override,p.daily_ai_limit), o.daily_ai_override, coalesce(u.calls,0), o.key_hint, o.model, o.widget_enabled
    from organizations o join plans p on p.name=o.plan
    left join ai_usage u on u.org_id=o.id and u.day=current_date
    order by o.name;
end $$;
revoke all on function admin_list_orgs() from public,anon;
grant execute on function admin_list_orgs() to authenticated;
