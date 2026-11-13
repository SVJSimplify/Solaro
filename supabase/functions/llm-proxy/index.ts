// Forwards AI requests for a signed-in clinic member. The clinic's own model key and daily limit are applied here, on the server.
import {createClient} from 'npm:@supabase/supabase-js@2';
import {orgProvider} from '../_shared/provider.ts';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
const J=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const MAX_CHARS=120000;

export {orgProvider};

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return J({error:'POST only'},405);

  // 1. Must be a signed-in user, and a member of a clinic (RLS limits this to their own memberships).
  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:'Bearer '+token}}});
  const {data:{user}}=await sb.auth.getUser(token);
  if(!user)return J({error:'Sign in required'},401);
  const {data:mem}=await sb.from('members').select('org_id').limit(1);
  if(!mem?.length)return J({error:'Not a clinic member'},403);
  const orgId=mem[0].org_id;

  // 2. Only the fields the agent uses, with size and token limits.
  let body:any;
  try{body=await req.json()}catch{return J({error:'Invalid JSON'},400)}
  if(!Array.isArray(body?.messages)||JSON.stringify(body.messages).length>MAX_CHARS)return J({error:'Bad request'},400);
  const payload={
    messages:body.messages,
    tools:Array.isArray(body.tools)?body.tools:undefined,
    tool_choice:body.tool_choice??'auto',
    max_completion_tokens:Math.min(Number(body.max_completion_tokens)||2000,4000),
    reasoning_effort:body.reasoning_effort??'none',
    response_format:body.response_format,
  };

  // 3. Server-side key and limit for this clinic.
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const pv=await orgProvider(svc,orgId);
  if(pv.error)return J({error:pv.error},pv.status);
  const p=pv.provider!;

  try{
    const r=await fetch(p.endpoint.replace(/\/+$/,'')+'/chat/completions',{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+p.key},
      body:JSON.stringify({model:p.model,...payload})});
    const text=await r.text();
    if(!r.ok){console.error('llm provider error',r.status,text.slice(0,200));return J({error:'Model unavailable'},502)}
    return new Response(text,{status:200,headers:{...cors,'Content-Type':'application/json'}});
  }catch(e){console.error('llm provider unreachable',String(e));return J({error:'Model unavailable'},502)}
});
