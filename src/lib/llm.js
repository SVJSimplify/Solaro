/* AI calls go through Solara's server (edge function llm-proxy). The model key lives only in Supabase secrets, never in the browser. */
import {accessToken} from './supabasedb';

const PROXY=import.meta.env.VITE_SUPABASE_URL+'/functions/v1/llm-proxy';
const ANON=import.meta.env.VITE_SUPABASE_ANON_KEY;

/* Attaches the signed-in user's session to each request, so the server can check membership. */
const proxyAuth=async()=>({Authorization:'Bearer '+((await accessToken())??''),apikey:ANON});

/* Available only with a backend. The local demo has no AI, so it falls back to the rule-based answers. */
export const devProviders=()=>import.meta.env.VITE_SUPABASE_URL?[{endpoint:PROXY,proxy:true,auth:proxyAuth,model:'',key:'',maxTokens:4000,jsonMode:true}]:[];

/* Staff assistant: runs on the server (edge function staff-agent) with the registry's tools and the caller's own permissions. */
export async function staffAgent(messages,mode){
  const r=await fetch(import.meta.env.VITE_SUPABASE_URL+'/functions/v1/staff-agent',{method:'POST',headers:{'Content-Type':'application/json',...(await proxyAuth())},body:JSON.stringify({messages,mode})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.error||'The assistant is unavailable');
  return j;
}
