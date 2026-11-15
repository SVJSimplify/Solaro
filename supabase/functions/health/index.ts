// Public health check for uptime monitors (UptimeRobot, Better Stack, …).
// 200 when Solara is up (status ok or degraded), 503 when a critical check fails or the database cannot be reached.
// Returns status and pass/fail per check only: no names, counts or patient information.
import {createClient} from 'npm:@supabase/supabase-js@2';
import {allow,logEvent} from '../_shared/ops.js';
import {clientIp} from '../_shared/http.js';

const H={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reply=(body:unknown,status:number)=>new Response(JSON.stringify(body),{status,headers:H});

Deno.serve(async req=>{
  if(req.method!=='GET'&&req.method!=='HEAD')return reply({error:'GET only'},405);
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if(!await allow(svc,'health:ip:'+clientIp(req),60,60))return reply({error:'Too many requests'},429);
  const {data,error}=await svc.rpc('health_public');
  if(error||!data){logEvent('health',{outcome:'db_unreachable',error:String(error?.message??'no data').slice(0,200)});return reply({status:'down',checks:{database:false}},503)}
  return reply({...data,checks:{database:true,...data.checks}},data.status==='down'?503:200);
});
