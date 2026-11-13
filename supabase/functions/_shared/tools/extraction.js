/* Conversational extraction. The model reads the staff member's words and fills in structured items; this code does everything
   that must not depend on the model: resolving names, reading dates in the clinic's time zone, expanding days and ranges,
   refusing patient information, downgrading hedged "confirmed" claims, checking the quoted source, and persisting each item
   through one database function that detects duplicates and contradictions and supersedes without deleting history. */
import {ToolError} from './errors.js';
import {matchEntity,resolveDate,parseWeekdays,parseTimeRange,toMinutes,cleanText,addDays,isHedged,quoteIsFrom,containsPatientInfo,todayIn} from './normalise.js';
import {hasRole} from './registry.js';
import {mapDbError} from './dbErrors.js';

const KEY={type:'string',minLength:8,maxLength:128,description:'A unique key you create for this request. Retrying with the same key never repeats the change.'};
const STATUS={type:'string',enum:['tentative','confirmed'],description:'"tentative" when the speaker is unsure (might, maybe, probably, not decided). "confirmed" only when stated as certain by an owner or admin.'};
const CATEGORIES=['profile','hours','service','procedure','policy','faq','staff','event','other'];
const MAX_ITEMS=20, MAX_RANGE_DAYS=31;

const ITEM_IN={type:'object',additionalProperties:false,required:['type','source_quote','status'],properties:{
  type:{type:'string',enum:['weekly_hours','leave','withdraw_leave','fact'],description:'weekly_hours = recurring weekly schedule. leave = leave or unavailability on one date or a range. withdraw_leave = the leave no longer applies. fact = a policy, price, hours of the clinic, FAQ or other business information.'},
  source_quote:{type:'string',minLength:1,maxLength:300,description:'The exact words from the staff member\'s message this item comes from. Copy them; do not rewrite.'},
  status:STATUS,
  intent:{type:'string',enum:['add','correct'],description:'"correct" only when the staff member is changing something already recorded ("actually", "changed to", "not anymore"). Otherwise "add".'},
  entity:{type:'string',maxLength:120,description:'The doctor, staff member, service or location this is about, as the speaker said it. Omit for clinic-wide facts.'},
  entity_kind:{type:'string',enum:['doctor','staff','service','location'],description:'Defaults to doctor.'},
  weekdays:{type:'string',maxLength:80,description:'For weekly_hours: e.g. "Mon, Wed, Fri" or "Mon-Fri".'},
  hours:{type:'string',maxLength:40,description:'For weekly_hours: e.g. "9am-5pm". Ask if the speaker did not say am or pm.'},
  slot_minutes:{type:'integer',minimum:5,maximum:240,description:'Appointment length for weekly_hours. Defaults to 30.'},
  kind:{type:'string',enum:['leave','unavailable'],description:'For leave: "leave" for planned time off, "unavailable" for a shorter or uncertain absence.'},
  date:{type:'string',maxLength:40,'x-normalise':true,description:'For leave and withdraw_leave: the date as the speaker said it, e.g. "next Tuesday", "Dec 5", "2026-12-05".'},
  to_date:{type:'string',maxLength:40,'x-normalise':true,description:'For leave: the last day of a range. Omit for one day.'},
  note:{type:'string',maxLength:300,description:'Short note about leave. No patient information.'},
  category:{type:'string',enum:CATEGORIES,description:'For fact.'},
  key:{type:'string',maxLength:200,description:'For fact: a short stable name, e.g. "parking", "cancellation policy".'},
  value:{type:'string',maxLength:2000,description:'For fact: the information itself, in plain words.'}}};

const CANON_ITEM={type:'object',additionalProperties:false,required:['index','type','intent','status','source_quote'],properties:{
  index:{type:'integer',minimum:0},type:{type:'string',enum:['weekly_hours','exception','withdraw_exception','fact']},
  intent:{type:'string',enum:['add','correct']},status:{type:'string',enum:['tentative','confirmed']},source_quote:{type:'string',maxLength:500},
  entity_id:{type:'string',format:'uuid'},entity_name:{type:'string'},weekday:{type:'integer',minimum:0,maximum:6},
  start_min:{type:'integer',minimum:0,maximum:1439},end_min:{type:'integer',minimum:1,maximum:1440},slot_minutes:{type:'integer',minimum:5,maximum:240},
  on_date:{type:'string',format:'date'},kind:{type:'string',enum:['leave','unavailable']},note:{type:'string',maxLength:500},
  category:{type:'string',enum:CATEGORIES},key:{type:'string',maxLength:200},value:{type:'string',maxLength:5000},
  downgraded:{type:'boolean'},
  problem:{type:'object',additionalProperties:false,required:['code','message'],properties:{
    code:{type:'string'},message:{type:'string'},field:{type:'string'},alternatives:{type:'array'},next_step:{type:'string'}}}}};

const OUTCOME={type:'object',additionalProperties:false,required:['index','type','result'],properties:{
  index:{type:'integer'},type:{type:'string'},entity:{type:'string'},result:{type:'string',enum:['created','superseded','withdrawn','duplicate','conflict','rejected','needs_clarification']},
  status:{type:'string'},id:{type:'string'},previous:{type:'array'},existing:{type:'array'},reason:{type:'string'},message:{type:'string'},
  question:{type:'string'},alternatives:{type:'array'},on_date:{type:'string'},weekday:{type:'integer'},downgraded_to_tentative:{type:'boolean'}}};

const dayName=n=>['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][n];
const hm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

/* A problem found while reading one item. The other items in the call are still processed. */
const problemOf=e=>e instanceof ToolError
  ?{code:e.code,message:e.message,...(e.field?{field:String(e.field)}:{}),...(e.alternatives?{alternatives:e.alternatives}:{}),...(e.nextStep?{next_step:e.nextStep}:{})}
  :{code:'INVALID_ARGUMENT',message:'That item could not be read.'};

export const recordBusinessInformation={
  name:'record_business_information',
  version:1,
  minRole:'staff',
  writes:true,
  idempotent:'required',
  patientData:'none',
  scansItems:true,
  approval:'role_confirms',
  timeoutMs:20000,
  description:'Save structured business information a staff member stated: recurring doctor schedules, leave or unavailability, and clinic facts or policies. Send one item per fact, with the exact words they used. Mark anything uncertain as tentative. The result lists, per item, what was created, superseded, rejected, duplicated, in conflict, or needs a clarifying question. Never store patient information.',
  input:{type:'object',additionalProperties:false,required:['items','idempotency_key'],properties:{
    items:{type:'array',minItems:1,maxItems:MAX_ITEMS,items:ITEM_IN},idempotency_key:KEY}},
  inputFor:role=>{
    const s=JSON.parse(JSON.stringify(recordBusinessInformation.input));
    if(!hasRole(role,'admin'))s.properties.items.items.properties.status.enum=['tentative'];
    return s;
  },
  canonical:{type:'object',additionalProperties:false,required:['items','idempotency_key'],properties:{
    items:{type:'array',minItems:1,maxItems:60,items:CANON_ITEM},idempotency_key:KEY}},
  output:{type:'object',additionalProperties:false,required:['outcomes','summary','counts','clarification_needed'],properties:{
    outcomes:{type:'array',items:OUTCOME},summary:{type:'array',items:{type:'string'}},
    counts:{type:'object'},clarification_needed:{type:'boolean'}}},
  errors:['INVALID_ARGUMENT','MISSING_INFORMATION','PERMISSION_DENIED','UNAVAILABLE','EXECUTION_FAILED'],

  normalise:async(raw,c,db)=>{
    const lists={};
    const entitiesOf=async kind=>lists[kind]??=await db.listEntities(c.orgId,kind);
    const isAdmin=hasRole(c.role,'admin');
    const out=[];
    let n=0;
    const push=o=>out.push({index:n++,...o});
    for(const it of raw.items){
      const base={type:it.type==='leave'?'exception':it.type==='withdraw_leave'?'withdraw_exception':it.type,intent:it.intent??'add',
        status:it.status,source_quote:cleanText(it.source_quote,{max:300})};
      try{
        // Words the person did not write are not a source. Checked against the real message when the caller supplies it.
        if(c.userMessage&&!quoteIsFrom(it.source_quote,c.userMessage))
          throw new ToolError('INVALID_ARGUMENT','source_quote must be copied exactly from the staff member\'s message.',{field:'source_quote',nextStep:'Copy the exact words they used.'});
        if(it.status==='confirmed'&&!isAdmin)
          throw new ToolError('PERMISSION_DENIED','Only an owner or admin can record this as confirmed. It can be recorded as tentative.',{field:'status',nextStep:'Record it as tentative, or ask an owner or admin to confirm it.'});
        // A hedged sentence never becomes a confirmed fact, whatever the model says.
        let downgraded=false;
        if(base.status==='confirmed'&&isHedged(`${it.source_quote} ${it.note??''}`)){base.status='tentative';downgraded=true}
        if(downgraded)base.downgraded=true;
        for(const f of [it.source_quote,it.note,it.key,it.value,it.entity])
          if(f&&containsPatientInfo(f))throw new ToolError('PRECONDITION_FAILED','Patient information cannot be stored in business memory. Leave out names, phone numbers, emails and medical details.',{field:'item',retryable:false});

        let entity=null;
        if(it.entity){
          entity=matchEntity(it.entity,await entitiesOf(it.entity_kind??'doctor'),{label:it.entity_kind??'doctor'}).entity;
        }else if(it.type!=='fact'){
          throw new ToolError('MISSING_INFORMATION',`Which doctor or staff member is this about?`,{field:'entity',nextStep:'Ask who it is about.'});
        }
        const ent=entity?{entity_id:entity.id,entity_name:entity.name}:{};

        if(it.type==='weekly_hours'){
          if(!it.weekdays)throw new ToolError('MISSING_INFORMATION','Which days of the week?',{field:'weekdays',nextStep:'Ask which days.'});
          if(!it.hours)throw new ToolError('MISSING_INFORMATION','What hours?',{field:'hours',nextStep:'Ask the start and end time.'});
          const days=parseWeekdays(it.weekdays), {start,end}=parseTimeRange(it.hours);
          for(const d of days)push({...base,...ent,weekday:d,start_min:toMinutes(start),end_min:toMinutes(end),slot_minutes:it.slot_minutes??30});
        }else if(it.type==='leave'||it.type==='withdraw_leave'){
          if(!it.date)throw new ToolError('MISSING_INFORMATION','Which date?',{field:'date',nextStep:'Ask which date.'});
          const from=resolveDate(it.date,c.today).date, to=it.to_date?resolveDate(it.to_date,c.today).date:from;
          if(to<from)throw new ToolError('INVALID_ARGUMENT','The end date is before the start date.',{field:'to_date'});
          const span=(Date.parse(to)-Date.parse(from))/864e5+1;
          if(span>MAX_RANGE_DAYS)throw new ToolError('INVALID_ARGUMENT',`A range can cover at most ${MAX_RANGE_DAYS} days.`,{field:'to_date',nextStep:'Split it into shorter ranges.'});
          if(it.type==='leave'&&from<c.today)throw new ToolError('PRECONDITION_FAILED','That date has already passed.',{field:'date',nextStep:'Choose today or a later date.'});
          for(let i=0;i<span;i++)push({...base,...ent,on_date:addDays(from,i),kind:it.kind??'leave',note:cleanText(it.note??'',{max:300})});
        }else{
          if(!it.category||!it.key||!it.value)throw new ToolError('MISSING_INFORMATION','A fact needs a category, a short name and its wording.',{field:'value',nextStep:'Ask what exactly should be saved.'});
          push({...base,...ent,category:it.category,key:cleanText(it.key,{max:200}).toLowerCase(),value:cleanText(it.value,{max:2000})});
        }
      }catch(e){
        // A problem with one item never blocks the others. It comes back as a result the model can act on.
        push({...base,entity_name:it.entity?cleanText(it.entity,{max:120}):undefined,problem:problemOf(e)});
      }
    }
    if(out.length>60)throw new ToolError('INVALID_ARGUMENT','That expands to too many records. Send fewer items.',{field:'items'});
    return {items:JSON.parse(JSON.stringify(out)),idempotency_key:cleanText(raw.idempotency_key,{max:128})};
  },

  run:async(a,c,db)=>{
    const outcomes=[];
    for(const it of a.items){
      const ref=`tool:${a.idempotency_key}#${it.index}`;
      const label={index:it.index,type:it.type,...(it.entity_name?{entity:it.entity_name}:{}),status:it.status,...(it.on_date?{on_date:it.on_date}:{}),...(it.weekday!==undefined?{weekday:it.weekday}:{}),...(it.downgraded?{downgraded_to_tentative:true}:{})};
      if(it.problem){
        const ask=['AMBIGUOUS_ENTITY','MISSING_INFORMATION'].includes(it.problem.code)||(it.problem.code==='INVALID_ARGUMENT'&&/morning or evening|could not read the (time|hours|days)/.test(it.problem.message));
        outcomes.push({...label,result:ask?'needs_clarification':'rejected',reason:it.problem.code,message:it.problem.message,
          ...(ask?{question:it.problem.next_step??it.problem.message}:{}),...(it.problem.alternatives?{alternatives:it.problem.alternatives}:{})});
        continue;
      }
      const {index:_i,entity_name:_n,downgraded:_d,problem:_p,...dbItem}=it;
      let r;
      try{r=await db.applyItem(c.orgId,dbItem,ref)}
      catch(e){
        const te=mapDbError(e);
        if(te.retryable)throw te;   // the key makes the retry safe: items already applied report as replayed
        outcomes.push({...label,result:'rejected',reason:te.code,message:te.message});
        continue;
      }
      outcomes.push({...label,result:r.result,...(r.id?{id:r.id}:{}),...(r.previous?{previous:r.previous}:{}),...(r.existing?{existing:r.existing}:{}),
        ...(r.reason?{reason:r.reason}:{}),...(r.message?{message:r.message}:{})});
    }
    const counts={};
    for(const o of outcomes)counts[o.result]=(counts[o.result]??0)+1;
    const summary=outcomes.map(o=>{
      const who=o.entity?`${o.entity}: `:'';
      const what=o.type==='weekly_hours'?`${dayName(o.weekday)} hours`:o.on_date?`${o.type==='withdraw_exception'?'leave withdrawn for':'leave on'} ${o.on_date}`:o.type==='fact'?'information':o.type;
      const tent=o.status==='tentative'&&['created','superseded'].includes(o.result)?' (TENTATIVE, not confirmed)':'';
      return `${who}${what} - ${o.result.replace('_',' ')}${tent}${o.message&&o.result!=='created'?`: ${o.message}`:''}`;
    });
    return{outcomes,summary,counts,clarification_needed:outcomes.some(o=>o.result==='needs_clarification')};
  },
};

/* Looks things up so the model can check before it writes, and answer questions from recorded information. */
export const findBusinessInformation={
  name:'find_business_information',
  version:1,
  minRole:'doctor',
  writes:false,
  patientData:'none',
  idempotent:'not_applicable',
  description:'Search recorded business information (policies, prices, hours, FAQs, notes) by a few words, optionally for one doctor or service. Tentative items are marked tentative. Use it before recording, to avoid duplicates and to spot contradictions.',
  input:{type:'object',additionalProperties:false,required:['query'],properties:{
    query:{type:'string',minLength:1,maxLength:200,description:'A few words, e.g. "parking" or "cancellation".'},
    entity:{type:'string',maxLength:120,description:'Optional doctor, staff member or service name.'},
    entity_kind:{type:'string',enum:['doctor','staff','service','location']}}},
  canonical:{type:'object',additionalProperties:false,required:['query'],properties:{
    query:{type:'string',minLength:1,maxLength:200},entity_id:{type:'string',format:'uuid'},entity_name:{type:'string'}}},
  output:{type:'object',additionalProperties:false,required:['matches'],properties:{matches:{type:'array',items:{type:'object',additionalProperties:false,
    required:['id','category','key','value','status'],properties:{id:{type:'string'},category:{type:'string'},key:{type:'string'},value:{type:'string'},status:{type:'string'},entity:{type:'string'}}}}}},
  errors:['INVALID_ARGUMENT','ENTITY_NOT_FOUND','AMBIGUOUS_ENTITY','PERMISSION_DENIED','UNAVAILABLE'],
  normalise:async(raw,c,db)=>{
    const out={query:cleanText(raw.query,{max:200})};
    if(raw.entity){const e=matchEntity(raw.entity,await db.listEntities(c.orgId,raw.entity_kind??'doctor'),{label:raw.entity_kind??'doctor'}).entity;out.entity_id=e.id;out.entity_name=e.name}
    return out;
  },
  run:async(a,c,db)=>{
    const words=a.query.toLowerCase().split(/\W+/).filter(w=>w.length>2);
    const facts=await db.listFacts(c.orgId,{entityId:a.entity_id});
    const score=f=>words.filter(w=>`${f.key} ${f.value} ${f.category}`.toLowerCase().includes(w)).length;
    return{matches:facts.map(f=>({f,s:score(f)})).filter(x=>x.s>0).sort((x,y)=>y.s-x.s).slice(0,8)
      .map(({f})=>({id:f.id,category:f.category,key:f.key,value:f.value.slice(0,500),status:f.status,...(f.entity_name?{entity:f.entity_name}:{})}))};
  },
};

export const extractionTools=[recordBusinessInformation,findBusinessInformation];
export {todayIn};
