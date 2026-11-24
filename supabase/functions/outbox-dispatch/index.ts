// Sends queued messages: text messages (Twilio), WhatsApp (Meta Cloud API) and app push notifications (Firebase Cloud Messaging).
// Woken every minute by pg_cron (outbox_kick) when something is due; no browser is involved.
// Claiming is atomic in the database (outbox_claim), so two runs can never send the same message, and a run that dies
// mid-batch leaves its rows to be picked up again after 5 minutes. Every result is written back (outbox_mark):
// sent, or queued again with a backoff, or failed after 5 attempts. Only channels with a configured provider are claimed,
// so push keeps working while text messages are not set up (and the other way round).
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (text) · WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, optional WHATSAPP_REMINDER_TEMPLATE (default appointment_reminder), WHATSAPP_TEMPLATE_LANG (default en) · FIREBASE_SERVICE_ACCOUNT (push).
import {createClient} from 'npm:@supabase/supabase-js@2';
import {sendPush} from '../_shared/firebase.js';
import {sendWhatsApp} from '../_shared/whatsapp.js';

const J=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{'Content-Type':'application/json'}});
const log=(f:Record<string,unknown>)=>console.log(JSON.stringify({ts:new Date().toISOString(),fn:'outbox-dispatch',...f}));   // never log numbers, tokens or message text

function serviceAccount(){
  try{const sa=JSON.parse(Deno.env.get('FIREBASE_SERVICE_ACCOUNT')??'');return sa?.client_email&&sa?.private_key&&sa?.project_id?sa:null}catch{return null}
}

Deno.serve(async req=>{
  if(req.method!=='POST')return J({error:'POST only'},405);
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false}});
  const {data:ok}=await svc.rpc('outbox_dispatch_check',{p_token:req.headers.get('x-dispatch-token')??''});
  if(ok!==true)return J({error:'Not allowed'},401);

  const sid=Deno.env.get('TWILIO_ACCOUNT_SID'),tok=Deno.env.get('TWILIO_AUTH_TOKEN'),from=Deno.env.get('TWILIO_FROM');
  const sa=serviceAccount();
  const wa={phoneNumberId:Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')??'',accessToken:Deno.env.get('WHATSAPP_ACCESS_TOKEN')??'',template:Deno.env.get('WHATSAPP_REMINDER_TEMPLATE')||'appointment_reminder',lang:Deno.env.get('WHATSAPP_TEMPLATE_LANG')||'en'};
  const channels=[...(sid&&tok&&from?['sms']:[]),...(wa.phoneNumberId&&wa.accessToken?['whatsapp']:[]),...(sa?['push']:[])];
  if(!channels.length){log({outcome:'no_provider_configured'});return J({configured:false,sent:0})}

  const {data:rows,error}=await svc.rpc('outbox_claim',{p_limit:50,p_channels:channels});
  if(error){log({outcome:'claim_failed',error:String(error.message).slice(0,200)});return J({error:'claim failed'},500)}
  let sent=0,failed=0;
  for(const m of rows??[]){
    let good=false,err='',pid='';
    try{
      if(m.channel==='sms'){
        const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:'POST',signal:AbortSignal.timeout(10000),
          headers:{Authorization:'Basic '+btoa(sid+':'+tok),'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({To:m.to_addr,From:from!,Body:m.body})});
        const j=await r.json().catch(()=>({}));
        if(r.ok){good=true;pid=String(j.sid??'')}else err=`Provider ${r.status}: ${String(j.message??'').slice(0,160)}`;
      }else if(m.channel==='whatsapp'){
        const r=await sendWhatsApp(wa,m);
        if(r.ok){good=true;pid=r.id}else err=r.error;
      }else if(m.channel==='push'){
        const r=await sendPush(sa,{token:m.to_addr,title:m.title||'Solara',body:m.body,data:m.data??{}});
        if(r.ok){good=true;pid=r.id}
        else{err=r.error;if(r.gone){await svc.rpc('push_device_gone',{p_token:m.to_addr});err='Device no longer registered'}}
      }else err='No sender for channel '+m.channel;
    }catch(e){err=String(e).slice(0,200)}
    const {error:me}=await svc.rpc('outbox_mark',{p_id:m.id,p_ok:good,p_error:err,p_provider_id:pid});
    if(me)log({outcome:'mark_failed',id:m.id});
    good?sent++:failed++;
    log({outcome:good?'sent':'send_failed',id:m.id,org:m.org_id,channel:m.channel,kind:m.kind,attempt:m.attempts});
  }
  return J({configured:true,channels,sent,failed});
});
