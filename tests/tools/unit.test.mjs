// Tool-level tests with a fake database: malformed input, ambiguity, permissions, idempotency, retries, partial failure, output checks.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ToolRegistry,modelToolsFor,defineTool} from '../../supabase/functions/_shared/tools/registry.js';
import {executeTool} from '../../supabase/functions/_shared/tools/executor.js';
import {informationTools,getDoctorSchedule,recordScheduleException,updateBusinessFact} from '../../supabase/functions/_shared/tools/information.js';
import {validate,assertValid} from '../../supabase/functions/_shared/tools/schema.js';
import {cleanText,resolveDate,resolveTime,matchEntity,levenshtein} from '../../supabase/functions/_shared/tools/normalise.js';
import {withRetry,withTimeout} from '../../supabase/functions/_shared/tools/retry.js';
import {ToolError,toEnvelope,CODES} from '../../supabase/functions/_shared/tools/errors.js';

const TODAY='2026-11-16'; // a Monday
const ORG='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', USER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', DOC='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY='key-0001-abcdef';
const FACT='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', NEWF='ffffffff-ffff-4fff-8fff-ffffffffffff', MISSING='99999999-9999-4999-8999-999999999999';
const EX='11111111-1111-4111-8111-111111111111', EX2='22222222-2222-4222-8222-222222222222';

/* A fake database that records every call. Tests set the role, the doctors and the behaviour of each method. */
function fakeDb(over={}){
  const calls=[];
  const base={
    role:'owner',
    doctors:[{id:DOC,name:'Dr. Sharma'},{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',name:'Dr. Patel'}],
    async membershipRole(o,u){calls.push(['membershipRole']);return base.role},
    async listEntities(){calls.push(['listEntities']);return base.doctors},
    async rulesFor(){calls.push(['rulesFor']);return [{weekday:1,start_min:480,end_min:960,slot_minutes:30}]},
    async exceptionsFor(){calls.push(['exceptionsFor']);return []},
    async factById(){calls.push(['factById']);return {id:FACT,value:'Old',status:'confirmed'}},
    async createException(a){calls.push(['createException',a]);return EX},
    async findExceptionByRef(){calls.push(['findExceptionByRef']);return null},
    async supersedeFact(a){calls.push(['supersedeFact',a]);return NEWF},
    async findFactByRef(){calls.push(['findFactByRef']);return null},
    _claims:new Map(),_finished:[],
    async claimExecution({tool,key,hash}){
      calls.push(['claim']);const k=tool+'|'+key;
      if(!base._claims.has(k)){base._claims.set(k,{status:'started',input_hash:hash,result:null,updated_at:new Date().toISOString()});return {claimed:true}}
      return {claimed:false,row:base._claims.get(k)};
    },
    async takeOverExecution({tool,key,hash}){calls.push(['takeOver']);const r=base._claims.get(tool+'|'+key);if(r&&r.input_hash===hash&&r.status!=='succeeded'){r.status='started';return true}return false},
    async finishExecution({tool,key,status,result,errorCode}){
      calls.push(['finish',status]);base._finished.push({tool,key,status,result,errorCode});
      const r=base._claims.get(tool+'|'+key);if(r){r.status=status;r.result=result??null;r.updated_at=new Date().toISOString()}
    },
  };
  return Object.assign(base,over,{calls});
}
const reg=new ToolRegistry(informationTools);
const ctx=(o={})=>({orgId:ORG,userId:USER,today:TODAY,...o});
const sharmaLeave=(over={})=>({doctor:'Dr. Sharma',kind:'leave',on_date:'2026-11-20',status:'tentative',note:'',idempotency_key:KEY,...over});

// ---------- Schema
test('S1 unknown fields are rejected, not ignored', ()=>{
  const issues=validate(getDoctorSchedule.input,{doctor:'Sharma',evil:'x'},{phase:'raw'});
  assert.ok(issues.some(i=>i.message.includes('unknown field "evil"')));
});
test('S2 missing required values report MISSING_INFORMATION with the field', ()=>{
  try{assertValid(recordScheduleException.input,{doctor:'Sharma'},{phase:'raw'});assert.fail()}
  catch(e){assert.equal(e.code,'MISSING_INFORMATION');assert.ok(e.nextStep.includes('kind')||e.nextStep.includes('on_date')||e.nextStep.includes('status')||e.nextStep.includes('idempotency_key'))}
});
test('S3 wrong types and out-of-set values are rejected', ()=>{
  assert.throws(()=>assertValid(getDoctorSchedule.input,{doctor:42},{phase:'raw'}),e=>e.code==='INVALID_ARGUMENT');
  assert.throws(()=>assertValid(recordScheduleException.input,sharmaLeave({kind:'holiday'}),{phase:'raw'}),e=>e.code==='INVALID_ARGUMENT');
  assert.throws(()=>assertValid(getDoctorSchedule.input,{doctor:'x',days:99},{phase:'raw'}),e=>e.code==='INVALID_ARGUMENT');
});
test('S4 an impossible calendar date is refused after normalisation', ()=>{
  assert.throws(()=>assertValid(recordScheduleException.canonical,{doctor_id:DOC,doctor_name:'x',kind:'leave',on_date:'2026-02-30',status:'tentative',note:'',idempotency_key:KEY},{phase:'canonical'}),e=>e.code==='INVALID_ARGUMENT');
});
test('S5 output schemas are enforced', ()=>{
  assert.ok(validate(getDoctorSchedule.output,{doctor:{id:'x',name:'y'},window:{from:'a',to:'b'},weekly:[],exceptions:[]}).length===0);
  assert.ok(validate(getDoctorSchedule.output,{doctor:{id:'x',name:'y'},window:{from:'a',to:'b'},weekly:[],exceptions:[],extra:1}).length>0);
});

// ---------- Normalisation
test('N1 whitespace, casing and control characters are cleaned', ()=>{
  assert.equal(cleanText('  Dr.\t  SHARMA \u0007 '),'Dr. SHARMA');
});
test('N2 natural dates resolve against the organisation day', ()=>{
  assert.equal(resolveDate('tomorrow',TODAY).date,'2026-11-17');
  assert.equal(resolveDate('today',TODAY).date,'2026-11-16');
  assert.equal(resolveDate('next Tuesday',TODAY).date,'2026-11-17');   // Monday -> following Tuesday
  assert.equal(resolveDate('Monday',TODAY).date,'2026-11-16');          // bare weekday means on or after today
  assert.equal(resolveDate('next monday',TODAY).date,'2026-11-23');     // "next" is strictly after today
  assert.equal(resolveDate('11/20/2026',TODAY).date,'2026-11-20');
  assert.equal(resolveDate('2026-11-20',TODAY).date,'2026-11-20');
});
test('N3 unreadable or impossible dates are refused, never guessed', ()=>{
  assert.throws(()=>resolveDate('someday soon',TODAY),e=>e.code==='INVALID_ARGUMENT'&&e.nextStep.includes('YYYY-MM-DD'));
  assert.throws(()=>resolveDate('02/30/2026',TODAY),e=>e.code==='INVALID_ARGUMENT');
  assert.throws(()=>resolveDate('',TODAY),e=>e.code==='MISSING_INFORMATION');
});
test('N4 times normalise to 24-hour; a bare hour is treated as ambiguous', ()=>{
  assert.equal(resolveTime('9:30 pm'),'21:30');
  assert.equal(resolveTime('9am'),'09:00');
  assert.equal(resolveTime('12:15 PM'),'12:15');
  assert.equal(resolveTime('14:45'),'14:45');
  assert.throws(()=>resolveTime('9'),e=>e.code==='INVALID_ARGUMENT');
  assert.throws(()=>resolveTime('25:00'),e=>e.code==='INVALID_ARGUMENT');
});
test('N5 doctor names match despite titles, case and punctuation', ()=>{
  const d=[{id:'1',name:'Dr. Sharma'},{id:'2',name:'Dr. Patel'}];
  for(const q of ['Dr. Sharma','dr sharma','SHARMA','doctor sharma','  Dr.  Sharma  ']) assert.equal(matchEntity(q,d).entity.id,'1',q);
});
test('N6 two plausible doctors are never chosen silently', ()=>{
  const d=[{id:'1',name:'Dr. Sharma'},{id:'2',name:'Dr. Sharma Jr'}];
  assert.throws(()=>matchEntity('Sharma',d),e=>e.code==='AMBIGUOUS_ENTITY'&&e.alternatives.length===2);
});
test('N7 a single close spelling is accepted and reported as such', ()=>{
  const d=[{id:'1',name:'Dr. Sharma'},{id:'2',name:'Dr. Patel'}];
  const m=matchEntity('Sharmaa',d);
  assert.equal(m.entity.id,'1'); assert.equal(m.confidence,'near'); assert.equal(m.spelledAs,'Dr. Sharma');
});
test('N8 an unknown doctor lists the real names as alternatives', ()=>{
  const d=[{id:'1',name:'Dr. Sharma'},{id:'2',name:'Dr. Patel'}];
  try{matchEntity('Okonkwo',d);assert.fail()}catch(e){assert.equal(e.code,'ENTITY_NOT_FOUND');assert.deepEqual(e.alternatives,['Dr. Sharma','Dr. Patel'])}
});
test('N9 levenshtein is correct on known pairs', ()=>{
  assert.equal(levenshtein('kitten','sitting'),3);
  assert.equal(levenshtein('',''),0);
});

// ---------- Retry and timeout
test('R1 transient failures are retried, bounded, with jitter', async()=>{
  let calls=0;const slept=[];
  const r=await withRetry(async()=>{calls++;if(calls<3)throw new ToolError('UNAVAILABLE','busy');return 'done'},
    {attempts:5,baseMs:100,maxMs:1000,random:()=>1,sleep:async ms=>slept.push(ms)});
  assert.equal(r,'done'); assert.equal(calls,3);
  assert.deepEqual(slept,[100,200]);  // exponential, capped
});
test('R2 permanent errors are never retried', async()=>{
  let calls=0;
  await assert.rejects(withRetry(async()=>{calls++;throw new ToolError('PERMISSION_DENIED','no')},{attempts:5,sleep:async()=>{}}),e=>e.code==='PERMISSION_DENIED');
  assert.equal(calls,1);
});
test('R3 retries stop at the attempt limit', async()=>{
  let calls=0;
  await assert.rejects(withRetry(async()=>{calls++;throw new ToolError('UNAVAILABLE','busy')},{attempts:3,sleep:async()=>{}}),e=>e.code==='UNAVAILABLE');
  assert.equal(calls,3);
});
test('R4 a slow operation times out as retryable UNAVAILABLE', async()=>{
  await assert.rejects(withTimeout(new Promise(r=>setTimeout(r,200)),20,'lookup'),e=>e.code==='UNAVAILABLE'&&e.retryable===true);
});

// ---------- Errors
test('E1 unknown failures never leak internals to the model', ()=>{
  const env=toEnvelope(new Error('SELECT * FROM secret_table at line 42'));
  assert.equal(env.ok,false); assert.equal(env.error.code,'EXECUTION_FAILED');
  assert.ok(!env.error.message.includes('secret_table'));
  assert.equal(env.error.retryable,false);
});
test('E2 error codes outside the agreed list cannot be created', ()=>{
  assert.throws(()=>new ToolError('TOTALLY_NEW',"x"),/Unknown tool error code/);
  assert.ok(CODES.includes('RESOURCE_CONFLICT'));
});

// ---------- Registry
test('G1 duplicate names and tools without idempotency are rejected at load', ()=>{
  assert.throws(()=>new ToolRegistry([getDoctorSchedule,getDoctorSchedule]),/Duplicate tool/);
  assert.throws(()=>defineTool({...recordScheduleException,idempotent:undefined}),/idempotent/);
  assert.throws(()=>defineTool({...getDoctorSchedule,description:'short'}),/description/);
});
test('G2 unknown tools are refused with the valid names', async()=>{
  const db=fakeDb();
  const r=await executeTool(reg,'delete_everything',{},ctx(),db);
  assert.equal(r.ok,false); assert.equal(r.error.code,'INVALID_ARGUMENT');
  assert.ok(r.error.alternatives.includes('get_doctor_schedule'));
  assert.equal(db.calls.length,0,'no database call for an unknown tool');
});
test('G3 model definitions show each role only what it may use', ()=>{
  const staff=modelToolsFor(reg,{role:'staff'}), owner=modelToolsFor(reg,{role:'owner'});
  const enumOf=(tools,name)=>tools.find(t=>t.function.name===name).function.parameters.properties.status.enum;
  assert.deepEqual(enumOf(staff,'record_schedule_exception'),['tentative']);
  assert.deepEqual(enumOf(owner,'record_schedule_exception'),['tentative','confirmed']);
  assert.deepEqual(enumOf(staff,'update_business_fact'),['tentative']);
  for(const t of staff)assert.equal(t.type,'function');
  const hasExt=JSON.stringify(owner).includes('"x-normalise"');
  assert.equal(hasExt,false,'vendor extensions must not reach the model');
});

// ---------- Executor: permissions, validation and idempotency (fake database)
test('X1 malformed input is refused before any database call', async()=>{
  const db=fakeDb();
  const r=await executeTool(reg,'record_schedule_exception',{doctor:'Sharma'},ctx(),db);
  assert.equal(r.error.code,'MISSING_INFORMATION');
  assert.equal(db.calls.length,0);
});
test('X2 a non-member is refused and no idempotency key is claimed', async()=>{
  const db=fakeDb({role:null});
  const r=await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  assert.equal(r.error.code,'PERMISSION_DENIED');
  assert.ok(!db.calls.some(c=>c[0]==='claim'));
});
test('X3 staff cannot confirm, and nothing is written', async()=>{
  const db=fakeDb({role:'staff'});
  const r=await executeTool(reg,'record_schedule_exception',sharmaLeave({status:'confirmed'}),ctx(),db);
  assert.equal(r.error.code,'PERMISSION_DENIED');
  assert.ok(!db.calls.some(c=>c[0]==='createException'));
});
test('X4 an ambiguous doctor is reported with options and nothing is written', async()=>{
  const db=fakeDb({doctors:[{id:'1',name:'Dr. Sharma'},{id:'2',name:'Dr. Sharma Jr'}]});
  const r=await executeTool(reg,'record_schedule_exception',sharmaLeave({doctor:'Sharma'}),ctx(),db);
  assert.equal(r.error.code,'AMBIGUOUS_ENTITY');
  assert.equal(r.error.alternatives.length,2);
  assert.ok(!db.calls.some(c=>c[0]==='createException'));
});
test('X5 a past date is refused with a clear next step', async()=>{
  const db=fakeDb();
  const r=await executeTool(reg,'record_schedule_exception',sharmaLeave({on_date:'2026-11-01'}),ctx(),db);
  assert.equal(r.error.code,'PRECONDITION_FAILED');
  assert.equal(r.error.field,'on_date');
});
test('X6 a valid write succeeds once and is recorded', async()=>{
  const db=fakeDb();
  const r=await executeTool(reg,'record_schedule_exception',sharmaLeave({on_date:'tomorrow'}),ctx(),db);
  assert.equal(r.ok,true, JSON.stringify(r));
  assert.equal(r.data.status,'tentative');
  assert.equal(r.data.on_date,'2026-11-17');
  assert.equal(r.meta.replayed,false);
  assert.equal(db.calls.filter(c=>c[0]==='createException').length,1);
  assert.equal(db._finished.at(-1).status,'succeeded');
});
test('X7 repeating the same call replays the result and never repeats the change', async()=>{
  const db=fakeDb();
  const first=await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  const second=await executeTool(reg,'record_schedule_exception',sharmaLeave({doctor:'dr sharma'}),ctx(),db);
  assert.equal(first.ok&&second.ok,true);
  assert.equal(second.meta.replayed,true);
  assert.equal(db.calls.filter(c=>c[0]==='createException').length,1,'the change must happen once');
});
test('X8 the same key for a different request is refused', async()=>{
  const db=fakeDb();
  await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  const r=await executeTool(reg,'record_schedule_exception',sharmaLeave({on_date:'2026-11-22'}),ctx(),db);
  assert.equal(r.error.code,'INVALID_ARGUMENT');
  assert.match(r.error.message,/different request/);
});
test('X9 a transient failure is retryable, and a retry after a recorded effect does not repeat it', async()=>{
  let fail=true;
  const db=fakeDb({createException:async(a)=>{ if(fail){fail=false;throw new ToolError('UNAVAILABLE','db busy')} return EX}});
  const r1=await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  assert.equal(r1.error.code,'UNAVAILABLE'); assert.equal(r1.error.retryable,true);
  assert.equal(db._finished.at(-1).status,'interrupted','an interrupted write is recorded as interrupted, not failed');
  const r2=await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  assert.equal(r2.ok,true);
});
test('X10 an interrupted write whose effect exists is recovered, not repeated', async()=>{
  const db=fakeDb({createException:async()=>{throw new ToolError('UNAVAILABLE','lost response')},
    findExceptionByRef:async()=>({id:EX2,on_date:'2026-11-20',kind:'leave',status:'tentative'})});
  await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  const retry=await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  assert.equal(retry.ok,true);
  assert.equal(retry.data.exception_id,EX2);
  assert.equal(retry.meta.replayed,true);
});
test('X11 a permanent failure is recorded as failed, and the same key can be tried again later', async()=>{
  let n=0;
  const db=fakeDb({createException:async()=>{n++;if(n===1)throw new ToolError('PRECONDITION_FAILED','closed',{retryable:false});return EX2}});
  const r1=await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  assert.equal(r1.error.code,'PRECONDITION_FAILED');
  assert.equal(db._finished.at(-1).status,'failed');
  const r2=await executeTool(reg,'record_schedule_exception',sharmaLeave(),ctx(),db);
  assert.equal(r2.ok,true);
});
test('X12 a reply that breaks the output schema is refused as VERIFICATION_FAILED', async()=>{
  const db=fakeDb({createException:async()=>EX2});
  const broken=new ToolRegistry([{...recordScheduleException,run:async()=>({wrong:true})}]);
  const r=await executeTool(broken,'record_schedule_exception',sharmaLeave(),ctx(),db);
  assert.equal(r.error.code,'VERIFICATION_FAILED');
  assert.equal(db._finished.at(-1).status,'failed');
});
test('X13 read tools retry transient failures; writes are not retried blindly', async()=>{
  let n=0;
  const db=fakeDb({rulesFor:async()=>{n++;if(n<3)throw new ToolError('UNAVAILABLE','busy');return []}});
  const r=await executeTool(reg,'get_doctor_schedule',{doctor:'Sharma'},ctx(),db);
  assert.equal(r.ok,true); assert.equal(n,3);
});
test('X14 unexpected database errors surface as EXECUTION_FAILED without internals', async()=>{
  const db=fakeDb({factById:async()=>{throw new Error('connection string postgres://user:pw@host')}});
  const r=await executeTool(reg,'update_business_fact',{fact_id:FACT,value:'New',status:'tentative',idempotency_key:KEY},ctx(),db);
  assert.equal(r.error.code,'EXECUTION_FAILED');
  assert.ok(!JSON.stringify(r).includes('pw@host'));
});
test('X15 a tool that runs too long returns a retryable timeout', async()=>{
  const slow=new ToolRegistry([{...getDoctorSchedule,timeoutMs:20,run:()=>new Promise(r=>setTimeout(()=>r({}),200))}]);
  const r=await executeTool(slow,'get_doctor_schedule',{doctor:'Sharma'},ctx(),fakeDb());
  assert.equal(r.error.code,'UNAVAILABLE'); assert.equal(r.error.retryable,true);
});
test('X16 staff correction is saved as tentative and never confirmed', async()=>{
  const db=fakeDb({role:'staff'});
  const r=await executeTool(reg,'update_business_fact',{fact_id:FACT,value:'New hours',status:'confirmed',idempotency_key:KEY},ctx(),db);
  assert.equal(r.error.code,'PERMISSION_DENIED');
  assert.ok(!db.calls.some(c=>c[0]==='supersedeFact'));
});
test('X17 an owner correction supersedes and returns the new item', async()=>{
  const db=fakeDb();
  const r=await executeTool(reg,'update_business_fact',{fact_id:FACT.toUpperCase(),value:'New hours',status:'confirmed',idempotency_key:KEY},ctx(),db);
  assert.equal(r.ok,true, JSON.stringify(r));
  assert.equal(r.data.fact_id,NEWF); assert.equal(r.data.replaces,FACT);
  const sup=db.calls.find(c=>c[0]==='supersedeFact')[1];
  assert.equal(sup.factId,FACT); assert.equal(sup.value,'New hours');
});
test('X18 an unchanged correction is refused rather than writing history for nothing', async()=>{
  const db=fakeDb();
  const r=await executeTool(reg,'update_business_fact',{fact_id:FACT,value:'Old',status:'confirmed',idempotency_key:KEY},ctx(),db);
  assert.equal(r.error.code,'PRECONDITION_FAILED');
});
test('X19 a missing item is ENTITY_NOT_FOUND', async()=>{
  const db=fakeDb({factById:async()=>null});
  const r=await executeTool(reg,'update_business_fact',{fact_id:MISSING,value:'x',status:'tentative',idempotency_key:KEY},ctx(),db);
  assert.equal(r.error.code,'ENTITY_NOT_FOUND');
});
test('X20 a caller can never supply an organisation or user identity in the arguments', async()=>{
  const db=fakeDb();
  const r=await executeTool(reg,'get_doctor_schedule',{doctor:'Sharma',org_id:'someone-else'},ctx(),db);
  assert.equal(r.error.code,'INVALID_ARGUMENT');
  assert.equal(r.error.field,'org_id');
});

// ======================= Phase 3: conversational extraction, model loop, front desk, roles =======================
import {buildRegistry} from '../../supabase/functions/_shared/tools/index.js';
import {runToolLoop} from '../../supabase/functions/_shared/tools/loop.js';
import {todayIn} from '../../supabase/functions/_shared/tools/normalise.js';

const full=buildRegistry();
const FRI='2026-11-13';
const P1='aaaaaaaa-0000-4000-8000-0000000000a1', P2='aaaaaaaa-0000-4000-8000-0000000000a2';
/* applyItem records each item the engine would persist. Contradiction and supersession rules live in the database and are tested there. */
const extractDb=(over={})=>{
  const applied=[];
  return Object.assign(fakeDb({role:'owner'}),{applied,
    async applyItem(org,item,ref){applied.push({item,ref});return{result:'created',id:EX}},
    async listFacts(){return[{id:FACT,category:'policy',key:'parking',value:'Free parking behind the clinic',status:'confirmed'}]},
  },over);
};
const rec=(db,items,over={},who={})=>executeTool(full,'record_business_information',{items,idempotency_key:KEY,...over},ctx({today:FRI,...who}),db);
const SHARMA_MSG='Dr. Sharma usually works Monday, Wednesday and Friday, but might be unavailable next Tuesday.';
const sharmaItems=[
  {type:'weekly_hours',entity:'Dr. Sharma',weekdays:'Monday, Wednesday and Friday',hours:'9am-5pm',status:'confirmed',source_quote:'usually works Monday, Wednesday and Friday'},
  {type:'leave',entity:'Dr. Sharma',kind:'unavailable',date:'next Tuesday',status:'tentative',source_quote:'might be unavailable next Tuesday'}];

test('E1 the worked example: recurring schedule kept, Tuesday recorded as tentative, source preserved', async()=>{
  const db=extractDb();
  const r=await rec(db,sharmaItems,{},{userMessage:SHARMA_MSG});
  assert.equal(r.ok,true);
  const hours=db.applied.filter(a=>a.item.type==='weekly_hours'), exc=db.applied.filter(a=>a.item.type==='exception');
  assert.deepEqual(hours.map(a=>a.item.weekday),[1,3,5]);
  assert.equal(hours[0].item.start_min,540);assert.equal(hours[0].item.end_min,1020);
  assert.equal(exc.length,1);assert.equal(exc[0].item.on_date,'2026-11-17');assert.equal(exc[0].item.status,'tentative');
  assert.equal(exc[0].item.entity_id,DOC);assert.ok(exc[0].item.source_quote.includes('might be unavailable'));
  assert.ok(r.data.summary.some(l=>l.includes('2026-11-17')&&l.includes('TENTATIVE')));
  assert.equal(r.data.counts.created,4);
});
test('E2 an ambiguous doctor asks a question and the other items still save', async()=>{
  const db=extractDb({doctors:[{id:P1,name:'Dr. Anil Patel'},{id:P2,name:'Dr. Raj Patel'}]});
  const r=await rec(db,[{type:'leave',entity:'Dr. Patel',date:'2026-11-20',status:'tentative',source_quote:'Patel is off'},
    {type:'fact',category:'policy',key:'parking',value:'Free parking',status:'tentative',source_quote:'parking is free'}]);
  const [a,b]=r.data.outcomes;
  assert.equal(a.result,'needs_clarification');assert.deepEqual(a.alternatives,['Dr. Anil Patel','Dr. Raj Patel']);
  assert.equal(b.result,'created');assert.equal(db.applied.length,1);assert.equal(r.data.clarification_needed,true);
});
test('E3 tentative wording is never saved as confirmed, even if the model says confirmed', async()=>{
  const db=extractDb();
  const r=await rec(db,[{type:'leave',entity:'Dr. Sharma',date:'2026-11-20',status:'confirmed',source_quote:'might be off on the 20th'}]);
  assert.equal(db.applied[0].item.status,'tentative');assert.equal(r.data.outcomes[0].downgraded_to_tentative,true);
});
test('E4 staff cannot record confirmed information; only that item is refused', async()=>{
  const db=extractDb({role:'staff'});
  const r=await rec(db,[{type:'fact',category:'policy',key:'parking',value:'Free',status:'confirmed',source_quote:'parking is free'},
    {type:'fact',category:'policy',key:'wifi',value:'Ask at desk',status:'tentative',source_quote:'wifi at desk'}]);
  assert.equal(r.data.outcomes[0].result,'rejected');assert.equal(r.data.outcomes[0].reason,'PERMISSION_DENIED');
  assert.equal(r.data.outcomes[1].result,'created');
  assert.deepEqual(modelToolsFor(full,{role:'staff',surface:'staff'}).find(t=>t.function.name==='record_business_information').function.parameters.properties.items.items.properties.status.enum,['tentative']);
});
test('E5 dates follow the organisation time zone', async()=>{
  const now=new Date('2026-11-13T20:00:00Z');   // 01:30 on the 14th in Kolkata, still the 13th in UTC
  const item=[{type:'leave',entity:'Dr. Sharma',date:'tomorrow',status:'tentative',source_quote:'off tomorrow'}];
  for(const [tz,want] of [['Asia/Kolkata','2026-11-15'],['UTC','2026-11-14']]){
    const db=extractDb();
    await executeTool(full,'record_business_information',{items:item,idempotency_key:KEY},{orgId:ORG,userId:USER,timeZone:tz,now},db);
    assert.equal(db.applied[0].item.on_date,want,tz);
  }
  const db=extractDb({async orgTimezone(){return 'Asia/Kolkata'}});   // read from the organisation when the caller gives none
  await executeTool(full,'record_business_information',{items:item,idempotency_key:KEY},{orgId:ORG,userId:USER,now},db);
  assert.equal(db.applied[0].item.on_date,'2026-11-15');
  assert.equal(todayIn('Asia/Kolkata',now),'2026-11-14');
});
test('E6 invalid or incomplete items never reach the database', async()=>{
  const db=extractDb();
  const r=await rec(db,[
    {type:'weekly_hours',entity:'Dr. Sharma',weekdays:'Mon',status:'tentative',source_quote:'works Monday'},                       // no hours
    {type:'weekly_hours',entity:'Dr. Sharma',weekdays:'Mon',hours:'9-5',status:'tentative',source_quote:'works Monday 9-5'},      // am or pm?
    {type:'leave',entity:'Dr. Sharma',date:'2026-11-01',status:'tentative',source_quote:'was off'},                                // passed
    {type:'leave',entity:'Dr. Nobody',date:'2026-11-20',status:'tentative',source_quote:'off'},                                   // unknown
    {type:'leave',entity:'Dr. Sharma',date:'someday',status:'tentative',source_quote:'off someday'},                              // unreadable
    {type:'leave',entity:'Dr. Sharma',date:'2026-11-20',note:'patient John Smith 98765 43210',status:'tentative',source_quote:'off'}, // patient info
    {type:'fact',category:'policy',status:'tentative',source_quote:'we have a policy'},                                           // no key or value
    {type:'leave',date:'2026-11-20',status:'tentative',source_quote:'off'}]);                                                    // no doctor
  assert.deepEqual(r.data.outcomes.map(o=>o.result),['needs_clarification','needs_clarification','rejected','rejected','rejected','rejected','needs_clarification','needs_clarification']);
  assert.equal(r.data.outcomes[5].reason,'PRECONDITION_FAILED');assert.equal(db.applied.length,0);
  assert.deepEqual(r.data.outcomes[3].alternatives,['Dr. Sharma','Dr. Patel']);
});
test('E7 the source quote must be the staff member\'s own words', async()=>{
  const db=extractDb();
  const r=await rec(db,[{type:'leave',entity:'Dr. Sharma',date:'2026-11-20',status:'tentative',source_quote:'she told me she is off'}],{},{userMessage:'Sharma might be off on the 20th'});
  assert.equal(r.data.outcomes[0].result,'rejected');assert.equal(db.applied.length,0);
});
test('E8 ranges expand per day; over 31 days is refused; weekday lists and months parse', async()=>{
  const db=extractDb();
  const r=await rec(db,[{type:'leave',entity:'Dr. Sharma',date:'Dec 1',to_date:'Dec 3',status:'tentative',source_quote:'off Dec 1 to Dec 3'},
    {type:'leave',entity:'Dr. Sharma',date:'2026-12-01',to_date:'2027-02-01',status:'tentative',source_quote:'off for two months'}]);
  assert.deepEqual(db.applied.map(a=>a.item.on_date),['2026-12-01','2026-12-02','2026-12-03']);
  assert.equal(r.data.outcomes.at(-1).result,'rejected');
});
test('E9 a repeated call with the same key replays and does not write again', async()=>{
  const db=extractDb();
  await rec(db,sharmaItems);const n=db.applied.length;
  const again=await rec(db,sharmaItems);
  assert.equal(again.meta.replayed,true);assert.equal(db.applied.length,n);
  const other=await rec(db,sharmaItems.slice(1),{idempotency_key:'different-key-1'});
  assert.equal(other.ok,true);   // a new key is a new request; the database reports duplicates
});
test('E10 doctors and customer chats cannot reach restricted tools, however the call is made', async()=>{
  const docDb=extractDb({role:'doctor'});
  assert.equal((await rec(docDb,sharmaItems)).error.code,'PERMISSION_DENIED');
  assert.equal(docDb.applied.length,0);
  const names=r=>modelToolsFor(full,r).map(t=>t.function.name);
  assert.deepEqual(names({role:'doctor',surface:'staff'}).sort(),['find_business_information','get_doctor_schedule']);
  assert.ok(!names({role:'staff',surface:'front'}).includes('record_business_information'));
  const staffDb=extractDb({role:'owner'});
  const viaFront=await executeTool(full,'add_doctor',{name:'Dr. X',days:'Mon',hours:'9am-5pm'},ctx({surface:'front'}),staffDb);
  assert.equal(viaFront.error.code,'PERMISSION_DENIED');
  // Patient-information tools are closed to doctors even if called directly.
  const phone=await executeTool(full,'find_bookings',{phone:'9876543210'},ctx(),extractDb({role:'doctor'}));
  assert.equal(phone.error.code,'PERMISSION_DENIED');
});
test('E11 patient information is refused by code in other write tools too', async()=>{
  const r=await executeTool(full,'update_business_fact',{fact_id:FACT,value:'Call Mrs Rao on rao@example.com',status:'tentative',idempotency_key:KEY},ctx(),extractDb());
  assert.equal(r.error.code,'PRECONDITION_FAILED');
});
test('E12 find_business_information returns recorded facts for the model to check first', async()=>{
  const r=await executeTool(full,'find_business_information',{query:'parking'},ctx({surface:'staff'}),extractDb({role:'doctor'}));
  assert.equal(r.data.matches[0].key,'parking');
});

// ---- Model integration: mocked provider, real registry and executor ----
const call=(name,args,id='c1')=>({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args)}}]});
const loop=(db,script,over={})=>{
  const seen=[];let i=0;
  return runToolLoop({callModel:async(m,t)=>{seen.push({m:m.length,t});return script[i++]},registry:full,db,role:'owner',surface:'staff',
    ctx:{orgId:ORG,userId:USER,today:FRI},system:'sys',messages:[{role:'user',content:SHARMA_MSG}],...over}).then(r=>({...r,seen}));
};
test('M1 the model receives the registry\'s own definitions and its tool call runs through the executor', async()=>{
  const db=extractDb();
  const r=await loop(db,[call('record_business_information',{items:sharmaItems,idempotency_key:KEY}),{role:'assistant',content:'Saved. Tuesday is tentative.'}]);
  assert.deepEqual(r.seen[0].t,modelToolsFor(full,{role:'owner',surface:'staff'}));
  assert.equal(r.reply,'Saved. Tuesday is tentative.');assert.equal(db.applied.length,4);
  assert.deepEqual(r.calls,[{name:'record_business_information',ok:true,code:null}]);
  assert.ok(db.calls.some(c=>c[0]==='claim'));   // idempotency claim, i.e. the full pipeline ran
});
test('M2 typed errors go back to the model, which can fix its input and continue (multi-step)', async()=>{
  const db=extractDb();
  const bad={items:[{type:'leave',entity:'Dr. Sharma',date:'2026-11-20',status:'tentative'}],idempotency_key:KEY};   // missing source_quote
  const r=await loop(db,[call('record_business_information',bad),call('record_business_information',{items:[{...bad.items[0],source_quote:'might be unavailable'}],idempotency_key:'second-key-1'},'c2'),{role:'assistant',content:'Done.'}]);
  assert.deepEqual(r.calls.map(c=>c.code),['MISSING_INFORMATION',null]);assert.equal(db.applied.length,1);
});
test('M3 unreadable arguments, unknown tools and stuck loops are handled safely', async()=>{
  const db=extractDb();
  const r1=await loop(db,[call('record_business_information','{not json'),{role:'assistant',content:'ok'}]);
  assert.equal(r1.calls[0].code,'INVALID_ARGUMENT');
  const r2=await loop(db,[call('drop_everything',{}),{role:'assistant',content:'ok'}]);
  assert.equal(r2.calls[0].code,'INVALID_ARGUMENT');
  const stuck=Array.from({length:5},(_,i)=>call('get_doctor_schedule',{doctor:'Nobody'},'s'+i));
  const r3=await loop(db,stuck);
  assert.equal(r3.stopped,'repeated_error');assert.equal(r3.calls.length,3);
  assert.equal(db.applied.length,0);
});
test('M4 a staff member\'s own role limits what the model is offered and allowed', async()=>{
  const db=extractDb({role:'staff'});
  const r=await loop(db,[call('add_doctor',{name:'Dr. X',days:'Mon',hours:'9am-5pm'}),{role:'assistant',content:'No.'}],{role:'staff'});
  assert.equal(r.calls[0].code,'PERMISSION_DENIED');   // not offered to staff, and refused by the executor if called anyway
  assert.ok(!r.seen[0].t.some(t=>t.function.name==='add_doctor'));
});

// ---- Legacy front-desk regression: same behaviour, now through the registry ----
const DR1='d1111111-1111-4111-8111-111111111111';
const frontDb=(over={})=>{
  const store={bookings:[],audit:[]};
  return Object.assign(fakeDb({role:'staff'}),{store,legacy:{
    async list(o,t){return t==='doctors'?[{id:DR1,name:'Dr. Rao',specialty:'',services:['Cleaning','Exam'],days:[1,2,3,4,5],start:'08:00',end:'16:00',slot:30}]
      :t==='bookings'?store.bookings:t==='services'?[{name:'Cleaning'},{name:'Exam'}]:t==='closures'?[{date:'2026-12-25'}]
      :[{title:'Parking',keywords:'parking car',body:'Free parking behind the clinic.'}]},
    async addBooking(o,b){const r={id:'b'+store.bookings.length,...b};store.bookings.push(r);return r},
    async setBookingStatus(o,id,s){store.bookings.find(b=>b.id===id).status=s},
  },async logAudit(o,a,t){store.audit.push([a,t])}},over);
};
// These front-desk fixtures are an Indian clinic, so a bare 10-digit number is read as Indian (US clinics read it as US: see P5 tests).
const front=(db,name,args,out={})=>executeTool(full,name,args,ctx({surface:'front',timeZone:'Asia/Kolkata',localNow:'2026-11-13T10:00',requestId:'turn-1',out}),db);
const SLOT='2026-11-16T09:00';   // a Monday
test('F1 booking works, picks the doctor, normalises the phone, audits, and flags the chat', async()=>{
  const db=frontDb(),out={};
  const r=await front(db,'book_appointment',{name:' Asha ',phone:'98765 43210',service:'Cleaning',when:SLOT},out);
  assert.equal(r.ok,true);assert.equal(r.data.doctor,'Dr. Rao');
  assert.equal(db.store.bookings[0].phone,'+919876543210');assert.equal(out.booked,true);
  assert.equal(db.store.audit[0][0],'booking');
});
test('F2 the same booking request is replayed, never doubled', async()=>{
  const db=frontDb();
  const a=await front(db,'book_appointment',{name:'Asha',phone:'9876543210',service:'Cleaning',when:SLOT});
  const b=await front(db,'book_appointment',{name:'Asha',phone:'9876543210',service:'Cleaning',when:SLOT});
  assert.equal(b.meta.replayed,true);assert.equal(db.store.bookings.length,1);assert.equal(a.data.booking_id,b.data.booking_id);
});
test('F3 taken times, closed days, bad phones, past times and unknown services return typed errors with alternatives', async()=>{
  const db=frontDb();
  db.store.bookings.push({id:'x',phone:'+911111111111',when:SLOT,doctor_id:DR1,status:'booked'});
  const taken=await front(db,'book_appointment',{name:'A',phone:'9876543210',service:'Cleaning',when:SLOT});
  assert.equal(taken.error.code,'RESOURCE_CONFLICT');assert.ok(taken.error.alternatives.length>0);
  assert.equal((await front(db,'book_appointment',{name:'A',phone:'9876543210',service:'Cleaning',when:'2026-12-25T09:00'})).error.code,'PRECONDITION_FAILED');
  assert.equal((await front(db,'book_appointment',{name:'A',phone:'12345',service:'Cleaning',when:'2026-11-17T09:00'})).error.field,'phone');
  assert.equal((await front(db,'book_appointment',{name:'A',phone:'9876543210',service:'Cleaning',when:'2026-11-12T09:00'})).error.code,'PRECONDITION_FAILED');
  assert.equal((await front(db,'book_appointment',{name:'A',phone:'9876543210',service:'Surgery',when:'2026-11-17T09:00'})).error.code,'INVALID_ARGUMENT');
});
test('F4 find and cancel a booking, availability, answers, handoff and forms still work', async()=>{
  const db=frontDb(),out={};
  await front(db,'book_appointment',{name:'Asha',phone:'9876543210',service:'Cleaning',when:SLOT});
  assert.equal((await front(db,'find_bookings',{phone:'+91 98765 43210'})).data.bookings.length,1);
  const av=await front(db,'check_availability',{date:'2026-11-16'});assert.ok(av.data.slots.length>0&&!av.data.slots.some(s=>s.time==='09:00'));
  assert.equal((await front(db,'cancel_booking',{phone:'9876543210',when:SLOT})).data.cancelled,true);
  assert.equal(db.store.bookings[0].status,'cancelled');assert.equal((await front(db,'cancel_booking',{phone:'9876543210',when:SLOT})).meta.replayed,true);   // same turn, same request: replayed
  const later=await executeTool(full,'cancel_booking',{phone:'9876543210',when:SLOT},ctx({surface:'front',localNow:'2026-11-13T10:00',requestId:'turn-2',out}),db);
  assert.equal(later.error.code,'ENTITY_NOT_FOUND');   // a later request finds nothing left to cancel
  assert.equal((await front(db,'search_answers',{query:'where can I park'})).data.matches[0].topic,'Parking');
  await front(db,'request_handoff',{reason:'upset'},out);assert.equal(out.handoff,true);assert.equal(out.reason,'upset');
  await front(db,'show_form',{title:'Details',fields:[{name:'service',label:'Service',type:'text'}]},out);assert.equal(out.form.fields[0].type,'select');
  assert.equal((await front(db,'get_time',{})).data.now,'2026-11-13 10:00');
});
test('F5 every tool, front or setup, is defined exactly once and validates at load', ()=>{
  const names=full.list().map(t=>t.name);
  assert.equal(new Set(names).size,names.length);
  for(const n of ['get_time','search_answers','list_doctors','check_availability','book_appointment','find_bookings','cancel_booking','show_form','doctor_busy_times','request_handoff','add_doctor','record_business_information'])assert.ok(names.includes(n),n);
});

// ---------- Phase 4: website visitors run as the "public" principal ----------
import {buildRegistry as buildFullRegistry} from '../../supabase/functions/_shared/tools/index.js';
import {wantsBooking,bookingForm} from '../../supabase/functions/_shared/tools/front.js';

const CONV='12121212-1212-4212-8212-121212121212';
function publicDb({autoConfirm=false,taken=false}={}){
  const added=[],audits=[],claims=new Map();
  return{added,audits,
    async membershipRole(){throw new Error('public calls must never look up membership')},
    async orgTimezone(){return 'America/New_York'},
    async bookingPolicy(){return{autoConfirm}},
    async logAudit(o,a,t){audits.push([a,t])},
    async claimExecution({tool,key,hash,actorId}){assert.equal(actorId,null);const k=tool+key;if(claims.has(k))return{claimed:false,row:claims.get(k)};claims.set(k,{status:'started',input_hash:hash});return{claimed:true}},
    async takeOverExecution(){return false},
    async finishExecution({tool,key,status,result}){Object.assign(claims.get(tool+key),{status,result})},
    legacy:{
      async list(o,t){return{doctors:[{id:'d1',name:'Dr. Rao',services:['Cleaning'],days:[1,2,3,4,5],start:'09:00',end:'12:00',slot:30}],
        bookings:[],services:[{name:'Cleaning'}],closures:[{date:'2026-11-20'}],kb:[{title:'Parking',body:'Free parking behind the clinic.',keywords:'parking car'}]}[t]},
      async addBooking(o,b){if(taken)throw new ToolError('RESOURCE_CONFLICT','dup');added.push(b);return{id:'b1'}},
    }};
}
const pctx=(over={})=>({orgId:ORG,conversationId:CONV,surface:'public',now:new Date('2026-11-16T12:00:00Z'),out:{},requestId:'r1',...over});
const REQ={name:'Ana Diaz',phone:'+1 415 555 0132',service:'Cleaning',when:'2026-11-17T10:00'};

test('public: only website-safe tools are offered to the model',()=>{
  const names=modelToolsFor(buildFullRegistry(),{role:'public',surface:'public'}).map(t=>t.function.name).sort();
  assert.deepEqual(names,['check_availability','get_time','list_doctors','request_appointment','request_handoff','search_answers','show_form']);
});

test('public: cannot reach patient lookups, staff bookings or setup tools',async()=>{
  const r=buildFullRegistry(),db=publicDb();
  for(const [n,a] of [['find_bookings',{phone:'4155550132'}],['cancel_booking',{phone:'4155550132',when:'2026-11-17T10:00'}],['book_appointment',REQ],
    ['doctor_busy_times',{date:'2026-11-17'}],['add_doctor',{name:'X',days:'Mon',hours:'9am-5pm'}],['remove_doctor',{name:'Dr. Rao'}]]){
    const env=await executeTool(r,n,a,pctx(),db);
    assert.equal(env.ok,false,n);assert.equal(env.error.code,'PERMISSION_DENIED',n);
  }
  assert.equal(db.added.length,0);
});

test('public: a call without a verified chat is refused',async()=>{
  const env=await executeTool(buildFullRegistry(),'search_answers',{query:'parking'},pctx({conversationId:undefined}),publicDb());
  assert.equal(env.error.code,'PERMISSION_DENIED');
});

test('public: answers questions without membership',async()=>{
  const env=await executeTool(buildFullRegistry(),'search_answers',{query:'where to park the car'},pctx(),publicDb());
  assert.equal(env.ok,true);assert.equal(env.data.matches[0].topic,'Parking');
});

test('public: request_appointment holds the slot as a request for the team, tied to the chat',async()=>{
  const db=publicDb(),out={};
  const env=await executeTool(buildFullRegistry(),'request_appointment',REQ,pctx({out}),db);
  assert.equal(env.ok,true,JSON.stringify(env));
  assert.equal(env.data.status,'requested');assert.equal(env.data.doctor,'Dr. Rao');
  assert.equal(db.added[0].status,'requested');assert.equal(db.added[0].source,'website');assert.equal(db.added[0].conversation_id,CONV);
  assert.equal(out.requested,true);assert.equal(out.booked,false);
  assert.equal(db.audits[0][0],'booking.requested');
});

test('public: auto-confirm books straight away',async()=>{
  const db=publicDb({autoConfirm:true});
  const env=await executeTool(buildFullRegistry(),'request_appointment',REQ,pctx(),db);
  assert.equal(env.data.status,'booked');assert.equal(db.added[0].status,'booked');
});

test('public: closed days, past times, unknown services and bad phones are refused before writing',async()=>{
  const r=buildFullRegistry(),db=publicDb();
  const cases=[[{when:'2026-11-20T10:00'},'PRECONDITION_FAILED'],[{when:'2026-11-16T06:00'},'PRECONDITION_FAILED'],[{service:'Botox'},'INVALID_ARGUMENT'],[{phone:'12'},'INVALID_ARGUMENT'],[{when:'2026-11-17T15:00'},'RESOURCE_CONFLICT']];
  for(const [over,code] of cases){
    const env=await executeTool(r,'request_appointment',{...REQ,...over},pctx(),db);
    assert.equal(env.ok,false,JSON.stringify(over));assert.equal(env.error.code,code,JSON.stringify(over));
  }
  assert.equal(db.added.length,0);
});

test('public: a slot taken at the last moment returns alternatives',async()=>{
  const env=await executeTool(buildFullRegistry(),'request_appointment',REQ,pctx(),publicDb({taken:true}));
  assert.equal(env.error.code,'RESOURCE_CONFLICT');assert.ok(env.error.alternatives.length>0);
});

test('public: the same request key never books twice',async()=>{
  const r=buildFullRegistry(),db=publicDb(),args={...REQ,idempotency_key:'req-0001-abcdef'};
  const a=await executeTool(r,'request_appointment',args,pctx(),db),b=await executeTool(r,'request_appointment',args,pctx(),db);
  assert.equal(a.ok,true);assert.equal(b.meta.replayed,true);assert.equal(db.added.length,1);
});

test('staff surfaces cannot use the website-only booking tool',async()=>{
  const db=fakeDb();
  const env=await executeTool(buildFullRegistry(),'request_appointment',REQ,{orgId:ORG,userId:USER,surface:'front'},db);
  assert.equal(env.error.code,'PERMISSION_DENIED');
});

test('booking intent shows the booking picker form',()=>{
  assert.equal(wantsBooking([{role:'user',content:'Can I book a cleaning?'}]),true);
  assert.equal(wantsBooking([{role:'user',content:'I need to cancel my appointment'}]),false);
  assert.deepEqual(bookingForm(['Cleaning']).fields.map(f=>f.name),['name','phone','service','when']);
});

// ---------- Phase 5: self-service, leave-aware availability, confirmed info, setup tools, US phones, insights ----------
import {normalizePhone,countryForTimeZone} from '../../supabase/functions/_shared/tools/phone.js';
import {wantsManage} from '../../supabase/functions/_shared/tools/front.js';
import {computeInsights} from '../../src/lib/insights.js';

const ME='+14155550132',OTHER='+12125550199';
function ssDb({ex=[],facts=[]}={}){
  const db=publicDb();
  const bookings=[{id:'aaaaaaaa-1111-4111-8111-111111111111',name:'Ana Diaz',phone:ME,service:'Cleaning',when:'2026-11-17T10:00',doctor_id:'d1',doctor:'Dr. Rao',status:'booked'},
                  {id:'bbbbbbbb-2222-4222-8222-222222222222',name:'Ben Lee',phone:OTHER,service:'Cleaning',when:'2026-11-17T11:00',doctor_id:'d1',doctor:'Dr. Rao',status:'booked'}];
  const list=db.legacy.list;
  db.updates=[];
  db.legacy.list=async(o,t)=>t==='bookings'?bookings:list(o,t);
  db.legacy.setBookingStatus=async(o,id,status)=>{bookings.find(b=>b.id===id).status=status;db.updates.push(['status',id,status])};
  db.legacy.updateBooking=async(o,id,b)=>{db.updates.push(['move',id,b])};
  db.confirmedExceptions=async()=>ex;
  db.confirmedFacts=async()=>facts;
  return db;
}
const MINE='aaaaaaaa-1111-4111-8111-111111111111',THEIRS='bbbbbbbb-2222-4222-8222-222222222222';
const vctx=(over={})=>pctx({verifiedPhone:ME,...over});

test('P5 self-service needs a verified phone',async()=>{
  const r=buildFullRegistry(),db=ssDb();
  for(const [n,a] of [['my_appointments',{}],['cancel_my_appointment',{booking_id:MINE}],['reschedule_my_appointment',{booking_id:MINE,when:'2026-11-18T09:00'}]]){
    const env=await executeTool(r,n,a,pctx(),db);assert.equal(env.error.code,'PERMISSION_DENIED',n);
  }
  assert.equal(db.updates.length,0);
});

test('P5 a verified patient sees and changes only their own appointments',async()=>{
  const r=buildFullRegistry(),db=ssDb();
  const l=await executeTool(r,'my_appointments',{},vctx(),db);
  assert.deepEqual(l.data.appointments.map(b=>b.id),[MINE]);
  const x=await executeTool(r,'cancel_my_appointment',{booking_id:THEIRS},vctx(),db);
  assert.equal(x.error.code,'ENTITY_NOT_FOUND');
  const c=await executeTool(r,'cancel_my_appointment',{booking_id:MINE},vctx(),db);
  assert.equal(c.ok,true);assert.deepEqual(db.updates,[['status',MINE,'cancelled']]);
  assert.equal(db.audits.at(-1)[0],'patient.cancelled');
});

test('P5 rescheduling becomes a request for the team and keeps the doctor when free',async()=>{
  const r=buildFullRegistry(),db=ssDb();
  const env=await executeTool(r,'reschedule_my_appointment',{booking_id:MINE,when:'2026-11-18T09:30'},vctx(),db);
  assert.equal(env.ok,true,JSON.stringify(env));assert.equal(env.data.status,'requested');
  assert.equal(db.updates[0][2].status,'requested');assert.equal(db.updates[0][2].doctor_id,'d1');
  const closed=await executeTool(r,'reschedule_my_appointment',{booking_id:MINE,when:'2026-11-20T10:00'},vctx(),db);
  assert.equal(closed.error.code,'PRECONDITION_FAILED');
});

test('P5 self-service tools are never offered to the model',()=>{
  const names=modelToolsFor(buildFullRegistry(),{role:'public',surface:'public'}).map(t=>t.function.name);
  for(const n of ['my_appointments','cancel_my_appointment','reschedule_my_appointment'])assert.ok(!names.includes(n),n);
});

test('P5 confirmed leave and clinic closures remove open times; tentative ones do not exist here',async()=>{
  const r=buildFullRegistry();
  const leave=ssDb({ex:[{on_date:'2026-11-18',kind:'leave',start_min:null,end_min:null,doctor_id:'d1'}]});
  const a=await executeTool(r,'check_availability',{date:'2026-11-18'},pctx(),leave);
  assert.deepEqual(a.data.slots,[]);
  const part=ssDb({ex:[{on_date:'2026-11-18',kind:'unavailable',start_min:540,end_min:600,doctor_id:'d1'}]});
  const b=await executeTool(r,'check_availability',{date:'2026-11-18'},pctx(),part);
  assert.ok(!b.data.slots.some(s=>s.time<'10:00'));assert.ok(b.data.slots.some(s=>s.time==='10:00'));
  const shut=ssDb({ex:[{on_date:'2026-11-18',kind:'closure',start_min:null,end_min:null,doctor_id:null}]});
  const c=await executeTool(r,'check_availability',{date:'2026-11-18'},pctx(),shut);
  assert.match(c.data.note,/closed/);
  const req=await executeTool(r,'request_appointment',{...REQ,when:'2026-11-18T09:00'},pctx(),leave);
  assert.equal(req.error.code,'RESOURCE_CONFLICT');
});

test('P5 website answers include confirmed clinic information',async()=>{
  const db=ssDb({facts:[{category:'policy',key:'Cancellation policy',value:'Please give 24 hours notice.',entity_name:null}]});
  const env=await executeTool(buildFullRegistry(),'search_answers',{query:'cancellation notice policy'},pctx(),db);
  assert.equal(env.data.matches[0].answer,'Please give 24 hours notice.');assert.equal(env.data.matches[0].source,'clinic information');
});

test('P5 setup: update_doctor changes only given fields; add_service skips duplicates',async()=>{
  const r=buildFullRegistry(),patched=[],added=[];
  const db=fakeDb({legacy:{list:async(o,t)=>t==='doctors'?[{id:'d1',name:'Dr. Rao'}]:[{name:'Cleaning'}],updateDoctor:async(o,id,p)=>patched.push([id,p]),addService:async(o,n)=>added.push(n)}});
  const u=await executeTool(r,'update_doctor',{name:'dr. rao',hours:'9am-1pm'},ctx({surface:'staff'}),db);
  assert.equal(u.ok,true,JSON.stringify(u));assert.deepEqual(patched,[['d1',{start:'09:00',end:'13:00'}]]);
  assert.equal((await executeTool(r,'add_service',{name:'cleaning'},ctx({surface:'staff'}),db)).data.added,false);
  assert.equal((await executeTool(r,'add_service',{name:'Whitening'},ctx({surface:'staff'}),db)).data.added,true);
  assert.deepEqual(added,['Whitening']);
  db.role='staff';
  assert.equal((await executeTool(r,'add_service',{name:'Implants'},ctx({surface:'staff'}),db)).error.code,'PERMISSION_DENIED');
});

test('P5 phones are US-first; Indian clinics keep Indian defaults',()=>{
  assert.equal(normalizePhone('987 654 3210'),'+19876543210');
  assert.equal(normalizePhone('98765 43210','IN'),'+919876543210');
  assert.equal(normalizePhone('+91 98765 43210'),'+919876543210');
  assert.equal(countryForTimeZone('America/Chicago'),'US');assert.equal(countryForTimeZone('Asia/Kolkata'),'IN');
});

test('P5 change and cancel requests open self-service',()=>{
  assert.equal(wantsManage([{role:'user',content:'I need to reschedule my appointment'}]),true);
  assert.equal(wantsManage([{role:'user',content:'can I cancel my booking?'}]),true);
  assert.equal(wantsManage([{role:'user',content:'Do you take Delta Dental?'}]),false);
});

test('P5 insights count chats, hand-offs, requests and time to confirm',()=>{
  const now=Date.parse('2026-11-30T12:00:00Z'),h=36e5;
  const m=computeInsights({
    convos:[{created:now-h,status:'handled',messages:[{r:'bot'},{r:'cust'},{r:'bot'}]},{created:now-2*h,status:'handoff',messages:[]},{created:now-40*24*h,status:'handled',messages:[]}],
    alerts:[{created:now-h,reason:'unsure'},{created:now-h,reason:'unsure'},{created:now-h,reason:'health_risk'}],
    bookings:[{source:'website',status:'booked',created:now-5*h,requested_at:new Date(now-5*h).toISOString(),decided_at:new Date(now-4*h).toISOString()},
      {source:'website',status:'requested',created:now-h,requested_at:new Date(now-h).toISOString()},
      {source:'website',status:'cancelled',created:now-3*h,requested_at:new Date(now-3*h).toISOString(),decided_at:new Date(now-h).toISOString()}],
    audit:[{at:now-h,action:'patient.rescheduled'}]},{days:30,now});
  assert.equal(m.chats,2);assert.equal(m.handedOff,1);assert.equal(m.automationRate,0.5);assert.equal(m.replies,2);
  assert.deepEqual(m.reasons[0],{reason:'unsure',n:2});
  assert.deepEqual([m.requests.total,m.requests.confirmed,m.requests.pending,m.requests.declined],[3,1,1,1]);
  assert.equal(m.requests.medianMinutesToDecide,90);assert.equal(m.selfService.rescheduled,1);
});

// ---------- Production round: model-call resilience, bounded tool reads ----------
import {postChat} from '../../supabase/functions/_shared/agent.js';
function fakeFetch(script){
  const calls=[];
  const f=async(url,init)=>{calls.push(url);const s=script.shift();if(s==='network')throw new TypeError('fetch failed');if(s==='hang')return new Promise((_,rej)=>init.signal.addEventListener('abort',()=>rej(init.signal.reason)));
    return{ok:s.status<300,status:s.status,headers:{get:k=>k==='retry-after'?s.retryAfter??null:null},json:async()=>s.body,text:async()=>JSON.stringify(s.body??{})}};
  f.calls=calls;return f;
}
const OKBODY={choices:[{message:{content:'hi'}}]};
test('R1 model calls retry 429 and 5xx, then succeed',async()=>{
  const real=globalThis.fetch;const f=fakeFetch([{status:429,retryAfter:'0'},{status:503},{status:200,body:OKBODY}]);globalThis.fetch=f;
  try{const seen=[];const j=await postChat({endpoint:'https://a.test/v1',key:'k'},{messages:[]},{onAttempt:a=>seen.push(a.status)});
    assert.equal(j.choices[0].message.content,'hi');assert.deepEqual(seen,[429,503,200]);}finally{globalThis.fetch=real}
});
test('R2 a bad request is not retried',async()=>{
  const real=globalThis.fetch;const f=fakeFetch([{status:400,body:{error:'bad'}},{status:200,body:OKBODY}]);globalThis.fetch=f;
  try{await assert.rejects(postChat({endpoint:'https://a.test/v1'},{messages:[]}),/Model error 400/);assert.equal(f.calls.length,1)}finally{globalThis.fetch=real}
});
test('R3 timeouts and outages move to the fallback provider',async()=>{
  const real=globalThis.fetch;const f=fakeFetch(['hang','network','network',{status:200,body:OKBODY}]);globalThis.fetch=f;
  try{const j=await postChat({endpoint:'https://primary.test/v1',fallback:{endpoint:'https://backup.test/v1',key:'b',model:'m2'}},{messages:[]},{timeoutMs:50});
    assert.equal(j.choices[0].message.content,'hi');assert.match(f.calls.at(-1),/backup\.test/);assert.equal(f.calls.length,4)}finally{globalThis.fetch=real}
});
test('R4 availability reads one day of bookings, never the whole history',async()=>{
  const seen=[];const db=publicDb();const list=db.legacy.list;
  db.legacy.list=async(o,t,opts)=>{if(t==='bookings')seen.push(opts);return list(o,t)};
  await executeTool(buildFullRegistry(),'check_availability',{date:'2026-11-17'},pctx(),db);
  assert.equal(seen.length,1);assert.deepEqual(seen[0],{from:'2026-11-17',to:'2026-11-18'});
});
