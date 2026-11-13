// Existing data is copied, not moved. The booking engine's tables are untouched. Re-running the backfill adds nothing.
// Run against a database built to just before 0008 (see tests/README.md).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {connect} from './helpers.mjs';

const MIGRATION=new URL('../../supabase/migrations/0008_information.sql',import.meta.url);
const sql=fs.readFileSync(MIGRATION,'utf8');
const backfillSection=sql.slice(sql.indexOf('-- Backfill from the existing tables.'));
const preflightBlock=backfillSection.slice(0,backfillSection.indexOf('insert into business_entities'));

let c, org;
before(async()=>{
  c=await connect();
  org=(await c.query("insert into organizations(name) values('Legacy Clinic') returning id")).rows[0].id;
  await c.query("insert into doctors(org_id,name,specialty,services,days,start_time,end_time,slot) values($1,'Dr. Anita Rao','General','{Cleaning,Exam}','{1,2,3,4,5}','08:00','16:00',30)",[org]);
  await c.query("insert into doctors(org_id,name,specialty,services,days,start_time,end_time,slot) values($1,'Dr. Imran Sheikh','Restorative','{Exam}','{1,3,5,6}','10:00','18:00',30)",[org]);
  await c.query("insert into kb(org_id,title,body) values($1,'Parking','Free on site'),($1,'parking','Behind the building')",[org]);
  await c.query("insert into closures(org_id,date) values($1,'2026-12-25')",[org]);
  // Run the migration as the local test does: whole file, in order.
  await c.query(sql);
});
after(async()=>{await c?.end()});

test('B1 knowledge rows are kept and copied into business facts, with duplicate titles made unique', async()=>{
  const kb=(await c.query('select count(*)::int n from kb where org_id=$1',[org])).rows[0].n;
  assert.equal(kb,2,'legacy kb rows must still exist');
  const facts=(await c.query("select key,value,status,source from business_facts where org_id=$1 and source='legacy_kb' order by key",[org])).rows;
  assert.equal(facts.length,2);
  assert.ok(facts.every(f=>f.status==='confirmed'));
  assert.equal(new Set(facts.map(f=>f.key)).size,2,'keys must be unique');
});

test('B2 doctors are mirrored as entities and their weekly hours become rules that match the booking engine', async()=>{
  const docs=(await c.query('select count(*)::int n from doctors where org_id=$1',[org])).rows[0].n;
  assert.equal(docs,2,'legacy doctors must still exist');
  const ents=(await c.query("select count(*)::int n from business_entities where org_id=$1 and kind='doctor'",[org])).rows[0].n;
  assert.equal(ents,2);
  const anita=(await c.query(`select r.weekday,r.start_min,r.end_min,r.slot_minutes from schedule_rules r join business_entities e on e.id=r.entity_id
    where e.org_id=$1 and e.normalized_name='dr. anita rao' order by r.weekday`,[org])).rows;
  assert.deepEqual(anita.map(r=>r.weekday),[1,2,3,4,5],'Mon to Fri, Sunday=0 as in schedule.js');
  assert.ok(anita.every(r=>r.start_min===480&&r.end_min===960&&r.slot_minutes===30),'08:00 to 16:00 in minutes');
  const imran=(await c.query(`select count(*)::int n from schedule_rules r join business_entities e on e.id=r.entity_id where e.org_id=$1 and e.normalized_name='dr. imran sheikh'`,[org])).rows[0].n;
  assert.equal(imran,4,'Mon, Wed, Fri and Sat');
});

test('B3 clinic closures are copied as closure exceptions', async()=>{
  const r=(await c.query("select on_date::text d,kind,status,entity_id from schedule_exceptions where org_id=$1 and source='legacy_closures'",[org])).rows;
  assert.equal(r.length,1);
  assert.equal(r[0].d,'2026-12-25');
  assert.equal(r[0].kind,'closure');
  assert.equal(r[0].status,'confirmed');
  assert.equal(r[0].entity_id,null);
  assert.equal((await c.query('select count(*)::int n from closures where org_id=$1',[org])).rows[0].n,1,'legacy closure kept');
});

test('B4 re-running the backfill adds nothing (idempotent)', async()=>{
  const count=async()=>(await c.query(`select (select count(*) from business_entities where org_id=$1)+(select count(*) from schedule_rules where org_id=$1)+(select count(*) from schedule_exceptions where org_id=$1)+(select count(*) from business_facts where org_id=$1) as n`,[org])).rows[0].n;
  const before=await count();
  await c.query(backfillSection);
  assert.equal(await count(),before);
});

test('B5 a duplicate doctor name stops the migration instead of losing a doctor', async()=>{
  const other=(await c.query("insert into organizations(name) values('Dup Clinic') returning id")).rows[0].id;
  // The pre-flight groups on the normalised name, so 'Dr. Lee' and 'dr.  lee' collide.
  await c.query("insert into doctors(org_id,name) values($1,'Dr. Lee'),($1,'dr.  lee')",[other]);
  await assert.rejects(c.query(preflightBlock),/Duplicate doctor name/);
  await c.query('delete from doctors where org_id=$1',[other]);
  await c.query('delete from organizations where id=$1',[other]);
});
