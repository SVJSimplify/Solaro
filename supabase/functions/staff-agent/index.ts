// Staff assistant. The model gets the registry's real tool definitions for the caller's role, and every tool call it makes
// runs through the central executor with the caller's own session, so row-level security applies to every read and write.
import {createClient} from 'npm:@supabase/supabase-js@2';
import {orgProvider} from '../_shared/provider.ts';
import {buildRegistry,runToolLoop} from '../_shared/tools/index.js';
import {supabaseAdapter} from '../_shared/tools/supabaseAdapter.js';
import {callModelRaw} from '../_shared/agent.js';
import {staffSystem,SETUP_GUIDE} from '../_shared/tools/prompt.js';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
const J=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const registry=buildRegistry();
const withTimeout=<T,>(p:Promise<T>,ms:number)=>Promise.race([p,new Promise<T>((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms))]);

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return J({error:'POST only'},405);

  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  if(!token)return J({error:'Sign in required'},401);
  if(!Deno.env.get('SUPABASE_URL')||!Deno.env.get('SUPABASE_ANON_KEY')||!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))return J({error:'Server not configured'},500);
  const sb=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:'Bearer '+token}}});
  const {data:{user}}=await sb.auth.getUser(token);
  if(!user)return J({error:'Sign in required'},401);
  const {data:mem}=await sb.from('members').select('org_id,role,organizations(name)').limit(1);
  if(!mem?.length)return J({error:'Not a clinic member'},403);
  const {org_id:orgId,role}=mem[0] as any;

  let body:any;
  try{body=await req.json()}catch{return J({error:'Invalid JSON'},400)}
  const msgs=body?.messages;
  if(!Array.isArray(msgs)||!msgs.length||msgs.length>40||msgs.some((m:any)=>!['user','assistant'].includes(m?.role)||typeof m.content!=='string'||m.content.length>12000))return J({error:'Bad request'},400);

  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const pv:any=await orgProvider(svc,orgId);
  if(pv.error)return J({error:pv.error},pv.status);

  try{
    const db=supabaseAdapter(sb);
    const out={confirmations:[] as any[]};
    const timeZone=(await db.orgTimezone(orgId))??'UTC';
    const res=await withTimeout(runToolLoop({
      callModel:(m:any,t:any)=>callModelRaw({...pv.provider,maxTokens:2000,reasoningEffort:'none'},m,t),
      registry,db,role,surface:'staff',
      ctx:{orgId,userId:user.id,timeZone,out,requestId:crypto.randomUUID()},
      system:staffSystem({org:(mem[0] as any).organizations?.name??'this clinic',role,today:new Intl.DateTimeFormat('en-CA',{timeZone}).format(new Date()),timeZone})+(body.mode==='setup'?'\n\n'+SETUP_GUIDE:''),
      messages:msgs.map((m:any)=>({role:m.role,content:m.content})),
      // Setup messages can hold a whole pasted document, so allow enough steps to save every item.
      maxSteps:body.mode==='setup'?24:8,
    }),body.mode==='setup'?110000:50000);
    return J({reply:res.reply,calls:res.calls,stopped:res.stopped,confirmations:out.confirmations});
  }catch(e){const t=String(e).includes('timeout');console.error('staff-agent failed',String(e));return J({error:t?'The assistant took too long. Try again.':'The assistant is unavailable. Try again shortly.'},t?504:502)}
});
