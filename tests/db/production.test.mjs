// Production-readiness tests against real Postgres with parallel connections: booking contention, atomic limits,
// single-winner claims, tenant and role isolation under the optimised policies, the read-only widget lookup and retention.
// Uses committed fixtures in their own clinics and removes them afterwards.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {DB_URL} from './helpers.mjs';

const pool=new pg.Pool({connectionString:DB_URL,max:24});
const q=(s,p)=>pool.query(s,p).then(r=>r.rows);
const ids={};
/* Runs fn on its own connection as a role: 'service' or a signed-in user id. Commits. */
async function as(who,fn){
  const c=await pool.connect();
  try{
    await c.query('begin');
    if(who==='service')await c.query('set local role service_role');
    else{await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:who,role:'authenticated'})]);await c.query('set local role authenticated')}
    const r=await fn(c);await c.query('commit');return r;
  }catch(e){await c.query('rollback').catch(()=>{});throw e}finally{c.release()}
}

before(async()=>{
  const [a]=await q("insert into organizations(name,widget_enabled) values('Prod A',true) returning id");
  const [b]=await q("insert into organizations(name,widget_enabled) values('Prod B',false) returning id");
  ids.A=a.id;ids.B=b.id;
  for(const r of ['owner','staff','doctor','otherOwner']){
    const [u]=await q("insert into auth.users(email) values($1) returning id",[r+'-'+Date.now()+'@prod.test']);ids[r]=u.id;
  }
  await q("insert into members(org_id,user_id,role) values($1,$2,'owner'),($1,$3,'staff'),($1,$4,'doctor'),($5,$6,'owner')",[ids.A,ids.owner,ids.staff,ids.doctor,ids.B,ids.otherOwner]);
  const [d]=await q("insert into doctors(org_id,name,days,start_time,end_time) values($1,'Dr Prod','{0,1,2,3,4,5,6}','00:00','24:00') returning id",[ids.A]);ids.doc=d.id;
  const [c]=await q("insert into conversations(org_id,customer,channel,status) values($1,'P','Web chat','handled') returning id",[ids.A]);ids.convo=c.id;
  await q("insert into messages(org_id,conversation_id,role,body) values($1,$2,'cust','hello')",[ids.A,ids.convo]);
  await q("insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status) values($1,'P','+14155550100','Cleaning','2031-01-01 09:00',$2,'Dr Prod','booked')",[ids.A,ids.doc]);
});
after(async()=>{
  await q('delete from organizations where id = any($1)',[[ids.A,ids.B]]);
  await q('delete from auth.users where id = any($1)',[[ids.owner,ids.staff,ids.doctor,ids.otherOwner]]);
  await pool.end();
});

test('contention: 20 simultaneous requests for one doctor and time produce exactly one booking',async()=>{
  const tries=await Promise.allSettled(Array.from({length:20},(_,i)=>as('service',c=>c.query(
    "insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status,source) values($1,$2,'+14155550101','Cleaning','2031-02-03 10:00',$3,'Dr Prod','requested','website')",[ids.A,'Racer '+i,ids.doc]))));
  assert.equal(tries.filter(t=>t.status==='fulfilled').length,1);
  assert.ok(tries.filter(t=>t.status==='rejected').every(t=>t.reason.code==='23505'));
  assert.equal((await q("select count(*)::int n from bookings where org_id=$1 and starts_at='2031-02-03 10:00' and status<>'cancelled'",[ids.A]))[0].n,1);
});

test('rate limiter: 100 simultaneous hits against a limit of 25 allow exactly 25',async()=>{
  const key='test:'+Date.now();
  const r=await Promise.all(Array.from({length:100},()=>as('service',c=>c.query('select hit_rate_limit($1,25,3600) ok',[key]).then(x=>x.rows[0].ok))));
  assert.equal(r.filter(Boolean).length,25);
});

test('rate limiter is server-only',async()=>{
  await assert.rejects(as(ids.owner,c=>c.query("select hit_rate_limit('x',1,60)")),e=>e.code==='42501');
  await assert.rejects(as(ids.owner,c=>c.query('select * from rate_limits')),e=>e.code==='42501');
});

test('daily AI limit: 30 simultaneous calls against a limit of 7 allow exactly 7',async()=>{
  await q('update organizations set daily_ai_override=7 where id=$1',[ids.A]);
  await q('delete from ai_usage where org_id=$1',[ids.A]);
  const r=await Promise.all(Array.from({length:30},()=>as('service',c=>c.query('select consume_ai_call($1) ok',[ids.A]).then(x=>x.rows[0].ok))));
  assert.equal(r.filter(Boolean).length,7);
});

test('claims: 10 staff confirming the same request at once, exactly one wins',async()=>{
  const [b]=await q("insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status,source) values($1,'Claim','+14155550102','Cleaning','2031-03-01 09:00',$2,'Dr Prod','requested','website') returning id",[ids.A,ids.doc]);
  const r=await Promise.all(Array.from({length:10},(_,i)=>as(i%2?ids.owner:ids.staff,c=>c.query("update bookings set status=$2 where id=$1 and status='requested' returning id",[b.id,i%3?'booked':'cancelled']).then(x=>x.rowCount))));
  assert.equal(r.reduce((a,b)=>a+b,0),1);
  const [row]=await q('select decided_at is not null decided, requested_at is not null requested from bookings where id=$1',[b.id]);
  assert.deepEqual(row,{decided:true,requested:true});
});

test('reminders: 8 tabs claiming the same reminder, exactly one sends',async()=>{
  const [b]=await q("insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status) values($1,'Rem','+14155550103','Cleaning','2031-03-02 09:00',$2,'Dr Prod','booked') returning id",[ids.A,ids.doc]);
  const r=await Promise.all(Array.from({length:8},()=>as(ids.staff,c=>c.query('update bookings set reminded=true where id=$1 and reminded=false returning id',[b.id]).then(x=>x.rowCount))));
  assert.equal(r.reduce((a,b)=>a+b,0),1);
});

test('isolation: owner and staff see their clinic; doctors see no patient data; another clinic sees nothing',async()=>{
  const count=(who,t)=>as(who,c=>c.query(`select count(*)::int n from ${t} where org_id=$1`,[ids.A]).then(x=>x.rows[0].n));
  for(const t of ['conversations','messages','bookings']){
    assert.ok(await count(ids.owner,t)>0,t);assert.ok(await count(ids.staff,t)>0,t);
    assert.equal(await count(ids.doctor,t),0,'doctor '+t);
    assert.equal(await count(ids.otherOwner,t),0,'other clinic '+t);
  }
  // Doctors still read closures and the activity trail, as before.
  await assert.doesNotReject(as(ids.doctor,c=>c.query('select * from closures where org_id=$1',[ids.A])));
  // Writing into another clinic is refused.
  await assert.rejects(as(ids.otherOwner,c=>c.query("insert into messages(org_id,conversation_id,role,body) values($1,$2,'staff','x')",[ids.A,ids.convo])),e=>e.code==='42501');
  await assert.rejects(as(ids.doctor,c=>c.query("insert into bookings(org_id,name,phone,service,starts_at,status) values($1,'x','+1','x','2032-01-01 09:00','booked')",[ids.A])),e=>e.code==='42501');
});

test('policies are evaluated once per query, not per row',async()=>{
  const plan=await as(ids.owner,c=>c.query('explain select * from bookings where starts_at>=current_date').then(x=>x.rows.map(r=>r['QUERY PLAN']).join('\n')));
  assert.doesNotMatch(plan,/is_staff|is_member/);assert.match(plan,/hashed SubPlan|InitPlan/);
});

test('widget_info is read-only and respects the widget switch',async()=>{
  const before=(await q('select count(*)::int n from conversations where org_id=$1',[ids.A]))[0].n;
  const a=await as(ids.owner,c=>c.query('select * from widget_info($1)',[ids.A]).then(x=>x.rows));
  const b=await as(ids.owner,c=>c.query('select * from widget_info($1)',[ids.B]).then(x=>x.rows));
  assert.equal(a[0].org_name,'Prod A');assert.equal(b.length,0);
  assert.equal((await q('select count(*)::int n from conversations where org_id=$1',[ids.A]))[0].n,before);
});

test('retention removes only expired operational rows',async()=>{
  const key='old:'+Date.now();
  await q("insert into rate_limits(key,window_start,hits) values($1,now()-interval '3 days',1),($1||'-new',now(),1)",[key]);
  const out=await as('service',c=>c.query('select prune_operational_data() r').then(x=>x.rows[0].r));
  assert.ok(out.rate_limits>=1);
  assert.equal((await q('select count(*)::int n from rate_limits where key=$1',[key]))[0].n,0);
  assert.equal((await q("select count(*)::int n from rate_limits where key=$1||'-new'",[key]))[0].n,1);
  assert.ok((await q('select count(*)::int n from bookings where org_id=$1',[ids.A]))[0].n>0);
  await assert.rejects(as(ids.owner,c=>c.query('select prune_operational_data()')),e=>e.code==='42501');
});
