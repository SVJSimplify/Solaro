-- Clinic opening hours. Every doctor's hours sit inside them; changing them updates every doctor at once,
-- and the doctor -> schedule sync then carries the change to slots, bookings checks, the widget and Solara.
alter table settings add column if not exists open_days int[];
alter table settings add column if not exists open_start text;
alter table settings add column if not exists open_end text;

-- Start from what clinics already have: the span of their doctors' hours (so nothing is cut).
insert into settings(org_id) select o.id from organizations o where not exists(select 1 from settings s where s.org_id=o.id);
update settings s set
  open_days=coalesce(d.days,'{1,2,3,4,5}'), open_start=coalesce(d.st,'08:00'), open_end=coalesce(d.en,'17:00')
from (select o.id,
        (select array_agg(distinct x order by x) from doctors dd, unnest(dd.days) x where dd.org_id=o.id) days,
        (select min(start_time) from doctors dd where dd.org_id=o.id) st,
        (select max(end_time) from doctors dd where dd.org_id=o.id) en
      from organizations o) d
where d.id=s.org_id and s.open_start is null;
alter table settings alter column open_days set default '{1,2,3,4,5}';
alter table settings alter column open_start set default '08:00';
alter table settings alter column open_end set default '17:00';
alter table settings drop constraint if exists settings_hours_ok;
alter table settings add constraint settings_hours_ok check (
  open_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and open_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and open_start<open_end
  and open_days <@ '{0,1,2,3,4,5,6}' and cardinality(open_days)>0);

-- A doctor's hours are kept inside the clinic's: new doctors default to the full clinic hours,
-- edits are clamped, and a doctor left with no time inside them is refused.
create or replace function doctor_within_clinic() returns trigger
language plpgsql security definer set search_path=public as $$
declare s settings;
begin
  select * into s from settings where org_id=new.org_id;
  if s.open_start is null then return new; end if;
  if tg_op='INSERT' and (new.days is null or new.days='{}') then new.days:=s.open_days; end if;
  if tg_op='INSERT' and new.start_time='08:00' and new.end_time='17:00' then new.start_time:=s.open_start; new.end_time:=s.open_end; end if;
  new.days:=coalesce((select array_agg(x order by x) from unnest(new.days) x where x=any(s.open_days)),'{}');
  new.start_time:=greatest(new.start_time,s.open_start);
  new.end_time:=least(new.end_time,s.open_end);
  if new.start_time>=new.end_time or new.days='{}' then
    raise exception 'Doctor hours must be inside the clinic hours (% to %)', s.open_start, s.open_end;
  end if;
  return new;
end $$;
drop trigger if exists doctors_within_clinic on doctors;
create trigger doctors_within_clinic before insert or update on doctors for each row execute function doctor_within_clinic();

-- When the clinic changes its hours, doctors who worked the full old hours follow the new ones;
-- everyone else is clamped. A doctor with nothing left gets the full new hours rather than vanishing.
create or replace function clinic_hours_changed() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if old.open_start is not distinct from new.open_start and old.open_end is not distinct from new.open_end
     and old.open_days is not distinct from new.open_days then return new; end if;
  with c as (select d.id,
      case when old.open_start is null or d.start_time<=old.open_start then new.open_start else greatest(d.start_time,new.open_start) end st,
      case when old.open_end is null or d.end_time>=old.open_end then new.open_end else least(d.end_time,new.open_end) end en,
      case when old.open_days is null or d.days @> old.open_days then new.open_days
           else coalesce((select array_agg(x order by x) from unnest(d.days) x where x=any(new.open_days)),'{}') end dy
    from doctors d where d.org_id=new.org_id)
  update doctors d set
    start_time=case when c.st<c.en and c.dy<>'{}' then c.st else new.open_start end,
    end_time=case when c.st<c.en and c.dy<>'{}' then c.en else new.open_end end,
    days=case when c.st<c.en and c.dy<>'{}' then c.dy else new.open_days end
  from c where c.id=d.id;
  return new;
end $$;
drop trigger if exists settings_hours_changed on settings;
create trigger settings_hours_changed after update on settings for each row execute function clinic_hours_changed();
-- Website chats show the patient's name and phone in the inbox once they give them.
update conversations c set customer=left(b.name||' · '||b.phone,120)
from (select distinct on (conversation_id) conversation_id,name,phone from bookings where conversation_id is not null order by conversation_id,created_at desc) b
where b.conversation_id=c.id and c.customer='Website visitor';
