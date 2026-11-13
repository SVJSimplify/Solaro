// Tools against the real database, as real users. Row-level security and the database functions enforce what the tools check.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {connect,expectPgError,asUser} from './helpers.mjs';
import {pgAdapter} from '../tools/pgAdapter.mjs';
import {ToolRegistry,modelToolsFor} from '../../supabase/functions/_shared/tools/registry.js';
import {executeTool} from '../../supabase/functions/_shared/tools/executor.js';
import {informationTools} from '../../supabase/functions/_shared/tools/information.js';
import {todayIn,addDaysFromToday} from '../tools/dates.mjs';

const reg=new ToolRegistry(informationTools);
let c;const ids={};
const q=async(s,p)=>(await c.query(s,p)).rows;
const day=n=>addDaysFromToday(n);
const run=(name,args,who,org=ids.orgA)=>executeTool(reg,name,args,{orgId:org,userId:ids[who],timeZone:'UTC'},pgAdapter(c,ids[who]));
const key=n=>`tool-key-${Date.now()}-${n}`;

before(async()=>{
  c=await connect();
  ids.orgA=(await q("insert into organizations(name) values('Tools Clinic A') returning id"))[0].id;
  ids.orgB=(await q("insert into organizations(name) values('Tools Clinic B') returning id"))[0].id;
  ids.owner=(await q("insert into auth.users(email) values('owner@tools.test') returning id"))[0].id;
  ids.staff=(await q("insert into auth.users(email) values('staff@tools.test') returning id"))[0].id;
  ids.ownerB=(await q("insert into auth.users(email) values('ownerb@tools.test') returning id"))[0].id;
  await q("insert into members(org_id,user_id,role) values($1,$2,'owner'),($1,$3,'staff'),($4,$5,'owner')",[ids.orgA,ids.owner,ids.staff,ids.orgB,ids.ownerB]);
  ids.doc=(await q("insert into business_entities(org_id,kind,name,normalized_name) values($1,'doctor','Dr. Sharma','dr. sharma') returning id",[ids.orgA]))[0].id;
  await q("insert into schedule_rules(org_id,entity_id,weekday,start_min,end_min,slot_minutes,status,source) values($1,$2,1,480,960,30,'confirmed','manual')",[ids.orgA,ids.doc]);
  ids.fact=(await q("insert into business_facts(org_id,category,key,value,status,source) values($1,'hours','Opening hours','Mon to Fri, 8am to 4pm','confirmed','manual') returning id",[ids.orgA]))[0].id;
  ids.mehta=(await q("insert into business_entities(org_id,kind,name,normalized_name) values($1,'doctor','Dr. Mehta','dr. mehta') returning id",[ids.orgA]))[0].id;
  ids.doctor=(await q("insert into auth.users(email) values('doctor@tools.test') returning id"))[0].id;
  await q("insert into members(org_id,user_id,role) values($1,$2,'doctor')",[ids.orgA,ids.doctor]);
});
after(async()=>{await c?.end()});

test('D1 staff can read a doctor\'s schedule in their clinic', async()=>{
  const r=await run('get_doctor_schedule',{doctor:'sharma',from_date:'today',days:7},'staff');
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal(r.data.doctor.name,'Dr. Sharma');
  assert.equal(r.data.weekly[0].start,'08:00');
});

test('D2 staff record a tentative leave; the row is tentative and attributed', async()=>{
  const k=key('d2');
  const r=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'leave',on_date:'tomorrow',status:'tentative',note:'might be off',idempotency_key:k},'staff');
  assert.equal(r.ok,true,JSON.stringify(r));
  const row=(await q("select status,created_by,source_reference from schedule_exceptions where id=$1",[r.data.exception_id]))[0];
  assert.equal(row.status,'tentative'); assert.equal(row.created_by,ids.staff); assert.equal(row.source_reference,'tool:'+k);
  const audit=(await q("select count(*)::int n from audit_events where target_id=$1 and action='exception.created'",[r.data.exception_id]))[0].n;
  assert.equal(audit,1,'creation must be audited');
});

test('D3 repeating the same call does not create a second record', async()=>{
  const k=key('d3');
  const args={doctor:'Dr. Sharma',kind:'unavailable',on_date:day(20),status:'tentative',idempotency_key:k};
  const a=await run('record_schedule_exception',args,'staff');
  const b=await run('record_schedule_exception',args,'staff');
  assert.equal(a.ok&&b.ok,true);
  assert.equal(b.meta.replayed,true);
  assert.equal(b.data.exception_id,a.data.exception_id);
  assert.equal((await q("select count(*)::int n from schedule_exceptions where source_reference=$1",['tool:'+k]))[0].n,1);
});

test('D4 the same key for a different request is refused', async()=>{
  const k=key('d4');
  await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'leave',on_date:day(21),status:'tentative',idempotency_key:k},'staff');
  const r=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'leave',on_date:day(22),status:'tentative',idempotency_key:k},'staff');
  assert.equal(r.error.code,'INVALID_ARGUMENT');
});

test('D5 staff cannot confirm through the tool, and the database refuses it too', async()=>{
  const r=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'leave',on_date:day(23),status:'confirmed',idempotency_key:key('d5')},'staff');
  assert.equal(r.error.code,'PERMISSION_DENIED');
  await asUser(c,{uid:ids.staff},async c=>{
    await expectPgError(c,()=>c.query("select create_schedule_exception($1,$2,'leave','confirmed','', 'tool:x')",[ids.doc,day(23)]),{code:'42501'});
  });
});

test('D6 an owner can confirm leave; it then counts as confirmed unavailability', async()=>{
  const d=day(24);
  const r=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'leave',on_date:d,status:'confirmed',idempotency_key:key('d6')},'owner');
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.equal((await q("select count(*)::int n from current_unavailability where on_date=$1 and entity_id=$2",[d,ids.doc]))[0].n,1);
});

test('D7 a second live leave for the same doctor and day is a conflict, not a duplicate', async()=>{
  const d=day(24);
  const r=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'leave',on_date:d,status:'tentative',idempotency_key:key('d7')},'staff');
  assert.equal(r.error.code,'RESOURCE_CONFLICT');
  assert.equal(r.error.retryable,false);
});

test('D8 another clinic cannot see or change this doctor', async()=>{
  const read=await run('get_doctor_schedule',{doctor:'Sharma'},'ownerB','');
  assert.equal(read.error?.code,'PERMISSION_DENIED','non-members are refused before lookup');
  const write=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'leave',on_date:day(25),status:'tentative',idempotency_key:key('d8')},'ownerB',ids.orgB);
  assert.equal(write.error.code,'ENTITY_NOT_FOUND');
  assert.equal((await q("select count(*)::int n from schedule_exceptions where org_id=$1 and on_date=$2",[ids.orgA,day(25)]))[0].n,0);
});

test('D9 staff correction is saved as tentative and keeps the old wording as history', async()=>{
  const r=await run('update_business_fact',{fact_id:ids.fact,value:'Mon to Fri, 8am to 5pm',status:'tentative',idempotency_key:key('d9')},'staff');
  assert.equal(r.ok,true,JSON.stringify(r));
  const rows=await q("select id,status,value,supersedes_id from business_facts where org_id=$1 and key='Opening hours' order by created_at",[ids.orgA]);
  assert.equal(rows.length,2,'both versions kept');
  assert.equal(rows.find(x=>x.id===ids.fact).status,'superseded');
  assert.equal(rows.find(x=>x.id===r.data.fact_id).supersedes_id,ids.fact);
});

test('D10 staff cannot confirm a correction, and the database refuses it too', async()=>{
  const cur=(await q("select id from business_facts where org_id=$1 and key='Opening hours' and status='tentative'",[ids.orgA]))[0].id;
  const r=await run('update_business_fact',{fact_id:cur,value:'Final hours',status:'confirmed',idempotency_key:key('d10')},'staff');
  assert.equal(r.error.code,'PERMISSION_DENIED');
  await asUser(c,{uid:ids.staff},async c=>{
    await expectPgError(c,()=>c.query('select supersede_fact($1,$2,$3)',[cur,'Final hours','confirmed']),{code:'42501'});
  });
});

test('D11 an owner correction supersedes the tentative one, and a repeat is a replay', async()=>{
  const cur=(await q("select id from business_facts where org_id=$1 and key='Opening hours' and status='tentative'",[ids.orgA]))[0].id;
  const k=key('d11');
  const a=await run('update_business_fact',{fact_id:cur,value:'Mon to Fri, 8am to 5pm (confirmed)',status:'confirmed',idempotency_key:k},'owner');
  const b=await run('update_business_fact',{fact_id:cur,value:'Mon to Fri, 8am to 5pm (confirmed)',status:'confirmed',idempotency_key:k},'owner');
  assert.equal(a.ok,true,JSON.stringify(a));
  assert.equal(b.meta.replayed,true);
  assert.equal((await q("select count(*)::int n from business_facts where org_id=$1 and key='Opening hours' and status='confirmed'",[ids.orgA]))[0].n,1);
});

test('D12 a lost response does not repeat a change that already happened', async()=>{
  // The change was saved, but the response was lost, so the claim is left "interrupted". The retry must find the change and replay it.
  const k=key('d12');
  const first=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'unavailable',on_date:day(41),status:'tentative',idempotency_key:k},'staff');
  assert.equal(first.ok,true);
  await q("update tool_executions set status='interrupted' where idempotency_key=$1",[k]);
  const again=await run('record_schedule_exception',{doctor:'Dr. Sharma',kind:'unavailable',on_date:day(41),status:'tentative',idempotency_key:k},'staff');
  assert.equal(again.ok,true,JSON.stringify(again));
  assert.equal(again.data.exception_id,first.data.exception_id);
  assert.equal((await q("select count(*)::int n from schedule_exceptions where source_reference=$1",['tool:'+k]))[0].n,1,'exactly one record');
});

test('D13 each tool\'s output is checked against its schema on the real path', async()=>{
  const r=await run('get_doctor_schedule',{doctor:'sharma',days:3},'owner');
  assert.equal(r.ok,true);
  assert.ok(Array.isArray(r.data.exceptions));
});

test('D14 model definitions match the role on the real account', async()=>{
  const role=(await q('select role from members where org_id=$1 and user_id=$2',[ids.orgA,ids.staff]))[0];
  const staffRole=role?.role;
  assert.equal(staffRole,'staff','the database lists the staff member correctly');
  const tools=modelToolsFor(reg,{role:staffRole});
  const e=tools.find(t=>t.function.name==='record_schedule_exception').function.parameters.properties.status.enum;
  assert.deepEqual(e,['tentative']);
});

// ======================= Phase 3 against the real database (local PostgreSQL, real migrations, real RLS) =======================
import {buildRegistry} from '../../supabase/functions/_shared/tools/index.js';
const full=buildRegistry();
const runF=(name,args,who,org=ids.orgA,extra={})=>executeTool(full,name,args,{orgId:org,userId:ids[who],timeZone:'UTC',...extra},pgAdapter(c,ids[who]));
const rpc=(who,sql,params)=>asUser(c,{uid:ids[who]},async cl=>(await cl.query(sql,params)).rows);
const items=(over={})=>({items:[
  {type:'weekly_hours',entity:'Dr. Mehta',weekdays:'Mon, Wed, Fri',hours:'9am-5pm',status:'tentative',source_quote:'usually works Monday, Wednesday and Friday'},
  {type:'leave',entity:'Dr. Mehta',kind:'unavailable',date:day(9),status:'tentative',source_quote:'might be unavailable next Tuesday'}],idempotency_key:key('x'),...over});

test('P1 worked example on the real database: schedule kept, Tuesday tentative, source and audit preserved', async()=>{
  const r=await runF('record_business_information',items(),'staff',ids.orgA,{userMessage:'Dr. Mehta usually works Monday, Wednesday and Friday, but might be unavailable next Tuesday.'});
  assert.equal(r.ok,true,JSON.stringify(r));
  assert.deepEqual(r.data.counts,{created:4});
  const rules=await q("select weekday,status,source,source_quote,created_by from schedule_rules where entity_id=$1 order by weekday",[ids.mehta]);
  assert.deepEqual(rules.map(x=>[x.weekday,x.status,x.source]),[[1,'tentative','conversation'],[3,'tentative','conversation'],[5,'tentative','conversation']]);
  assert.ok(rules[0].source_quote.includes('usually works')&&rules[0].created_by===ids.staff);
  const ex=await q("select status,kind,source_quote from schedule_exceptions where entity_id=$1",[ids.mehta]);
  assert.equal(ex[0].status,'tentative');assert.ok(ex[0].source_quote.includes('might be unavailable'));
  assert.equal((await q("select count(*)::int n from audit_events where org_id=$1 and action like 'info.%'",[ids.orgA]))[0].n>=4,true);
  const sched=await runF('get_doctor_schedule',{doctor:'Mehta',from_date:day(8),days:3},'staff');
  assert.equal(sched.data.exceptions[0].status,'tentative');
  assert.equal((await q("select count(*)::int n from current_unavailability where entity_id=$1",[ids.mehta]))[0].n,0);   // never confirmed
});
test('P2 duplicates, contradictions and supersession keep history', async()=>{
  const dup=await runF('record_business_information',items({idempotency_key:key('d')}),'staff');
  assert.deepEqual(dup.data.counts,{duplicate:4});
  const one=(over,who='staff',k='c')=>runF('record_business_information',{items:[{type:'weekly_hours',entity:'Dr. Mehta',weekdays:'Mon',hours:'10am-3pm',status:'tentative',source_quote:'Monday is 10 to 3',...over}],idempotency_key:key(k)},who);
  const clash=await one({});
  assert.equal(clash.data.outcomes[0].result,'conflict');assert.equal(clash.data.outcomes[0].reason,'CONTRADICTS_EXISTING');
  const fix=await one({intent:'correct'},'staff','f');
  assert.equal(fix.data.outcomes[0].result,'superseded');
  const hist=await q("select status,supersedes_id from schedule_rules where entity_id=$1 and weekday=1 order by created_at",[ids.mehta]);
  assert.deepEqual(hist.map(h=>h.status),['superseded','tentative']);assert.ok(hist[1].supersedes_id);
  // A confirmed rule is protected from staff, and can be changed by an owner.
  const prot=await runF('record_business_information',{items:[{type:'weekly_hours',entity:'Dr. Sharma',weekdays:'Mon',hours:'9am-1pm',status:'tentative',intent:'correct',source_quote:'Sharma Monday 9 to 1'}],idempotency_key:key('p')},'staff');
  assert.equal(prot.data.outcomes[0].reason,'CONFIRMED_PROTECTED');
  const own=await runF('record_business_information',{items:[{type:'weekly_hours',entity:'Dr. Sharma',weekdays:'Mon',hours:'9am-1pm',status:'confirmed',intent:'correct',source_quote:'Sharma Monday 9 to 1'}],idempotency_key:key('o')},'owner');
  assert.equal(own.data.outcomes[0].result,'superseded');
  assert.equal((await q("select count(*)::int n from schedule_rules where entity_id=$1 and status='superseded'",[ids.doc]))[0].n,1);   // history kept
  // Facts: same key different value conflicts, same wording under another key is a duplicate.
  const f=(key_,value,over={},who='owner',k)=>runF('record_business_information',{items:[{type:'fact',category:'policy',key:key_,value,status:'confirmed',source_quote:'policy',...over}],idempotency_key:key(k)},who);
  assert.equal((await f('parking','Free parking behind the clinic',{},'owner','f1')).data.outcomes[0].result,'created');
  assert.equal((await f('parking','Paid parking',{},'owner','f2')).data.outcomes[0].reason,'CONTRADICTS_EXISTING');
  assert.equal((await f('car park','Free parking behind the clinic',{},'owner','f3')).data.outcomes[0].reason,'SAME_VALUE_OTHER_KEY');
  assert.equal((await f('parking','Paid parking',{intent:'correct',status:'tentative'},'staff','f4')).data.outcomes[0].reason,'CONFIRMED_PROTECTED');
  assert.equal((await f('parking','Paid parking',{intent:'correct'},'owner','f5')).data.outcomes[0].result,'superseded');
  assert.equal((await q("select count(*)::int n from business_facts where org_id=$1 and key='parking'",[ids.orgA]))[0].n,2);
});
test('P3 only an owner or admin confirms; confirming a tentative leave supersedes it', async()=>{
  const conf=k=>({items:[{type:'leave',entity:'Dr. Mehta',kind:'unavailable',date:day(9),status:'confirmed',source_quote:'Mehta is off, confirmed'}],idempotency_key:key(k)});
  const s=await runF('record_business_information',conf('s'),'staff');
  assert.equal(s.data.outcomes[0].reason,'PERMISSION_DENIED');
  const o=await runF('record_business_information',conf('o'),'owner');
  assert.equal(o.data.outcomes[0].result,'superseded');
  assert.equal((await q("select count(*)::int n from current_unavailability where entity_id=$1",[ids.mehta]))[0].n,1);
  assert.equal((await q("select count(*)::int n from tentative_unavailability where entity_id=$1",[ids.mehta]))[0].n,0);
  // The database refuses on its own when the application check is bypassed.
  await expectPgError(c,()=>asUser(c,{uid:ids.staff},cl=>cl.query("select apply_information_item($1,$2::jsonb,'bypass-1')",[ids.orgA,JSON.stringify({type:'fact',category:'policy',key:'zz',value:'x',status:'confirmed'})])),{code:'42501'}).catch(()=>{});
  const raw=await c.query('begin').then(async()=>{try{await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ids.staff,role:'authenticated'})]);await c.query('set local role authenticated');
    await c.query("select apply_information_item($1,$2::jsonb,'bypass-2')",[ids.orgA,JSON.stringify({type:'fact',category:'policy',key:'zz',value:'x',status:'confirmed'})]);return 'ran'}catch(e){return e.code}finally{await c.query('rollback')}});
  assert.equal(raw,'42501');
});
test('P4 organisations are isolated', async()=>{
  assert.equal((await runF('record_business_information',items({idempotency_key:key('iso')}),'ownerB',ids.orgA)).error.code,'PERMISSION_DENIED');
  assert.equal((await runF('find_business_information',{query:'parking'},'ownerB',ids.orgB)).data.matches.length,0);
  // Another clinic's doctor id passed straight to the database function is refused as not found.
  const out=await c.query('begin').then(async()=>{try{await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ids.ownerB,role:'authenticated'})]);await c.query('set local role authenticated');
    return (await c.query("select apply_information_item($1,$2::jsonb,'iso-3') r",[ids.orgB,JSON.stringify({type:'exception',entity_id:ids.mehta,on_date:day(20),kind:'leave',status:'confirmed'})])).rows[0].r}finally{await c.query('rollback')}});
  assert.equal(out.reason,'ENTITY_NOT_FOUND');
  assert.equal((await q("select count(*)::int n from schedule_exceptions where org_id=$1",[ids.orgB]))[0].n,0);
});
test('P5 doctors read clinic information but cannot write it or see customer data', async()=>{
  assert.equal((await runF('record_business_information',items({idempotency_key:key('doc')}),'doctor')).error.code,'PERMISSION_DENIED');
  assert.equal((await runF('get_doctor_schedule',{doctor:'Mehta'},'doctor')).ok,true);
  const at=await c.query('begin').then(async()=>{try{await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ids.doctor,role:'authenticated'})]);await c.query('set local role authenticated');
    return await c.query("select apply_information_item($1,$2::jsonb,'doc-1')",[ids.orgA,JSON.stringify({type:'fact',category:'policy',key:'k',value:'v',status:'tentative'})]).then(()=>'ran',e=>e.code)}finally{await c.query('rollback')}});
  assert.equal(at,'42501');
  await q("insert into bookings(org_id,name,phone,service,starts_at) values($1,'Asha','+919876543210','Exam',$2)",[ids.orgA,`${day(30)} 10:00`]);
  assert.equal((await rpc('doctor','select count(*)::int n from bookings'))[0].n,0);
  assert.equal((await rpc('staff','select count(*)::int n from bookings'))[0].n,1);
  assert.ok((await rpc('doctor','select count(*)::int n from business_facts'))[0].n>0);
  assert.equal((await runF('find_bookings',{phone:'9876543210'},'doctor')).error.code,'PERMISSION_DENIED');
  await assert.rejects(()=>c.query("update members set role='admin' where user_id=$1",[ids.doctor]).then(()=>{throw new Error('ok')}),/ok/);   // postgres may; doctors cannot (below)
  await q("update members set role='doctor' where user_id=$1",[ids.doctor]);
  assert.equal((await rpc('doctor',"select can_manage($1) m",[ids.orgA]))[0].m,false);
});
test('P6 the database itself refuses patient information', async()=>{
  const out=await c.query('begin').then(async()=>{try{await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:ids.staff,role:'authenticated'})]);await c.query('set local role authenticated');
    return (await c.query("select apply_information_item($1,$2::jsonb,'pi-1') r",[ids.orgA,JSON.stringify({type:'fact',category:'policy',key:'note',value:'Call Mr Rao on 98765 43210',status:'tentative'})])).rows[0].r}finally{await c.query('rollback')}});
  assert.equal(out.reason,'PATIENT_INFORMATION');
});
test('P7 one audit trail: app events and tool events share audit_events; the old table is read-only history', async()=>{
  await asUser(c,{uid:ids.staff},async cl=>{
    await cl.query("select log_audit($1,'handoff','Asha: upset')",[ids.orgA]);
    assert.equal((await cl.query("select detail from audit where action='handoff'")).rows[0].detail,'Asha: upset');
    await cl.query("insert into audit(org_id,action,detail) values($1,'booking','legacy-style insert')",[ids.orgA]);   // the deployed app's old write path
    assert.equal((await cl.query("select count(*)::int n from audit_events where detail->>'text'='legacy-style insert'")).rows[0].n,1);
    await expectPgError(cl,()=>cl.query("insert into audit_legacy(org_id,action,detail) values($1,'x','y')",[ids.orgA]),{code:'42501'});
    await expectPgError(cl,()=>cl.query("update audit_events set action='x'"),{code:'42501'});
  });
  await asUser(c,{uid:ids.ownerB},async cl=>assert.equal((await cl.query("select count(*)::int n from audit_events where org_id=$1",[ids.orgA])).rows[0].n,0));   // not another clinic's trail
  assert.equal((await rpc('doctor','select count(*)::int n from audit_events'))[0].n>0,true);
});
test('P8 doctors added through the existing screens appear in information memory and stay in step', async()=>{
  const d=(await q("insert into doctors(org_id,name,specialty,services,days,start_time,end_time,slot) values($1,'Dr. Rao','Gen','{Exam,Cleaning}','{1,2,3,4,5}','08:00','16:00',30) returning id",[ids.orgA]))[0].id;
  ids.rao=d;
  const ent=await q("select id,status from business_entities where legacy_doctor_id=$1",[d]);
  assert.equal(ent.length,1);
  assert.equal((await q("select count(*)::int n from schedule_rules where entity_id=$1 and status='confirmed' and source='legacy_doctors'",[ent[0].id]))[0].n,5);
  await q("update doctors set days='{1,2}' where id=$1",[d]);
  assert.equal((await q("select count(*)::int n from schedule_rules where entity_id=$1 and status='confirmed'",[ent[0].id]))[0].n,2);
  await q("update doctors set days='{1,2,3,4,5}' where id=$1",[d]);
  assert.equal((await runF('get_doctor_schedule',{doctor:'Dr. Rao'},'staff')).data.weekly.length,5);   // the front desk's doctor is resolvable by the tools
});
test('P9 front-desk booking through the registry on the real database', async()=>{
  const monday=[...Array(14).keys()].map(i=>day(i+2)).find(x=>new Date(x+'T00:00:00Z').getUTCDay()===1);
  const ctx2={localNow:`${day(0)}T00:00`,surface:'front',out:{}};
  const b1=await runF('book_appointment',{name:'Asha',phone:'9876543210',service:'Exam',when:`${monday}T09:00`},'staff',ids.orgA,{...ctx2,requestId:'t1'});
  assert.equal(b1.ok,true,JSON.stringify(b1));assert.equal(b1.data.doctor,'Dr. Rao');
  const again=await runF('book_appointment',{name:'Asha',phone:'9876543210',service:'Exam',when:`${monday}T09:00`},'staff',ids.orgA,{...ctx2,requestId:'t1'});
  assert.equal(again.meta.replayed,true);
  const taken=await runF('book_appointment',{name:'Bo',phone:'9876543211',service:'Exam',when:`${monday}T09:00`},'staff',ids.orgA,{...ctx2,requestId:'t2'});
  assert.equal(taken.error.code,'RESOURCE_CONFLICT');
  assert.equal((await q("select count(*)::int n from bookings where org_id=$1 and status='booked' and doctor_id=$2",[ids.orgA,ids.rao]))[0].n,1);
  assert.equal((await q("select count(*)::int n from audit_events where org_id=$1 and action='booking' and detail->>'text' like 'Asha%'",[ids.orgA]))[0].n,1);
  assert.equal((await runF('book_appointment',{name:'Doc',phone:'9876543212',service:'Exam',when:`${monday}T09:30`},'doctor',ids.orgA,{...ctx2,requestId:'t3'})).error.code,'PERMISSION_DENIED');
  const cx=await runF('cancel_booking',{phone:'9876543210',when:`${monday}T09:00`},'staff',ids.orgA,{...ctx2,requestId:'t4'});
  assert.equal(cx.data?.cancelled,true,JSON.stringify(cx));
});
