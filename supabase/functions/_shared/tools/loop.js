/* The model loop. The model sees only the registry's own tool definitions (native tool calling); every call it makes goes through
   executeTool, so validation, permissions, idempotency and patient-information checks cannot be skipped. Nothing here knows any tool by name. */
import {modelToolsFor} from './registry.js';
import {executeTool} from './executor.js';
import {fail,ToolError} from './errors.js';

const MAX_RESULT_CHARS=12000;
const lastUser=messages=>[...messages].reverse().find(m=>m.role==='user')?.content??'';

/* callModel(messages, tools) -> assistant message {content, tool_calls}. Supplied by the caller (the existing provider integration). */
export async function runToolLoop({callModel,registry,db,ctx,role,surface,system,messages,maxSteps=8,onCall}){
  const tools=modelToolsFor(registry,{role,surface});
  const c={...ctx,surface,userMessage:ctx.userMessage??lastUser(messages)};
  const convo=[{role:'system',content:system},...messages];
  const calls=[];
  let streak={key:'',n:0};
  for(let step=0;step<maxSteps;step++){
    const msg=await callModel(convo,tools);
    convo.push({role:'assistant',content:msg.content??null,...(msg.tool_calls?.length?{tool_calls:msg.tool_calls}:{})});
    if(!msg.tool_calls?.length)return{reply:msg.content?.trim()||'Done.',calls,steps:step+1,stopped:null};
    for(const call of msg.tool_calls){
      let env;
      let args;
      try{args=JSON.parse(call.function.arguments||'{}')}
      catch{env=fail(new ToolError('INVALID_ARGUMENT','The arguments were not valid JSON.',{retryable:false,nextStep:'Send the arguments again as a JSON object.'}))}
      env??=await executeTool(registry,call.function.name,args,c,db);
      calls.push({name:call.function.name,ok:env.ok,code:env.ok?null:env.error.code});
      onCall?.(call.function.name,env);
      convo.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(env).slice(0,MAX_RESULT_CHARS)});
      // The same failure three times in a row means the model is stuck. Stop and tell the person.
      const key=env.ok?'':`${call.function.name}:${env.error.code}`;
      streak=key&&key===streak.key?{key,n:streak.n+1}:{key,n:key?1:0};
      if(streak.n>=3)return{reply:`I could not finish that: ${env.error.message} ${env.error.next_step??''}`.trim(),calls,steps:step+1,stopped:'repeated_error'};
    }
  }
  return{reply:'I stopped after several steps. Tell me what is still missing and I will continue.',calls,steps:maxSteps,stopped:'max_steps'};
}
