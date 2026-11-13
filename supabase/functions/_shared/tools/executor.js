/* The execution pipeline. Every tool call passes through every stage, in this order:
   registry lookup, schema validation, authentication, membership, role, normalisation, strict schema,
   action authorisation, preconditions, idempotency claim, execution (with retries and timeout), output verification, record, response.
   The model cannot skip a stage: it only ever calls executeTool. */
import {ToolError,ok,fail,toEnvelope} from './errors.js';
import {assertValid} from './schema.js';
import {withRetry,withTimeout} from './retry.js';
import {canUse} from './registry.js';
import {todayIn,containsPatientInfo} from './normalise.js';

const STALE_MS=30_000;

/* Stable JSON so the same input always gives the same hash, whatever the key order. */
function stable(v){
  if(v===null||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(stable).join(',')+']';
  return '{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
}
export async function canonicalHash(obj){
  const {idempotency_key:_k,...rest}=obj;
  const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(rest)));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

/* Idempotency: a repeated call with the same key replays the stored result and never repeats the change.
   A key reused for a different request is refused. A call whose earlier attempt may have partly run is checked against the
   record of the change before anything is repeated. */
async function claimOrReplay(tool,args,c,db,hash){
  const key=args.idempotency_key;
  const got=await db.claimExecution({orgId:c.orgId,tool:tool.name,version:tool.version,key,hash,actorId:c.userId});
  if(got.claimed)return {claimed:true};
  const row=got.row;
  if(row.input_hash!==hash)throw new ToolError('INVALID_ARGUMENT','This idempotency key was already used for a different request. Use a new key for a new request.',{field:'idempotency_key',retryable:false});
  if(row.status==='succeeded')return {replay:row.result};
  if(tool.recover){
    const found=await tool.recover(args,c,db);
    if(found){await db.finishExecution({orgId:c.orgId,tool:tool.name,key,status:'succeeded',result:found});return {replay:found}}
  }
  const staleBefore=new Date(Date.now()-STALE_MS).toISOString();
  // 'interrupted' means the last attempt returned a retryable error. 'started' with no end recorded is only taken over once it is stale.
  if(row.status==='failed'||row.status==='interrupted'||(row.status==='started'&&row.updated_at<staleBefore)){
    if(await db.takeOverExecution({orgId:c.orgId,tool:tool.name,key,hash,staleBefore}))return {claimed:true};
  }
  throw new ToolError('RESOURCE_CONFLICT','A previous attempt with this key is still running. Wait a moment, then retry with the same key.',{field:'idempotency_key',retryable:true});
}

export function assertNoPatientInfo(v,path=''){
  if(typeof v==='string'){
    if(containsPatientInfo(v))throw new ToolError('PRECONDITION_FAILED','Patient information (contact details, medical details) cannot be stored here. Remove it and try again.',{field:path||null,retryable:false,nextStep:'Leave out patient names, phone numbers, emails and medical details.'});
  }else if(Array.isArray(v))v.forEach((x,i)=>assertNoPatientInfo(x,`${path}[${i}]`));
  else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v))if(k!=='idempotency_key')assertNoPatientInfo(x,path?`${path}.${k}`:k);
}

export async function executeTool(registry,name,rawArgs,ctx,db){
  let tool=null, claimed=false, args=null;
  const key=()=>args?.idempotency_key;
  try{
    tool=registry.get(name);                                                   // 1 registry lookup
    if(rawArgs===null||typeof rawArgs!=='object'||Array.isArray(rawArgs))
      throw new ToolError('INVALID_ARGUMENT','Arguments must be an object.',{field:'arguments'});
    assertValid(tool.input,rawArgs,{phase:'raw'});                             // 2 schema (raw input)
    // 3 authentication. A website visitor is the "public" principal: no account, bound to one verified chat in one clinic.
    const pub=ctx?.surface==='public';
    if(pub?(!ctx.orgId||!ctx.conversationId):(!ctx?.userId||!ctx?.orgId))throw new ToolError('PERMISSION_DENIED','Sign in to use this action.',{retryable:false});
    const role=pub?'public':await db.membershipRole(ctx.orgId,ctx.userId);    // 4 membership
    if(!role)throw new ToolError('PERMISSION_DENIED','You do not have access to this clinic.',{retryable:false});
    if(pub&&!tool.surfaces?.includes('public'))throw new ToolError('PERMISSION_DENIED','That action is not available here.',{retryable:false});
    if(ctx.surface&&tool.surfaces&&!tool.surfaces.includes(ctx.surface))throw new ToolError('PERMISSION_DENIED','That action is not available here.',{retryable:false});
    if(!canUse(role,tool))throw new ToolError('PERMISSION_DENIED',`This action needs ${tool.minRole} access.`,{retryable:false,nextStep:'Ask an owner or admin to do this.'});
    // The organisation's own time zone decides what "today" and "next Tuesday" mean.
    let tz=ctx.timeZone??(await db.orgTimezone?.(ctx.orgId))??'UTC';
    let today;try{today=ctx.today??todayIn(tz,ctx.now)}catch{tz='UTC';today=ctx.today??todayIn('UTC',ctx.now)}
    const c={...ctx,role,userId:pub?null:ctx.userId,orgId:ctx.orgId,timeZone:tz,today};
    // Patient information is refused by code, not by instruction. Tools that legitimately handle it declare patientData:'contact'.
    if(role==='doctor'&&tool.patientData!=='none')throw new ToolError('PERMISSION_DENIED','Doctors cannot use this action.',{retryable:false});
    if(tool.writes&&tool.patientData==='none'&&!tool.scansItems)assertNoPatientInfo(rawArgs);
    args=await tool.normalise(rawArgs,c,db);                                  // 5 normalisation
    assertValid(tool.canonical,args,{phase:'canonical'});                      // 6 strict schema (canonical)
    if(tool.autoKey&&!args.idempotency_key)args.idempotency_key='auto-'+(await canonicalHash({...args,tool:tool.name,turn:c.requestId??''})).slice(0,40);
    tool.authorize?.(args,c);                                                  // 7 action-level authorisation
    await tool.preconditions?.(args,c,db);                                     // 8 business validation
    if(tool.writes){
      if(!args.idempotency_key)throw new ToolError('MISSING_INFORMATION','This change needs an idempotency key.',{field:'idempotency_key',nextStep:'Provide a unique key for this request.'});
      const hash=await canonicalHash(args);
      const got=await claimOrReplay(tool,args,c,db,hash);                      // 9 idempotency claim
      if(got.replay!==undefined)return ok(got.replay,{tool:tool.name,version:tool.version,replayed:true});
      claimed=true;
    }
    const attempts=tool.writes?1:3;                                            // writes are never blindly retried; the key makes a later retry safe
    const result=await withTimeout(withRetry(()=>tool.run(args,c,db),{attempts}),tool.timeoutMs??8000,tool.name);  // 10 execution
    try{assertValid(tool.output,result,{phase:'output'})}                      // 11 output verification
    catch{throw new ToolError('VERIFICATION_FAILED','The result could not be verified. Check the record before trying again.',{retryable:false})}
    if(tool.writes)await db.finishExecution({orgId:c.orgId,tool:tool.name,key:key(),status:'succeeded',result});  // 12 record
    return ok(result,{tool:tool.name,version:tool.version,replayed:false});    // 13 structured response
  }catch(e){
    if(globalThis.process?.env?.TOOL_DEBUG&&!(e instanceof ToolError))console.error('[tool]',name,e);   // unexpected errors are hidden from the model; this shows them while debugging
    if(claimed&&tool){
      // Retryable: the change may or may not have happened, so the record says 'interrupted' and the next call checks before repeating it.
      const status=e instanceof ToolError&&e.retryable?'interrupted':'failed';
      await db.finishExecution({orgId:ctx.orgId,tool:tool.name,key:key(),status,errorCode:e.code??'EXECUTION_FAILED'}).catch(()=>{});
    }
    return toEnvelope(e);
  }
}
