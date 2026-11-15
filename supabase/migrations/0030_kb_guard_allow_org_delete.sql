-- The managed Hours answer may not be deleted on its own, but must go when its clinic is deleted.
-- During the cascade the clinic row is already gone, so its absence marks a clinic deletion.
create or replace function public.kb_guard_managed() returns trigger
language plpgsql security definer set search_path to 'public' as $function$
begin
  if current_setting('solara.hours_sync',true)='on' then return coalesce(new,old); end if;
  if tg_op='DELETE' and old.managed and exists(select 1 from organizations where id=old.org_id) then
    raise exception 'Clinic hours are edited in the hours section of Knowledge.' using errcode='P0001'; end if;
  if tg_op='UPDATE' and old.managed and auth.uid() is not null and (new.body is distinct from old.body or new.title is distinct from old.title) then
    raise exception 'Clinic hours are edited in the hours section of Knowledge.' using errcode='P0001'; end if;
  return coalesce(new,old);
end $function$;
revoke execute on function public.kb_guard_managed() from public, anon, authenticated;
