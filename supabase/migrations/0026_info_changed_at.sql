-- When clinic information Solara answers from changes, stamp the clinic; the chat tells Solara to re-check (no realtime used).
alter table organizations add column if not exists info_changed_at timestamptz not null default now();
create or replace function touch_clinic_info() returns trigger
language plpgsql security definer set search_path=public as $$
declare o uuid := coalesce(new.org_id, old.org_id);
begin
  update organizations set info_changed_at=now() where id=o and info_changed_at<now();
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['kb','settings','doctors','services','closures','schedule_exceptions','business_facts'] loop
    execute format('drop trigger if exists %I on %I', t||'_touch_info', t);
    execute format('create trigger %I after insert or update or delete on %I for each row execute function touch_clinic_info()', t||'_touch_info', t);
  end loop;
end $$;
