/* Database adapter for the real-database tests. Every call runs as the acting user (JWT claims + authenticated role),
   so row-level security and the database functions enforce permissions exactly as they do in production. */
import {mapDbError} from '../../supabase/functions/_shared/tools/dbErrors.js';

export function pgAdapter(client,actorUid){
  const as=async fn=>{
    await client.query('begin');
    try{
      await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actorUid,role:'authenticated'})]);
      await client.query('set local role authenticated');
      const r=await fn();
      await client.query('commit');
      return r;
    }catch(e){await client.query('rollback').catch(()=>{});throw e}
  };
  const q=(text,params)=>as(()=>client.query(text,params).then(r=>r.rows));
  const write=(text,params)=>as(()=>client.query(text,params).then(r=>r.rows)).catch(e=>{throw mapDbError(e)});
  return {
    async membershipRole(orgId,userId){
      const r=await q('select role from members where org_id=$1 and user_id=$2',[orgId,userId]);
      return r[0]?.role??null;
    },
    listEntities:(orgId,kind)=>q("select id,name from business_entities where org_id=$1 and kind=$2 and status='active' order by name",[orgId,kind]),
    rulesFor:(orgId,entityId)=>q("select weekday,start_min,end_min,slot_minutes from schedule_rules where org_id=$1 and entity_id=$2 and status in ('confirmed','tentative') order by weekday,start_min",[orgId,entityId]),
    exceptionsFor:(orgId,entityId,from,to)=>q(`select on_date::text as on_date,kind,status,note from schedule_exceptions
      where org_id=$1 and (entity_id=$2 or entity_id is null) and on_date between $3 and $4 and status in ('confirmed','tentative') order by on_date`,[orgId,entityId,from,to]),
    factById:async(orgId,id)=>(await q('select id,value,status from business_facts where org_id=$1 and id=$2',[orgId,id]))[0]??null,
    async createException({orgId,entityId,onDate,kind,status,note,ref}){
      const r=await write('select create_schedule_exception($1,$2,$3,$4,$5,$6) as id',[entityId,onDate,kind,status,note,ref]);
      return r[0].id;
    },
    async findExceptionByRef(orgId,ref){
      return (await q("select id,on_date::text as on_date,kind,status from schedule_exceptions where org_id=$1 and source_reference=$2",[orgId,ref]))[0]??null;
    },
    async supersedeFact({factId,value,status,ref}){
      const r=await write("select supersede_fact($1,$2,$3,'manual',$4) as id",[factId,value,status,ref]);
      return r[0].id;
    },
    async findFactByRef(orgId,ref){
      return (await q('select id,supersedes_id,status from business_facts where org_id=$1 and source_reference=$2 order by created_at desc limit 1',[orgId,ref]))[0]??null;
    },
    orgTimezone:async orgId=>(await q('select timezone from organizations where id=$1',[orgId]))[0]?.timezone??null,
    listFacts:async(orgId,{entityId}={})=>q(`select f.id,f.category,f.key,f.value,f.status,e.name as entity_name from business_facts f left join business_entities e on e.id=f.entity_id
      where f.org_id=$1 and f.status in ('confirmed','tentative','pending_approval') and ($2::uuid is null or f.entity_id=$2)`,[orgId,entityId??null]),
    async applyItem(orgId,item,ref){return (await write('select apply_information_item($1,$2::jsonb,$3) as r',[orgId,JSON.stringify(item),ref]))[0].r},
    async logAudit(orgId,action,text){await write('select log_audit($1,$2,$3)',[orgId,action,text])},
    legacy:{
      async list(orgId,table){
        const rows=await q(`select *${table==='bookings'?',starts_at::text as starts_text':''} from ${{doctors:'doctors',bookings:'bookings',services:'services',kb:'kb',closures:'closures'}[table]} where org_id=$1`,[orgId]);
        return rows.map(r=>table==='doctors'?{id:r.id,name:r.name,specialty:r.specialty,services:r.services,days:r.days,start:r.start_time,end:r.end_time,slot:r.slot}
          :table==='bookings'?{id:r.id,name:r.name,phone:r.phone,service:r.service,when:r.starts_text.slice(0,16).replace(' ','T'),doctor_id:r.doctor_id,doctor:r.doctor,status:r.status}
          :table==='closures'?{id:r.id,date:r.date}:r);
      },
      async addBooking(orgId,b){return (await write('insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status) values($1,$2,$3,$4,$5,$6,$7,$8) returning id',[orgId,b.name,b.phone,b.service,b.when,b.doctor_id,b.doctor,b.status]))[0]},
      async setBookingStatus(orgId,id,status){await write('update bookings set status=$3 where org_id=$1 and id=$2',[orgId,id,status])},
    },
    async claimExecution({orgId,tool,version,key,hash,actorId}){
      const ins=await as(()=>client.query(`insert into tool_executions(org_id,tool_name,tool_version,idempotency_key,input_hash,actor,status)
        values($1,$2,$3,$4,$5,$6,'started') on conflict (org_id,tool_name,idempotency_key) do nothing returning id`,[orgId,tool,version,key,hash,actorId]).then(r=>r.rows));
      if(ins.length)return {claimed:true};
      const row=(await q('select status,input_hash,result,updated_at from tool_executions where org_id=$1 and tool_name=$2 and idempotency_key=$3',[orgId,tool,key]))[0];
      return {claimed:false,row:{...row,updated_at:new Date(row.updated_at).toISOString()}};
    },
    async takeOverExecution({orgId,tool,key,hash,staleBefore}){
      const r=await as(()=>client.query(`update tool_executions set status='started',attempts=attempts+1,updated_at=now()
        where org_id=$1 and tool_name=$2 and idempotency_key=$3 and input_hash=$4 and (status in ('failed','interrupted') or (status='started' and updated_at<$5)) returning id`,
        [orgId,tool,key,hash,staleBefore]).then(r=>r.rows));
      return r.length>0;
    },
    async finishExecution({orgId,tool,key,status,result,errorCode}){
      await as(()=>client.query(`update tool_executions set status=$4,result=$5,error_code=$6,updated_at=now()
        where org_id=$1 and tool_name=$2 and idempotency_key=$3`,[orgId,tool,key,status,result?JSON.stringify(result):null,errorCode??null]));
    },
  };
}
