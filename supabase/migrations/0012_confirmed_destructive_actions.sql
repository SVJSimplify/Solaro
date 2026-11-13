-- Destructive actions need a human confirmation. A doctor can only be deleted by redeeming a short-lived, single-use token
-- that is bound to the signed-in user, the organisation and the exact doctor. Tokens are issued only to that user's session
-- and are never shown to the model. Imports run in one transaction and never delete doctors.

create table if not exists action_confirmations(
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null,
  action text not null check (action in ('delete_doctor')),
  target_id uuid not null,
  target_label text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now());
alter table action_confirmations enable row level security;  -- no policies: only the functions below touch it
revoke all on action_confirmations from public, anon, authenticated;

-- Doctors: owners and admins may add and edit, but nobody deletes directly over the API.
drop policy if exists manager_write on doctors;
drop policy if exists manager_insert on doctors;
drop policy if exists manager_update on doctors;
create policy manager_insert on doctors for insert to authenticated with check (can_manage(org_id));
create policy manager_update on doctors for update to authenticated using (can_manage(org_id)) with check (can_manage(org_id));
revoke delete on doctors from public, anon, authenticated;

create or replace function request_doctor_deletion(p_org uuid, p_doctor uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare d doctors; tok text; n int; tz text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  if not can_manage(p_org) then raise exception 'Only an owner or admin can remove doctors' using errcode='42501'; end if;
  select * into d from doctors where id=p_doctor and org_id=p_org;
  if not found then raise exception 'Doctor not found' using errcode='P0002'; end if;
  select coalesce(timezone,'UTC') into tz from organizations where id=p_org;
  select count(*) into n from bookings where org_id=p_org and doctor_id=d.id and status<>'cancelled' and starts_at>=(now() at time zone coalesce(tz,'UTC'));
  tok:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
  delete from action_confirmations where expires_at<now()-interval '1 day';
  insert into action_confirmations(token_hash,org_id,user_id,action,target_id,target_label,expires_at)
    values(encode(sha256(convert_to(tok,'UTF8')),'hex'),p_org,auth.uid(),'delete_doctor',d.id,d.name,now()+interval '5 minutes');
  perform write_audit(p_org,'doctor.delete_requested','doctor',d.id,jsonb_build_object('name',d.name));
  return jsonb_build_object('token',tok,'doctor_id',d.id,'doctor',d.name,'specialty',d.specialty,'upcoming_bookings',n,'expires_in',300);
end $$;
revoke all on function request_doctor_deletion(uuid,uuid) from public, anon;
grant execute on function request_doctor_deletion(uuid,uuid) to authenticated;

create or replace function confirm_doctor_deletion(p_org uuid, p_token text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare r action_confirmations;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  update action_confirmations set used_at=now()
   where token_hash=encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex')
     and action='delete_doctor' and user_id=auth.uid() and org_id=p_org and used_at is null and expires_at>now()
   returning * into r;
  if not found then raise exception 'This confirmation is invalid, expired or already used' using errcode='42501'; end if;
  if not can_manage(r.org_id) then raise exception 'Only an owner or admin can remove doctors' using errcode='42501'; end if;
  delete from doctors where id=r.target_id and org_id=r.org_id;
  if not found then raise exception 'That doctor no longer exists' using errcode='P0002'; end if;
  perform write_audit(r.org_id,'doctor.deleted','doctor',r.target_id,jsonb_build_object('name',r.target_label,'confirmation',r.id));
  return jsonb_build_object('removed',r.target_label);
end $$;
revoke all on function confirm_doctor_deletion(uuid,text) from public, anon;
grant execute on function confirm_doctor_deletion(uuid,text) to authenticated;

-- Imports: one transaction. Existing doctors and answers are kept; a name or topic that already exists is skipped,
-- unless p_replace is true (the user ticked "update existing"), in which case it is updated in place. Nothing is deleted.
create or replace function import_setup(p_org uuid, p_doctors jsonb, p_answers jsonb, p_replace boolean default false) returns jsonb
language plpgsql security definer set search_path=public as $$
declare x jsonb; hit uuid; a int:=0; u int:=0; s int:=0; ka int:=0; ku int:=0; ks int:=0; nm text;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  if not can_manage(p_org) then raise exception 'Only an owner or admin can import setup' using errcode='42501'; end if;
  if jsonb_typeof(coalesce(p_doctors,'[]'))<>'array' or jsonb_typeof(coalesce(p_answers,'[]'))<>'array'
     or jsonb_array_length(coalesce(p_doctors,'[]'))>200 or jsonb_array_length(coalesce(p_answers,'[]'))>500
    then raise exception 'Bad import' using errcode='22023'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_doctors,'[]')) loop
    nm:=btrim(coalesce(x->>'name',''));
    if nm='' then raise exception 'Every doctor needs a name' using errcode='22023'; end if;
    select id into hit from doctors where org_id=p_org and lower(btrim(name))=lower(nm) limit 1;
    if hit is null then
      insert into doctors(org_id,name,specialty,services,days,start_time,end_time,slot)
        values(p_org,nm,coalesce(x->>'specialty',''),coalesce(array(select jsonb_array_elements_text(x->'services')),'{}'),
          coalesce(array(select jsonb_array_elements_text(x->'days')::int),'{}'),coalesce(x->>'start','09:00'),coalesce(x->>'end','17:00'),coalesce((x->>'slot')::int,30));
      a:=a+1;
    elsif p_replace then
      update doctors set specialty=coalesce(x->>'specialty',''),services=coalesce(array(select jsonb_array_elements_text(x->'services')),'{}'),
        days=coalesce(array(select jsonb_array_elements_text(x->'days')::int),'{}'),start_time=coalesce(x->>'start',start_time),end_time=coalesce(x->>'end',end_time),slot=coalesce((x->>'slot')::int,30)
       where id=hit;
      u:=u+1;
    else s:=s+1; end if;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_answers,'[]')) loop
    nm:=btrim(coalesce(x->>'title',''));
    if nm='' or btrim(coalesce(x->>'body',''))='' then raise exception 'Every answer needs a topic and text' using errcode='22023'; end if;
    select id into hit from kb where org_id=p_org and lower(btrim(title))=lower(nm) limit 1;
    if hit is null then insert into kb(org_id,title,body,keywords) values(p_org,nm,x->>'body',coalesce(x->>'keywords',''));ka:=ka+1;
    elsif p_replace then update kb set body=x->>'body',keywords=coalesce(x->>'keywords',''),starter=false where id=hit;ku:=ku+1;
    else ks:=ks+1; end if;
  end loop;
  perform write_audit(p_org,'setup.imported','org',p_org,jsonb_build_object('doctors_added',a,'doctors_updated',u,'doctors_skipped',s,'answers_added',ka,'answers_updated',ku,'answers_skipped',ks));
  return jsonb_build_object('doctors_added',a,'doctors_updated',u,'doctors_skipped',s,'answers_added',ka,'answers_updated',ku,'answers_skipped',ks);
end $$;
revoke all on function import_setup(uuid,jsonb,jsonb,boolean) from public, anon;
grant execute on function import_setup(uuid,jsonb,jsonb,boolean) to authenticated;
