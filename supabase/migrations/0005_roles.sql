-- Role-based access. Every member can read their clinic's data and work the inbox and bookings.
-- Only owners and admins can change clinic settings, knowledge, services and doctors, and only owners can change the organization.

create or replace function my_role(o uuid) returns text
language sql stable security definer set search_path=public as
$$ select role from members where org_id=o and user_id=auth.uid() $$;
revoke all on function my_role(uuid) from public,anon;
grant execute on function my_role(uuid) to authenticated;

create or replace function can_manage(o uuid) returns boolean
language sql stable security definer set search_path=public as
$$ select coalesce(my_role(o) in ('owner','admin'), false) $$;
revoke all on function can_manage(uuid) from public,anon;
grant execute on function can_manage(uuid) to authenticated;

-- Settings, knowledge, services, doctors: everyone reads, owners and admins write.
drop policy if exists tenant_all on settings;
create policy member_read on settings for select to authenticated using (is_member(org_id));
create policy manager_write on settings for all to authenticated using (can_manage(org_id)) with check (can_manage(org_id));

drop policy if exists tenant_all on kb;
create policy member_read on kb for select to authenticated using (is_member(org_id));
create policy manager_write on kb for all to authenticated using (can_manage(org_id)) with check (can_manage(org_id));

drop policy if exists tenant_all on services;
create policy member_read on services for select to authenticated using (is_member(org_id));
create policy manager_write on services for all to authenticated using (can_manage(org_id)) with check (can_manage(org_id));

drop policy if exists tenant_all on doctors;
create policy member_read on doctors for select to authenticated using (is_member(org_id));
create policy manager_write on doctors for all to authenticated using (can_manage(org_id)) with check (can_manage(org_id));

-- Organization: only owners change it.
drop policy if exists org_update on organizations;
create policy owner_update on organizations for update to authenticated
  using (my_role(id)='owner') with check (my_role(id)='owner');
