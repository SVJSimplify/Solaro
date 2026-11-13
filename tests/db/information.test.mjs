// Phase 1 acceptance tests: structured information, isolation, corrections, history, contradictions, expiry, backfill.
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/db/
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {connect,asUser,expectPgError} from './helpers.mjs';

let c;
const ids={};
before(async()=>{
  c=await connect();
  // Two clinics. Owner and staff of clinic A, owner of clinic B.
  const q=(s,p)=>c.query(s,p).then(r=>r.rows);
  const org=async n=>(await q('insert into organizations(name) values($1) returning id',[n]))[0].id;
  const user=async e=>(await q('insert into auth.users(email) values($1) returning id',[e]))[0].id;
  ids.orgA=await org('Clinic A'); ids.orgB=await org('Clinic B');
  ids.ownerA=await user('owner-a@test'); ids.staffA=await user('staff-a@test'); ids.ownerB=await user('owner-b@test');
  await q("insert into members(org_id,user_id,role) values($1,$2,'owner'),($1,$3,'staff'),($4,$5,'owner')",[ids.orgA,ids.ownerA,ids.staffA,ids.orgB,ids.ownerB]);
  ids.drA=(await q("insert into business_entities(org_id,kind,name,normalized_name) values($1,'doctor','Dr. Sharma','dr. sharma') returning id",[ids.orgA]))[0].id;
  ids.drB=(await q("insert into business_entities(org_id,kind,name,normalized_name) values($1,'doctor','Dr. Other','dr. other') returning id",[ids.orgB]))[0].id;
  ids.factA=(await q("insert into business_facts(org_id,category,key,value,status,source) values($1,'profile','Phone','555-0100','confirmed','manual') returning id",[ids.orgA]))[0].id;
  ids.factB=(await q("insert into business_facts(org_id,category,key,value,status,source) values($1,'profile','Phone','555-0900','confirmed','manual') returning id",[ids.orgB]))[0].id;
});
after(async()=>{await c?.end()});

// Each test uses its own unique key so rollbacks and reruns never collide.
let n=0; const uniq=p=>`${p}-${Date.now()}-${++n}`;

test('I1 members read only their own organisation', async()=>{
  const rows=await asUser(c,{uid:ids.ownerA},async c=>(await c.query('select org_id from business_facts')).rows);
  assert.ok(rows.length>=1);
  assert.ok(rows.every(r=>r.org_id===ids.orgA),'saw another clinic');
});

test('I2 members cannot read another clinic', async()=>{
  const rows=await asUser(c,{uid:ids.ownerA},async c=>(await c.query('select id from business_facts where org_id=$1',[ids.orgB])).rows);
  assert.equal(rows.length,0);
});

test('I3 staff cannot write a confirmed fact', async()=>{
  await asUser(c,{uid:ids.staffA},async c=>{
    await expectPgError(c,()=>c.query("insert into business_facts(org_id,category,key,value,status,source,created_by) values($1,'policy',$2,'x','confirmed','manual',$3)",[ids.orgA,uniq('k'),ids.staffA]),{code:'42501'});
  });
});

test('I4 staff may add a tentative fact as themselves only', async()=>{
  await asUser(c,{uid:ids.staffA},async c=>{
    await c.query("insert into business_facts(org_id,category,key,value,status,source,created_by) values($1,'event',$2,'Parking closed','tentative','conversation',$3)",[ids.orgA,uniq('t'),ids.staffA]);
    await expectPgError(c,()=>c.query("insert into business_facts(org_id,category,key,value,status,source,created_by) values($1,'event',$2,'x','tentative','conversation',$3)",[ids.orgA,uniq('t'),ids.ownerA]),{code:'42501'});
  });
});

test('I5 owner confirms a fact; staff cannot confirm a correction', async()=>{
  await asUser(c,{uid:ids.ownerA},async c=>{
    await c.query("insert into business_facts(org_id,category,key,value,status,source,created_by) values($1,'policy',$2,'24h cancellation','confirmed','manual',$3)",[ids.orgA,uniq('p'),ids.ownerA]);
  });
  await asUser(c,{uid:ids.staffA},async c=>{
    const id=(await c.query("select id from business_facts where org_id=$1 and status='confirmed' limit 1",[ids.orgA])).rows[0].id;
    await expectPgError(c,()=>c.query('select supersede_fact($1,$2,$3)',[id,'changed','confirmed']),{code:'42501'});
  });
});

test('I6 correction supersedes the old record and keeps history', async()=>{
  const key=uniq('hours');
  await asUser(c,{uid:ids.ownerA},async c=>{
    const old=(await c.query("insert into business_facts(org_id,category,key,value,status,source,created_by) values($1,'hours',$2,'9-5','confirmed','manual',$3) returning id",[ids.orgA,key,ids.ownerA])).rows[0].id;
    const nid=(await c.query('select supersede_fact($1,$2,$3)',[old,'8-4','confirmed'])).rows[0].supersede_fact;
    const rows=(await c.query('select id,status,supersedes_id,value from business_facts where key=$1 order by created_at',[key])).rows;
    const oldRow=rows.find(r=>r.id===old), newRow=rows.find(r=>r.id===nid);
    assert.equal(oldRow.status,'superseded');
    assert.equal(newRow.status,'confirmed');
    assert.equal(newRow.supersedes_id,old);
    assert.equal(rows.length,2,'history must keep both records');
    const audit=(await c.query("select count(*)::int n from audit_events where org_id=$1 and action='fact.superseded' and target_id=$2",[ids.orgA,nid])).rows[0].n;
    assert.equal(audit,1,'correction must be audited');
  });
});

test('I7 facts cannot be edited or deleted directly', async()=>{
  await asUser(c,{uid:ids.ownerA},async c=>{
    const id=(await c.query('select id from business_facts where org_id=$1 limit 1',[ids.orgA])).rows[0].id;
    await expectPgError(c,()=>c.query("update business_facts set value='hacked' where id=$1",[id]),{code:'42501'});
    await expectPgError(c,()=>c.query('delete from business_facts where id=$1',[id]),{code:'42501'});
  });
});

test('I8 duplicate current fact is rejected; unique key keeps one current record', async()=>{
  const key=uniq('dup');
  await asUser(c,{uid:ids.ownerA},async c=>{
    await c.query("insert into business_facts(org_id,category,key,value,status,source,created_by) values($1,'faq',$2,'a','confirmed','manual',$3)",[ids.orgA,key,ids.ownerA]);
    await expectPgError(c,()=>c.query("insert into business_facts(org_id,category,key,value,status,source,created_by) values($1,'faq',$2,'b','confirmed','manual',$3)",[ids.orgA,key,ids.ownerA]),{code:'23505'});
  });
});

test('I9 overlapping recurring hours are a contradiction and are rejected', async()=>{
  await asUser(c,{uid:ids.ownerA},async c=>{
    await c.query("insert into schedule_rules(org_id,entity_id,weekday,start_min,end_min,status,source) values($1,$2,1,480,720,'confirmed','manual')",[ids.orgA,ids.drA]);
    await expectPgError(c,()=>c.query("insert into schedule_rules(org_id,entity_id,weekday,start_min,end_min,status,source) values($1,$2,1,600,900,'confirmed','manual')",[ids.orgA,ids.drA]),{code:'23P01'});
    // Non-overlapping hours on the same day are fine.
    await c.query("insert into schedule_rules(org_id,entity_id,weekday,start_min,end_min,status,source) values($1,$2,1,720,960,'confirmed','manual')",[ids.orgA,ids.drA]);
  });
});

test('I10 tentative leave never appears as confirmed unavailability', async()=>{
  const day=`2031-0${1+(++n%8)}-1${n%9}`;
  await asUser(c,{uid:ids.staffA},async c=>{
    await c.query("insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,created_by) values($1,$2,$3,'leave','tentative','might be off','conversation',$4)",[ids.orgA,ids.drA,day,ids.staffA]);
    const conf=(await c.query('select count(*)::int n from current_unavailability where on_date=$1',[day])).rows[0].n;
    const tent=(await c.query('select count(*)::int n from tentative_unavailability where on_date=$1',[day])).rows[0].n;
    assert.equal(conf,0,'tentative leave must not count as confirmed');
    assert.equal(tent,1);
  });
});

test('I11 confirmed leave appears as unavailability and a second current leave is rejected', async()=>{
  const day=`2032-0${1+(++n%8)}-1${n%9}`;
  await asUser(c,{uid:ids.ownerA},async c=>{
    await c.query("insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,created_by) values($1,$2,$3,'leave','confirmed','','manual',$4)",[ids.orgA,ids.drA,day,ids.ownerA]);
    const conf=(await c.query('select count(*)::int n from current_unavailability where on_date=$1',[day])).rows[0].n;
    assert.equal(conf,1);
    await expectPgError(c,()=>c.query("insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,created_by) values($1,$2,$3,'leave','confirmed','','manual',$4)",[ids.orgA,ids.drA,day,ids.ownerA]),{code:'23505'});
  });
});

test('I12 supersession cannot point across organisations', async()=>{
  await asUser(c,{uid:ids.ownerA},async c=>{
    await expectPgError(c,()=>c.query("insert into business_facts(org_id,category,key,value,status,source,created_by,supersedes_id) values($1,'faq',$2,'x','confirmed','manual',$3,$4)",[ids.orgA,uniq('x'),ids.ownerA,ids.factB]),{code:'23514'});
  });
});

test('I13 audit trail is append-only and readable only by members', async()=>{
  await asUser(c,{uid:ids.ownerA},async c=>{
    await expectPgError(c,()=>c.query("insert into audit_events(org_id,action,target_type) values($1,'fake','x')",[ids.orgA]),{code:'42501'});
    await expectPgError(c,()=>c.query("update audit_events set action='x'"),{code:'42501'});
  });
  await asUser(c,{uid:ids.ownerB},async c=>{
    const seen=(await c.query('select count(*)::int n from audit_events where org_id=$1',[ids.orgA])).rows[0].n;
    assert.equal(seen,0,'clinic B must not read clinic A audit');
  });
});

test('I14 anonymous visitors can read no information', async()=>{
  await asUser(c,{role:'anon'},async c=>{
    const f=(await c.query('select count(*)::int n from business_facts')).rows[0].n;
    const s=(await c.query('select count(*)::int n from schedule_rules')).rows[0].n;
    assert.equal(f,0); assert.equal(s,0);
  });
});

test('I15 expiry marks temporary information expired and keeps confirmed history', async()=>{
  const past=new Date(Date.now()-3*864e5).toISOString().slice(0,10);
  const k=uniq('temp');
  await c.query("insert into business_facts(org_id,category,key,value,status,source,effective_from,effective_until) values($1,'event',$2,'Promo','confirmed','manual',now()-interval '5 days',now()-interval '1 day')",[ids.orgA,k]);
  await c.query("insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,source) values($1,$2,$3,'unavailable','tentative','conversation')",[ids.orgA,ids.drA,past]);
  await c.query("insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,source) values($1,$2,$3,'leave','confirmed','manual')",[ids.orgA,ids.drA,past]);
  // Expiry is a scheduled server job, so it runs as the service role and commits (not inside a rolled-back test transaction).
  await c.query('set role service_role');
  const r=(await c.query('select expire_information() as r')).rows[0].r;
  await c.query('reset role');
  assert.ok(r.facts_expired>=1);
  const st=(await c.query("select status from business_facts where key=$1",[k])).rows[0].status;
  assert.equal(st,'expired');
  const tentativeLeft=(await c.query("select count(*)::int n from schedule_exceptions where org_id=$1 and on_date=$2 and status='tentative'",[ids.orgA,past])).rows[0].n;
  assert.equal(tentativeLeft,0,'expired tentative leave must not remain tentative');
  const confirmedLeft=(await c.query("select count(*)::int n from schedule_exceptions where org_id=$1 and on_date=$2 and status='confirmed'",[ids.orgA,past])).rows[0].n;
  assert.equal(confirmedLeft,1,'confirmed history must be kept');
});

test('I16 end-to-end: recording tentative leave keeps the source conversation and never confirms it', async()=>{
  const day=`2033-0${1+(++n%8)}-2${n%8}`;
  await asUser(c,{uid:ids.staffA},async c=>{
    await c.query("insert into schedule_exceptions(org_id,entity_id,on_date,kind,status,note,source,source_reference,created_by) values($1,$2,$3,'leave','tentative','Might be off, not confirmed','conversation','conv:test-123',$4)",[ids.orgA,ids.drA,day,ids.staffA]);
    const row=(await c.query('select status,source,source_reference from schedule_exceptions where on_date=$1 and entity_id=$2',[day,ids.drA])).rows[0];
    assert.equal(row.status,'tentative');
    assert.equal(row.source,'conversation');
    assert.equal(row.source_reference,'conv:test-123');
    assert.equal((await c.query('select count(*)::int n from current_unavailability where on_date=$1',[day])).rows[0].n,0);
  });
});
