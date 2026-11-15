// Forwards AI requests for a signed-in clinic member. The clinic's own model key and daily limit are applied here, on the server.
import {createClient} from 'npm:@supabase/supabase-js@2';
import {orgProvider} from '../_shared/provider.ts';
import {postChat} from '../_shared/agent.js';
import {logEvent,allow} from '../_shared/ops.js';
import {withCors,clientIp} from '../_shared/http.js';

const cors={'Content-Type':'application/json'};   // CORS and safety headers are set by withCors
const J=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const MAX_CHARS=120000;

export {orgProvider};

Deno.serve(withCors(async req=>{
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
    // tool_choice is only valid alongside tools; plain completions (Quick setup formatting) send neither.
    ...(Array.isArray(body.tools)&&body.tools.length?{tools:body.tools,tool_choice:body.tool_choice??'auto'}:{}),
    max_completion_tokens:Math.min(Number(body.max_completion_tokens)||2000,4000),
    reasoning_effort:body.reasoning_effort??'none',
    response_format:body.response_format,
  };

  // 3. Server-side key and limit for this clinic, plus a per-person burst limit.
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if(!await allow(svc,'llm:user:'+user.id,60,60))return J({error:'Too many AI requests. Please wait a moment.'},429);
  const pv=await orgProvider(svc,orgId);
  if(pv.error)return J({error:pv.error},pv.status);
  const p=pv.provider!;

  const t0=Date.now(),attempts:any[]=[];
  try{
    // Timeouts, retries on 429/5xx/network errors and the optional fallback provider all live in postChat.
    const j=await postChat(p,{model:p.model,...payload},{onAttempt:a=>attempts.push(a)});
    logEvent('llm-proxy',{org:orgId,outcome:'ok',ms:Date.now()-t0,attempts});
    return new Response(JSON.stringify(j),{status:200,headers:{...cors,'Content-Type':'application/json'}});
  }catch(e){logEvent('llm-proxy',{org:orgId,outcome:'model_failed',ms:Date.now()-t0,attempts,error:String(e).slice(0,200)});return J({error:'Model unavailable'},502)}
}));
