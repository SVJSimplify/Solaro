/* Production database adapter, built on a Supabase client that carries the signed-in user's session.
   Row-level security and the database functions therefore enforce permissions for every call: the application checks are a first
   layer, never the only one. Works in the Edge Function (Deno) and in the browser. */
import {ToolError} from './errors.js';
import {mapDbError} from './dbErrors.js';

const ms=t=>t?new Date(t).getTime():0;
const hm=t=>String(t||'').slice(0,5);

/* Reads that fail are reported as temporarily unavailable. Writes keep the precise mapping. */
function must(r,{read=false}={}){
  if(!r.error)return r.data;
  const e=mapDbError(r.error);
  if(read&&e.code==='EXECUTION_FAILED')throw new ToolError('UNAVAILABLE','The database could not be read. Try again shortly.',{retryable:true});
  throw e;
}

/* Rows as the front desk and booking engine use them. */
const FROM={
  doctors:r=>({id:r.id,name:r.name,specialty:r.specialty,services:r.services??[],days:r.days??[],start:hm(r.start_time),end:hm(r.end_time),slot:r.slot}),
  bookings:r=>({id:r.id,name:r.name,phone:r.phone,service:r.service,when:String(r.starts_at).slice(0,16),doctor_id:r.doctor_id,doctor:r.doctor,status:r.status}),
  services:r=>({id:r.id,name:r.name}),
  kb:r=>({id:r.id,title:r.title,body:r.body,keywords:r.keywords}),
  closures:r=>({id:r.id,date:r.date}),
};

export function supabaseAdapter(sb){
  const LEGACY_TABLE={doctors:'doctors',bookings:'bookings',services:'services',kb:'kb',closures:'closures'};
  return{
    async membershipRole(orgId,userId){
      return must(await sb.from('members').select('role').eq('org_id',orgId).eq('user_id',userId).maybeSingle(),{read:true})?.role??null;
    },
    async orgTimezone(orgId){
      return must(await sb.from('organizations').select('timezone').eq('id',orgId).maybeSingle(),{read:true})?.timezone??null;
    },
    async listEntities(orgId,kind){
      return must(await sb.from('business_entities').select('id,name').eq('org_id',orgId).eq('kind',kind).eq('status','active').order('name'),{read:true});
    },
    async rulesFor(orgId,entityId){
      return must(await sb.from('schedule_rules').select('weekday,start_min,end_min,slot_minutes,status').eq('org_id',orgId).eq('entity_id',entityId)
        .in('status',['confirmed','tentative']).order('weekday').order('start_min'),{read:true});
    },
    async exceptionsFor(orgId,entityId,from,to){
      return must(await sb.from('schedule_exceptions').select('on_date,kind,status,note').eq('org_id',orgId).or(`entity_id.eq.${entityId},entity_id.is.null`)
        .gte('on_date',from).lte('on_date',to).in('status',['confirmed','tentative']).order('on_date'),{read:true});
    },
    async factById(orgId,id){
      return must(await sb.from('business_facts').select('id,value,status').eq('org_id',orgId).eq('id',id).maybeSingle(),{read:true});
    },
    async listFacts(orgId,{entityId}={}){
      let q=sb.from('business_facts').select('id,category,key,value,status,entity_id,business_entities(name)').eq('org_id',orgId).in('status',['confirmed','tentative','pending_approval']).limit(300);
      if(entityId)q=q.eq('entity_id',entityId);
      return must(await q,{read:true}).map(f=>({id:f.id,category:f.category,key:f.key,value:f.value,status:f.status,entity_name:f.business_entities?.name}));
    },
    async createException({entityId,onDate,kind,status,note,ref}){
      return must(await sb.rpc('create_schedule_exception',{p_entity:entityId,p_on_date:onDate,p_kind:kind,p_status:status,p_note:note,p_source_ref:ref}));
    },
    async findExceptionByRef(orgId,ref){
      return must(await sb.from('schedule_exceptions').select('id,on_date,kind,status').eq('org_id',orgId).eq('source_reference',ref).maybeSingle(),{read:true});
    },
    async supersedeFact({factId,value,status,ref}){
      return must(await sb.rpc('supersede_fact',{p_old:factId,p_value:value,p_status:status,p_source:'manual',p_source_ref:ref}));
    },
    async findFactByRef(orgId,ref){
      return must(await sb.from('business_facts').select('id,supersedes_id,status').eq('org_id',orgId).eq('source_reference',ref).order('created_at',{ascending:false}).limit(1).maybeSingle(),{read:true});
    },
    /* One call applies one extracted item atomically and returns what happened. */
    async applyItem(orgId,item,ref){
      return must(await sb.rpc('apply_information_item',{p_org:orgId,p_item:item,p_ref:ref}));
    },
    /* Clinic information staff have confirmed and that is in effect now. Tentative, pending and superseded items never show. */
    async confirmedFacts(orgId){
      const now=new Date().toISOString();
      return must(await sb.from('business_facts').select('category,key,value,effective_until,business_entities(name)').eq('org_id',orgId).eq('status','confirmed')
        .lte('effective_from',now).limit(500),{read:true}).filter(f=>!f.effective_until||f.effective_until>now)
        .map(f=>({category:f.category,key:f.key,value:f.value,entity_name:f.business_entities?.name??null}));
    },
    /* Confirmed leave, unavailability and closures from a date on, mapped to the booking engine's doctor ids. */
    async confirmedExceptions(orgId,from){
      return must(await sb.from('schedule_exceptions').select('on_date,kind,start_min,end_min,business_entities(legacy_doctor_id)').eq('org_id',orgId)
        .eq('status','confirmed').gte('on_date',from).in('kind',['leave','unavailable','closure']).limit(2000),{read:true})
        .map(e=>({on_date:String(e.on_date).slice(0,10),kind:e.kind,start_min:e.start_min,end_min:e.end_min,doctor_id:e.business_entities?.legacy_doctor_id??null}))
        .filter(e=>e.kind==='closure'||e.doctor_id);   // leave for someone who is not a bookable doctor does not change bookings
    },
    async bookingPolicy(orgId){
      const r=must(await sb.from('settings').select('auto_confirm_web').eq('org_id',orgId).maybeSingle(),{read:true});
      return{autoConfirm:!!r?.auto_confirm_web};
    },
    async logAudit(orgId,action,text){
      must(await sb.rpc('log_audit',{p_org:orgId,p_action:action,p_text:text??''}));
    },

    async claimExecution({orgId,tool,version,key,hash,actorId}){
      const ins=await sb.from('tool_executions').insert({org_id:orgId,tool_name:tool,tool_version:version,idempotency_key:key,input_hash:hash,actor:actorId??null,principal:actorId?'user':'public',status:'started'}).select('id');
      if(!ins.error)return{claimed:true};
      if(ins.error.code!=='23505')throw mapDbError(ins.error);
      const row=must(await sb.from('tool_executions').select('status,input_hash,result,updated_at').eq('org_id',orgId).eq('tool_name',tool).eq('idempotency_key',key).single(),{read:true});
      return{claimed:false,row:{...row,updated_at:new Date(row.updated_at).toISOString()}};
    },
    async takeOverExecution({orgId,tool,key,hash,staleBefore}){
      const r=must(await sb.from('tool_executions').select('attempts').eq('org_id',orgId).eq('tool_name',tool).eq('idempotency_key',key).eq('input_hash',hash).single(),{read:true});
      const up=must(await sb.from('tool_executions').update({status:'started',attempts:r.attempts+1,updated_at:new Date().toISOString()})
        .eq('org_id',orgId).eq('tool_name',tool).eq('idempotency_key',key).eq('input_hash',hash)
        .or(`status.in.(failed,interrupted),and(status.eq.started,updated_at.lt.${staleBefore})`).select('id'));
      return up.length>0;
    },
    async finishExecution({orgId,tool,key,status,result,errorCode}){
      must(await sb.from('tool_executions').update({status,result:result??null,error_code:errorCode??null,updated_at:new Date().toISOString()})
        .eq('org_id',orgId).eq('tool_name',tool).eq('idempotency_key',key));
    },

    /* The clinic's live configuration and bookings, which the booking engine reads. */
    legacy:{
      async list(orgId,table){
        const order=table==='doctors'||table==='services'||table==='kb'||table==='closures'?'created_at':'starts_at';
        return must(await sb.from(LEGACY_TABLE[table]).select('*').eq('org_id',orgId).order(order),{read:true}).map(FROM[table]);
      },
      async addBooking(orgId,b){
        const r=must(await sb.from('bookings').insert({org_id:orgId,name:b.name,phone:b.phone,service:b.service||'',starts_at:b.when,doctor_id:b.doctor_id||null,doctor:b.doctor||'',status:b.status||'booked',source:b.source||'staff',conversation_id:b.conversation_id||null}).select().single());
        return FROM.bookings(r);
      },
      async setBookingStatus(orgId,id,status){must(await sb.from('bookings').update({status}).eq('org_id',orgId).eq('id',id))},
      async updateBooking(orgId,id,b){must(await sb.from('bookings').update({starts_at:b.when,doctor_id:b.doctor_id,doctor:b.doctor,status:b.status,reminded:false}).eq('org_id',orgId).eq('id',id))},
      async updateDoctor(orgId,id,p){
        const row={};if(p.specialty!==undefined)row.specialty=p.specialty;if(p.days)row.days=p.days;if(p.start)row.start_time=p.start;if(p.end)row.end_time=p.end;if(p.services)row.services=p.services;
        must(await sb.from('doctors').update(row).eq('org_id',orgId).eq('id',id));
      },
      async addService(orgId,name){must(await sb.from('services').insert({org_id:orgId,name}))},
      async addDoctor(orgId,d){must(await sb.from('doctors').insert({org_id:orgId,name:d.name,specialty:d.specialty||'',services:d.services,days:d.days,start_time:d.start,end_time:d.end,slot:d.slot||30}))},
      /* Doctors are never deleted here: this only issues a confirmation that a person must redeem in the app. */
      async requestDoctorDeletion(orgId,id){return must(await sb.rpc('request_doctor_deletion',{p_org:orgId,p_doctor:id}))},
      /* Returns true when an existing answer was updated. */
      async upsertAnswer(orgId,row){
        const hit=must(await sb.from('kb').select('id').eq('org_id',orgId).ilike('title',row.title.replace(/[%_]/g,'\\$&')).limit(1).maybeSingle(),{read:true});
        if(hit){must(await sb.from('kb').update(row).eq('org_id',orgId).eq('id',hit.id));return true}
        must(await sb.from('kb').insert({org_id:orgId,...row}));return false;
      },
      async deleteAnswer(orgId,id){must(await sb.from('kb').delete().eq('org_id',orgId).eq('id',id))},
    },
  };
}

/* The website chat's adapter. It runs with the server's service role (visitors have no account), so it is narrowed by code:
   every call is pinned to the one clinic the verified chat belongs to, whatever organisation id is passed in, and only the
   reads and writes the public tools need exist. Bookings are read only to compute open times; tools never return them. */
export function publicAdapter(svc,orgId,conversationId){
  const all=supabaseAdapter(svc);
  const READ=new Set(['doctors','services','closures','kb','bookings']);
  return{
    async membershipRole(){return null},
    orgTimezone:()=>all.orgTimezone(orgId),
    bookingPolicy:()=>all.bookingPolicy(orgId),
    confirmedFacts:()=>all.confirmedFacts(orgId),
    confirmedExceptions:(_o,from)=>all.confirmedExceptions(orgId,from),
    claimExecution:a=>all.claimExecution({...a,orgId,actorId:null}),
    takeOverExecution:a=>all.takeOverExecution({...a,orgId}),
    finishExecution:a=>all.finishExecution({...a,orgId}),
    async logAudit(_o,action,text){
      must(await svc.from('audit_events').insert({org_id:orgId,actor:null,action:String(action).slice(0,80),target_type:'conversation',target_id:conversationId,
        detail:{text:String(text??'').slice(0,500),source:'website'}}));
    },
    legacy:{
      async list(_o,table){if(!READ.has(table))throw new ToolError('PERMISSION_DENIED','Not available.',{retryable:false});return all.legacy.list(orgId,table)},
      addBooking:(_o,b)=>all.legacy.addBooking(orgId,{...b,source:'website',conversation_id:conversationId}),
      // Patient self-service: the tools have already checked the booking is on the verified phone number.
      setBookingStatus:(_o,id,status)=>all.legacy.setBookingStatus(orgId,id,status),
      updateBooking:(_o,id,b)=>all.legacy.updateBooking(orgId,id,b),
    },
  };
}
