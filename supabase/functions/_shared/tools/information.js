/* Information tools. Each tool is defined once here. Tools hold no patient data: bookings are referenced by id only. */
import {ToolError} from './errors.js';
import {matchEntity,resolveDate,resolveTime,cleanText,addDays,todayIn} from './normalise.js';
import {hasRole} from './registry.js';
import {mapDbError} from './dbErrors.js';

const UUID={type:'string',format:'uuid'};
const KEY={type:'string',minLength:8,maxLength:128,description:'A unique key you create for this request. Retrying with the same key never repeats the change.'};
const hm=m=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

/* Reads a doctor's weekly hours and the date-specific items in a window. Shows confirmed and tentative items separately. */
export const getDoctorSchedule={
  name:'get_doctor_schedule',
  version:1,
  minRole:'doctor',
  patientData:'none',
  writes:false,
  description:'Look up a doctor\'s regular weekly hours and any leave, unavailability or closures for a date window. Tentative items are marked as tentative, never as confirmed.',
  input:{type:'object',additionalProperties:false,required:['doctor'],properties:{
    doctor:{type:'string',minLength:1,maxLength:120,description:'The doctor\'s name as the team says it, e.g. "Dr. Sharma".'},
    from_date:{type:'string',format:'date','x-normalise':true,description:'Start of the window: YYYY-MM-DD, MM/DD/YYYY, today, tomorrow, or a weekday name. Defaults to today.'},
    days:{type:'integer',minimum:1,maximum:31,description:'How many days to cover from the start date. Defaults to 7.'}}},
  canonical:{type:'object',additionalProperties:false,required:['doctor_id','doctor_name','from_date','days'],properties:{
    doctor_id:UUID,doctor_name:{type:'string',minLength:1},from_date:{type:'string',format:'date'},days:{type:'integer',minimum:1,maximum:31}}},
  output:{type:'object',additionalProperties:false,required:['doctor','window','weekly','exceptions'],properties:{
    doctor:{type:'object',additionalProperties:false,required:['id','name'],properties:{id:{type:'string'},name:{type:'string'}}},
    window:{type:'object',additionalProperties:false,required:['from','to'],properties:{from:{type:'string'},to:{type:'string'}}},
    weekly:{type:'array',items:{type:'object',additionalProperties:false,required:['weekday','start','end','slot_minutes'],properties:{
      weekday:{type:'integer',minimum:0,maximum:6},start:{type:'string'},end:{type:'string'},slot_minutes:{type:'integer'}}}},
    exceptions:{type:'array',items:{type:'object',additionalProperties:false,required:['on_date','kind','status'],properties:{
      on_date:{type:'string'},kind:{type:'string'},status:{type:'string',enum:['confirmed','tentative']},note:{type:'string'}}}}}},
  errors:['INVALID_ARGUMENT','MISSING_INFORMATION','ENTITY_NOT_FOUND','AMBIGUOUS_ENTITY','PERMISSION_DENIED','UNAVAILABLE'],
  idempotent:'not_applicable',
  normalise:async(raw,c,db)=>{
    const doctors=await db.listEntities(c.orgId,'doctor');
    const {entity}=matchEntity(raw.doctor,doctors,{label:'doctor'});
    const from=raw.from_date?resolveDate(raw.from_date,c.today).date:c.today;
    return{doctor_id:entity.id,doctor_name:entity.name,from_date:from,days:raw.days??7};
  },
  run:async(a,c,db)=>{
    const to=addDays(a.from_date,a.days-1);
    const [rules,exc]=await Promise.all([db.rulesFor(c.orgId,a.doctor_id),db.exceptionsFor(c.orgId,a.doctor_id,a.from_date,to)]);
    return{
      doctor:{id:a.doctor_id,name:a.doctor_name},
      window:{from:a.from_date,to},
      weekly:rules.map(r=>({weekday:r.weekday,start:hm(r.start_min),end:hm(r.end_min),slot_minutes:r.slot_minutes})),
      exceptions:exc.map(e=>({on_date:e.on_date,kind:e.kind,status:e.status,note:e.note??''})),
    };
  },
};

/* Records leave or unavailability for one doctor. Any member may add a tentative record. Only an owner or admin may confirm. */
export const recordScheduleException={
  name:'record_schedule_exception',
  version:1,
  minRole:'staff',
  patientData:'none',
  writes:true,
  idempotent:'required',
  approval:'role_confirms',
  description:'Record that a doctor is on leave or unavailable on a date. Use status "tentative" when it is not yet confirmed. Only owners and admins can record it as confirmed.',
  input:{type:'object',additionalProperties:false,required:['doctor','kind','on_date','status','idempotency_key'],properties:{
    doctor:{type:'string',minLength:1,maxLength:120,description:'The doctor\'s name, e.g. "Dr. Sharma".'},
    kind:{type:'string',enum:['leave','unavailable'],description:'"leave" for planned time off, "unavailable" for a shorter or uncertain absence.'},
    on_date:{type:'string',format:'date','x-normalise':true,description:'The date: YYYY-MM-DD, MM/DD/YYYY, today, tomorrow, or a weekday name such as "next Tuesday".'},
    status:{type:'string',enum:['tentative','confirmed'],description:'"tentative" if not yet confirmed; "confirmed" only when the owner or admin has confirmed it.'},
    note:{type:'string',maxLength:300,description:'Short note, e.g. "Might be off, not confirmed yet". No patient information.'},
    idempotency_key:KEY}},
  inputFor:role=>{
    const statuses=hasRole(role,'admin')?['tentative','confirmed']:['tentative'];
    const s=JSON.parse(JSON.stringify(recordScheduleException.input));
    s.properties.status.enum=statuses;
    return s;
  },
  canonical:{type:'object',additionalProperties:false,required:['doctor_id','doctor_name','kind','on_date','status','note','idempotency_key'],properties:{
    doctor_id:UUID,doctor_name:{type:'string',minLength:1},kind:{type:'string',enum:['leave','unavailable']},
    on_date:{type:'string',format:'date'},status:{type:'string',enum:['tentative','confirmed']},
    note:{type:'string',maxLength:300},idempotency_key:KEY}},
  output:{type:'object',additionalProperties:false,required:['exception_id','doctor','on_date','kind','status'],properties:{
    exception_id:UUID,doctor:{type:'object',additionalProperties:false,required:['id','name'],properties:{id:{type:'string'},name:{type:'string'}}},
    on_date:{type:'string'},kind:{type:'string'},status:{type:'string',enum:['tentative','confirmed']}}},
  errors:['INVALID_ARGUMENT','MISSING_INFORMATION','ENTITY_NOT_FOUND','AMBIGUOUS_ENTITY','PERMISSION_DENIED','PRECONDITION_FAILED','RESOURCE_CONFLICT','UNAVAILABLE'],
  normalise:async(raw,c,db)=>{
    const doctors=await db.listEntities(c.orgId,'doctor');
    const {entity}=matchEntity(raw.doctor,doctors,{label:'doctor'});
    const {date}=resolveDate(raw.on_date,c.today);
    return{doctor_id:entity.id,doctor_name:entity.name,kind:raw.kind,on_date:date,status:raw.status,
      note:cleanText(raw.note??'',{max:300}),idempotency_key:cleanText(raw.idempotency_key,{max:128})};
  },
  authorize:(a,c)=>{
    if(a.status==='confirmed'&&!hasRole(c.role,'admin'))
      throw new ToolError('PERMISSION_DENIED','Only an owner or admin can confirm this. It can be recorded as tentative.',{field:'status',nextStep:'Record it as tentative, or ask an owner or admin to confirm it.',retryable:false});
  },
  preconditions:(a,c)=>{
    if(a.on_date<c.today)throw new ToolError('PRECONDITION_FAILED','That date has already passed.',{field:'on_date',retryable:false,nextStep:'Choose today or a later date.'});
  },
  run:async(a,c,db)=>{
    const id=await db.createException({orgId:c.orgId,entityId:a.doctor_id,onDate:a.on_date,kind:a.kind,status:a.status,note:a.note,ref:'tool:'+a.idempotency_key});
    return{exception_id:id,doctor:{id:a.doctor_id,name:a.doctor_name},on_date:a.on_date,kind:a.kind,status:a.status};
  },
  recover:async(a,c,db)=>{
    const row=await db.findExceptionByRef(c.orgId,'tool:'+a.idempotency_key);
    if(!row)return null;
    return{exception_id:row.id,doctor:{id:a.doctor_id,name:a.doctor_name},on_date:row.on_date,kind:row.kind,status:row.status};
  },
};

/* Corrects an information item. The old record is superseded and kept; the correction is a new record. */
export const updateBusinessFact={
  name:'update_business_fact',
  version:1,
  minRole:'staff',
  patientData:'none',
  writes:true,
  idempotent:'required',
  approval:'role_confirms',
  description:'Correct an existing business information item (hours, policy, FAQ). The old wording is kept as history. Only owners and admins can confirm a correction.',
  input:{type:'object',additionalProperties:false,required:['fact_id','value','status','idempotency_key'],properties:{
    fact_id:{type:'string',format:'uuid',description:'The id of the item being corrected.'},
    value:{type:'string',minLength:1,maxLength:5000,description:'The corrected wording.'},
    status:{type:'string',enum:['tentative','confirmed'],description:'"tentative" or "confirmed" (owners and admins only).'},
    idempotency_key:KEY}},
  inputFor:role=>{
    const s=JSON.parse(JSON.stringify(updateBusinessFact.input));
    s.properties.status.enum=hasRole(role,'admin')?['tentative','confirmed']:['tentative'];
    return s;
  },
  canonical:{type:'object',additionalProperties:false,required:['fact_id','value','status','idempotency_key'],properties:{
    fact_id:{type:'string',format:'uuid'},value:{type:'string',minLength:1,maxLength:5000},
    status:{type:'string',enum:['tentative','confirmed']},idempotency_key:KEY}},
  output:{type:'object',additionalProperties:false,required:['fact_id','replaces','status'],properties:{
    fact_id:UUID,replaces:UUID,status:{type:'string',enum:['tentative','confirmed']}}},
  errors:['INVALID_ARGUMENT','MISSING_INFORMATION','ENTITY_NOT_FOUND','PERMISSION_DENIED','PRECONDITION_FAILED','RESOURCE_CONFLICT','UNAVAILABLE'],
  normalise:async(raw,c)=>({fact_id:cleanText(raw.fact_id,{max:36}).toLowerCase(),value:cleanText(raw.value,{max:5000}),
    status:raw.status,idempotency_key:cleanText(raw.idempotency_key,{max:128})}),
  authorize:(a,c)=>{
    if(a.status==='confirmed'&&!hasRole(c.role,'admin'))
      throw new ToolError('PERMISSION_DENIED','Only an owner or admin can confirm a correction. It can be saved as tentative.',{field:'status',retryable:false,nextStep:'Save it as tentative, or ask an owner or admin to confirm it.'});
  },
  preconditions:async(a,c,db)=>{
    const f=await db.factById(c.orgId,a.fact_id);
    if(!f)throw new ToolError('ENTITY_NOT_FOUND','That information item was not found.',{field:'fact_id',retryable:false,nextStep:'Look it up again and pick the current item.'});
    if(f.value.trim()===a.value.trim()&&f.status===a.status)throw new ToolError('PRECONDITION_FAILED','Nothing has changed, so there is nothing to correct.',{field:'value',retryable:false});
  },
  run:async(a,c,db)=>{
    const id=await db.supersedeFact({orgId:c.orgId,factId:a.fact_id,value:a.value,status:a.status,ref:'tool:'+a.idempotency_key});
    return{fact_id:id,replaces:a.fact_id,status:a.status};
  },
  recover:async(a,c,db)=>{
    const row=await db.findFactByRef(c.orgId,'tool:'+a.idempotency_key);
    if(!row)return null;
    return{fact_id:row.id,replaces:row.supersedes_id,status:row.status};
  },
};

export const informationTools=[getDoctorSchedule,recordScheduleException,updateBusinessFact];
export {mapDbError,todayIn};
