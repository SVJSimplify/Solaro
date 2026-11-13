-- Local stand-in for the Supabase platform pieces the migrations depend on. Not a copy of Supabase.
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true),''), nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'sub')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
create schema if not exists vault;
create table if not exists vault.secrets(id uuid primary key default gen_random_uuid(), name text, description text, secret text);
create or replace view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as
$$ insert into vault.secrets(name,description,secret) values(new_name,new_description,new_secret) returning id $$;
create or replace function vault.update_secret(secret_id uuid, new_secret text) returns void language sql as
$$ update vault.secrets set secret=new_secret where id=secret_id $$;
grant usage on schema public to anon, authenticated, service_role;
do $$ begin if not exists (select from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if; end $$;
-- Supabase grants table access by default; row level security then decides which rows are visible.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
