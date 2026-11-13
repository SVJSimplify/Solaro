// Sends queued patient text messages. Woken by pg_cron (outbox_kick) only when something is due; no browser is involved.
// Claiming is atomic in the database (outbox_claim), so two runs can never send the same message, and a run that dies
// mid-batch leaves its rows to be picked up again after 5 minutes. Every result is written back (outbox_mark):
// sent, or queued again with a backoff, or failed after 5 attempts.
// Secrets (Supabase dashboard > Edge Functions > Secrets): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.
// Without them nothing is claimed and nothing is marked sent: messages stay queued, visibly, and expire to "failed" after 24 hours.
import {createClient} from 'npm:@supabase/supabase-js@2';

const J=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json'}});
const log=(f:Record<string,unknown>)=>console.log(JSON.stringify({ts:new Date().toISOString(),fn:'outbox-dispatch',...f}));   // never log numbers or message text

Deno.serve(async req=>{
  if(req.method!=='POST')return J({error:'POST only'},405);
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  const {data:ok}=await svc.rpc('outbox_dispatch_check',{p_token:req.headers.get('x-dispatch-token')??''});
  if(ok!==true)return J({error:'Not allowed'},401);

  const sid=Deno.env.get('TWILIO_ACCOUNT_SID'),tok=Deno.env.get('TWILIO_AUTH_TOKEN'),from=Deno.env.get('TWILIO_FROM');
  if(!sid||!tok||!from){log({outcome:'provider_not_configured'});return J({configured:false,sent:0})}

  const {data:rows,error}=await svc.rpc('outbox_claim',{p_limit:20});
  if(error){log({outcome:'claim_failed',error:String(error.message).slice(0,200)});return J({error:'claim failed'},500)}
  let sent=0,failed=0;
  for(const m of rows??[]){
    let good=false,err='',pid='';
    try{
      if(m.channel!=='sms')throw new Error('No sender for channel '+m.channel);
      const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:'POST',signal:AbortSignal.timeout(10000),
        headers:{Authorization:'Basic '+btoa(sid+':'+tok),'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({To:m.to_addr,From:from,Body:m.body})});
      const j=await r.json().catch(()=>({}));
      if(r.ok){good=true;pid=String(j.sid??'')}else err=`Provider ${r.status}: ${String(j.message??'').slice(0,160)}`;
    }catch(e){err=String(e).slice(0,200)}
    const {error:me}=await svc.rpc('outbox_mark',{p_id:m.id,p_ok:good,p_error:err,p_provider_id:pid});
    if(me)log({outcome:'mark_failed',id:m.id});
    good?sent++:failed++;
    log({outcome:good?'sent':'send_failed',id:m.id,org:m.org_id,kind:m.kind,attempt:m.attempts});
  }
  return J({configured:true,sent,failed});
});
