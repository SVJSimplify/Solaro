-- The "Hours" knowledge answer is written from the clinic hours (Settings), so Solara's answer and the open times always match.
create or replace function fmt_hm(t text) returns text language sql immutable as $$
  select ltrim(to_char(t::time,'HH12'),'0')||case when to_char(t::time,'MI')='00' then '' else ':'||to_char(t::time,'MI') end||lower(to_char(t::time,'am')) $$;
create or replace function hours_text(days int[], st text, en text) returns text language plpgsql immutable as $$
declare n text[]:=array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  d int[]:=(select array_agg(x order by x) from unnest(days) x); runs text[]:='{}'; i int; a int; closed text[]:='{}';
begin
  i:=1;
  while i<=coalesce(array_length(d,1),0) loop
    a:=i; while i<array_length(d,1) and d[i+1]=d[i]+1 loop i:=i+1; end loop;
    runs:=runs||case when i-a>=2 then n[d[a]+1]||' to '||n[d[i]+1] when i>a then n[d[a]+1]||' and '||n[d[i]+1] else n[d[a]+1] end;
    i:=i+1;
  end loop;
  select array_agg(n[x+1] order by x) into closed from generate_series(0,6) x where not x=any(days);
  return 'Open '||array_to_string(runs,', ')||', '||fmt_hm(st)||' to '||fmt_hm(en)||'.'||
    case when closed is null then '' else ' Closed '||array_to_string(closed,', ')||'.' end;
end $$;
create or replace function sync_hours_answer() returns trigger
language plpgsql security definer set search_path=public as $$
declare txt text;
begin
  if new.open_start is null then return new; end if;
  txt:=hours_text(new.open_days,new.open_start,new.open_end);
  update kb set body=txt where org_id=new.org_id and lower(title)='hours' and body is distinct from txt;
  if not found and not exists(select 1 from kb where org_id=new.org_id and lower(title)='hours') then
    insert into kb(org_id,title,body,keywords) values(new.org_id,'Hours',txt,'hours open opening closing time');
  end if;
  return new;
end $$;
drop trigger if exists settings_hours_answer on settings;
create trigger settings_hours_answer after insert or update of open_days,open_start,open_end on settings
  for each row execute function sync_hours_answer();
update settings set open_start=open_start;
