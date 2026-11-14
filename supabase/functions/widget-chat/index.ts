// Public website chat. Visitors have no account: each chat has a secret token (only its hash is stored).
// Every tool call runs through the central registry and executor as the "public" principal, pinned to this chat's clinic.
// Bookings made here are requests that the clinic's team confirms (unless the clinic turned on auto-confirm).
import {createClient} from 'npm:@supabase/supabase-js@2';
import {orgProvider} from '../_shared/provider.ts';
import {buildRegistry,runToolLoop,executeTool} from '../_shared/tools/index.js';
import {publicAdapter} from '../_shared/tools/supabaseAdapter.js';
import {bookingForm,wantsBooking,wantsManage} from '../_shared/tools/front.js';
import {normalizePhone,countryForTimeZone} from '../_shared/tools/phone.js';
import {logEvent,allow} from '../_shared/ops.js';
import {publicSystem,checkAppointmentClaim} from '../_shared/tools/prompt.js';
import {buildMessages,triage,cleanForm,hasHealthSignal,REASONS,FALLBACK,callModelRaw} from '../_shared/agent.js';

const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
const J=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
const MSG_PER_MINUTE=10;
const registry=buildRegistry();
const ENDED='This chat session has ended. Please refresh the page to start again.';
const withTimeout=<T,>(p:Promise<T>,ms:number)=>Promise.race([p,new Promise<T>((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms))]);
const sha256hex=async(s:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const VERIFIED_FOR_MS=30*60e3,CODE_TTL_MS=10*60e3;

/* Text messages go out through Twilio when the server has its secrets; otherwise self-service is switched off. */
const smsReady=()=>!!(Deno.env.get('TWILIO_ACCOUNT_SID')&&Deno.env.get('TWILIO_AUTH_TOKEN')&&Deno.env.get('TWILIO_FROM'));
async function sendSms(to:string,body:string){
  const sid=Deno.env.get('TWILIO_ACCOUNT_SID')!,tok=Deno.env.get('TWILIO_AUTH_TOKEN')!;
  const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,{method:'POST',
    headers:{Authorization:'Basic '+btoa(`${sid}:${tok}`),'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({To:to,From:Deno.env.get('TWILIO_FROM')!,Body:body})});
  if(!r.ok)throw new Error('SMS failed: '+r.status);
}
const nice=(when:string)=>{const [d,t]=when.split(/[ T]/);return `${new Date(d+'T00:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'})} at ${t}`};

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return J({error:'POST only'},405);

  let body:any;
  try{body=await req.json()}catch{return J({error:'Invalid JSON'},400)}
  const svc=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // 1. The chat session must match its token.
  const cid=String(body.conversation_id??''),token=String(body.token??'');
  if(!/^[0-9a-f-]{36}$/i.test(cid)||token.length<32)return J({error:ENDED},401);
  const {data:sess}=await svc.from('widget_sessions').select('token_hash').eq('conversation_id',cid).maybeSingle();
  if(!sess||sess.token_hash!==await sha256hex(token))return J({error:ENDED},401);
  const {data:convo}=await svc.from('conversations').select('id,org_id,customer,status').eq('id',cid).single();
  if(!convo)return J({error:'Chat not found'},404);
  const orgId=convo.org_id;
  const action=String(body.action??'message');

  // Burst limits for everything except polling: per chat, and per clinic so one busy or abusive site cannot exhaust the
  // database or the clinic's AI budget. Polling is cheap (an indexed read) and is limited by the browser's 5-second timer.
  if(action!=='poll'&&(!await allow(svc,'widget:chat:'+cid,40,60)||!await allow(svc,'widget:org:'+orgId,1200,60))){
    logEvent('widget-chat',{org:orgId,action,outcome:'rate_limited'});
    return J({error:'Please wait a moment before trying again.'},429);
  }

  // 2. Poll: every message in this chat after a given time, including staff replies.
  if(body.action==='poll'){
    const since=typeof body.since==='string'?body.since:'1970-01-01T00:00:00Z';
    const {data:msgs}=await svc.from('messages').select('role,body,created_at')
      .eq('org_id',orgId).eq('conversation_id',cid).gt('created_at',since).order('created_at');
    return J({messages:msgs??[],status:convo.status});
  }

  const db=publicAdapter(svc,orgId,cid);
  const timeZone=(await db.orgTimezone().catch(()=>null))??'UTC';
  const ctx=(out:any)=>({orgId,conversationId:cid,surface:'public',timeZone,out,requestId:crypto.randomUUID()});
  const say=(role:string,text:string)=>svc.from('messages').insert({org_id:orgId,conversation_id:cid,role,body:text});
  const recent=async()=>{
    const {count}=await svc.from('messages').select('id',{count:'exact',head:true})
      .eq('conversation_id',cid).eq('role','cust').gt('created_at',new Date(Date.now()-60000).toISOString());
    return (count??0)>=MSG_PER_MINUTE;
  };

  // Self-service: the phone number this chat proved it owns in the last 30 minutes, from the server's own record.
  const verifiedPhone=async()=>{
    const {data}=await svc.from('patient_verifications').select('phone,verified_at').eq('conversation_id',cid).not('verified_at','is',null)
      .order('verified_at',{ascending:false}).limit(1).maybeSingle();
    return data&&Date.now()-Date.parse(data.verified_at)<VERIFIED_FOR_MS?data.phone:null;
  };

  // 3a. Send a code. The answer is the same whether or not the number has appointments, so numbers cannot be probed.
  if(body.action==='verify_start'){
    if(!smsReady())return J({error:'Managing appointments online is not available yet. Type your request in the chat and our team will help.',unavailable:true},503);
    const phone=normalizePhone(String(body.phone??''),countryForTimeZone(timeZone));
    if(!phone)return J({error:'Please enter a valid US or Indian phone number.'},400);
    const hourAgo=new Date(Date.now()-3600e3).toISOString();
    const [byChat,byPhone]=await Promise.all([
      svc.from('patient_verifications').select('id',{count:'exact',head:true}).eq('conversation_id',cid).gt('created_at',hourAgo),
      svc.from('patient_verifications').select('id',{count:'exact',head:true}).eq('org_id',orgId).eq('phone',phone).gt('created_at',hourAgo)]);
    if((byChat.count??0)>=3||(byPhone.count??0)>=5)return J({error:'Too many codes requested. Please try again later.'},429);
    const {data:has}=await svc.from('bookings').select('id').eq('org_id',orgId).eq('phone',phone).neq('status','cancelled').limit(1);
    if(has?.length){
      const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1e6).padStart(6,'0'),id=crypto.randomUUID();
      await svc.from('patient_verifications').insert({id,org_id:orgId,conversation_id:cid,phone,code_hash:await sha256hex(id+':'+code),expires_at:new Date(Date.now()+CODE_TTL_MS).toISOString()});
      const {data:o}=await svc.from('organizations').select('name').eq('id',orgId).single();
      try{await sendSms(phone,`${code} is your ${o?.name??'clinic'} code to manage your appointment. It expires in 10 minutes.`)}
      catch(e){logEvent('widget-chat',{org:orgId,action,outcome:'sms_failed',error:String(e).slice(0,200)});return J({error:'We could not send a text right now. Please try again shortly.'},502)}
    }
    return J({sent:true,message:'If that number has appointments with us, a 6-digit code is on its way.'});
  }

  // 3b. Check the code. Five wrong tries and it stops working.
  if(body.action==='verify_check'){
    const code=String(body.code??'').replace(/\D/g,'');
    const {data:v}=await svc.from('patient_verifications').select('id,attempts,expires_at').eq('conversation_id',cid).is('verified_at',null)
      .order('created_at',{ascending:false}).limit(1).maybeSingle();
    const bad=()=>J({error:'That code is not right or has expired. Request a new one.'},400);
    if(!v||Date.parse(v.expires_at)<Date.now()||v.attempts>=5||code.length!==6)return bad();
    const {data:row}=await svc.from('patient_verifications').select('code_hash').eq('id',v.id).single();
    if(row?.code_hash!==await sha256hex(v.id+':'+code)){await svc.from('patient_verifications').update({attempts:v.attempts+1}).eq('id',v.id);return bad()}
    await svc.from('patient_verifications').update({verified_at:new Date().toISOString()}).eq('id',v.id);
    return J({verified:true});
  }

  // 3c. The verified patient's own appointments: list, cancel, move. All through the executor; the tools re-check ownership.
  if(body.action==='my_bookings'||body.action==='cancel'||body.action==='reschedule'){
    const phone=await verifiedPhone();
    if(!phone)return J({error:'Please verify your phone number again.',verify:true},401);
    const out:any={};
    const vctx={...ctx(out),verifiedPhone:phone};
    if(body.action==='my_bookings'){
      const env=await executeTool(registry,'my_appointments',{},vctx,db);
      return env.ok?J({appointments:env.data.appointments}):J({error:env.error.message},400);
    }
    const key=typeof body.key==='string'&&body.key.length>=8?{idempotency_key:body.key.slice(0,128)}:{};
    if(body.action==='cancel'){
      const env=await executeTool(registry,'cancel_my_appointment',{booking_id:String(body.booking_id??''),reason:String(body.reason??'').slice(0,300),...key},vctx,db);
      if(!env.ok)return J({error:env.error.message},409);
      if(!env.meta?.replayed){
        await say('bot',`Your ${env.data.service} on ${nice(env.data.when)} is cancelled. You're welcome to book again anytime.`);
        await svc.from('alerts').insert({org_id:orgId,convo:cid,customer:convo.customer,reason:'other',text:`Patient cancelled ${env.data.service} on ${env.data.when}`.slice(0,160)});
      }
      return J({ok:true});
    }
    const env=await executeTool(registry,'reschedule_my_appointment',{booking_id:String(body.booking_id??''),when:String(body.when??''),...key},vctx,db);
    if(!env.ok)return J({error:env.error.message,alternatives:env.error.alternatives??[]},409);
    if(!env.meta?.replayed)await say('bot',env.data.status==='booked'
      ?`Done: your appointment is now ${nice(env.data.when)} with ${env.data.doctor}.`
      :`Your request to move to ${nice(env.data.when)} with ${env.data.doctor} is with our team. We'll confirm here shortly.`);
    return J({ok:true,status:env.data.status});
  }

  // 3. Open times for the booking picker. No model call: the same tool the assistant uses, through the executor.
  // 3d. The person tapped "Cancel appointment" on Solara's confirmation card.
  if(body.action==='confirm_cancel'){
    if(convo.status==='closed')return J({error:'This conversation has ended.'},409);
    const key=typeof body.key==='string'&&body.key.length>=8?{idempotency_key:body.key.slice(0,128)}:{};
    const env=await executeTool(registry,'cancel_chat_appointment',{booking_id:String(body.booking_id??''),reason:String(body.reason??'').slice(0,300),...key},ctx({}),db);
    if(!env.ok)return J({error:env.error.message},409);
    if(!env.meta?.replayed){
      await say('cust','Yes, cancel it.');
      await say('bot',`Done: your ${env.data.service} on ${nice(env.data.when)} is cancelled. You're welcome to book again anytime.`);
      await svc.from('alerts').insert({org_id:orgId,convo:cid,customer:convo.customer,reason:'other',text:`Patient cancelled ${env.data.service} on ${env.data.when}`.slice(0,160)});
    }
    return J({ok:true});
  }
  if(body.action==='slots'){
    const env=await executeTool(registry,'check_availability',{date:String(body.date??''),...(body.service?{service:String(body.service).slice(0,80)}:{})},ctx({}),db);
    return env.ok?J({date:env.data.date,slots:env.data.slots,note:env.data.note??null}):J({error:env.error.message},400);
  }

  // 4. A booking request submitted from the picker. Also no model call.
  if(body.action==='book'){
    if(await recent())return J({error:'Please wait a moment before trying again.'},429);
    const f=body.booking??{};
    const args={name:String(f.name??''),phone:String(f.phone??''),service:String(f.service??''),when:String(f.when??''),
      ...(typeof f.key==='string'&&f.key.length>=8?{idempotency_key:f.key.slice(0,128)}:{})};
    const env=await executeTool(registry,'request_appointment',args,ctx({}),db);
    if(!env.ok)return J({error:env.error.message,field:env.error.field??null,alternatives:env.error.alternatives??[]},409);
    const r=env.data;
    // The inbox shows who this is from now on, not "Website visitor".
    await svc.from('conversations').update({customer:`${args.name.trim()} · ${r.phone??args.phone}`.slice(0,120)}).eq('id',cid);
    if(!env.meta?.replayed){
      await say('cust',`Requested ${args.service} on ${nice(r.when)}.`);
      await say('bot',r.status==='booked'
        ?`You're booked: ${args.service} with ${r.doctor} on ${nice(r.when)}. See you then!`
        :`Thanks, ${args.name.split(' ')[0]}! Your request for ${args.service} with ${r.doctor} on ${nice(r.when)} is with our team. We'll confirm here shortly.`);
    }
    return J({ok:true,status:r.status,doctor:r.doctor,when:r.when});
  }

  // 5. A visitor message.
  const text=String(body.text??'').trim().slice(0,1000);
  if(!text)return J({error:'Please type a message first.'},400);
  if(await recent())return J({error:'Please wait a moment before sending another message.'},429);
  // An ended chat takes no more messages; the visitor can start a new one.
  if(convo.status==='closed')return J({closed:true,status:'closed',error:'This conversation has ended. Start a new chat to continue.'},409);
  await say('cust',text);

  // Safety check first. Emergencies never depend on the model.
  const t=triage([{role:'user',content:text}]);
  // With the team already, the message is kept but not answered automatically.
  if(!t&&convo.status==='handoff')return J({reply:null,handoff:true,status:'handoff'});

  const out:any={handoff:false,reason:null,form:null,booked:false,requested:false,confirm:null};
  let reply:string,urgent=null;const t0=Date.now(),attempts:any[]=[];
  if(t){reply=t.reply;out.handoff=true;out.reason=t.reason;urgent=t.urgent??null}
  else{
    const pv:any=await orgProvider(svc,orgId);
    const {data:hist}=await svc.from('messages').select('role,body').eq('org_id',orgId).eq('conversation_id',cid).order('created_at',{ascending:false}).limit(30);
    const messages=buildMessages((hist??[]).reverse());
    if(pv.error){logEvent('widget-chat',{org:orgId,action:'message',outcome:'provider_unavailable',error:pv.error});reply=FALLBACK;out.handoff=true;out.reason='error'}
    else{
      const [st,org]=await Promise.all([svc.from('settings').select('tone,greeting').eq('org_id',orgId).maybeSingle(),svc.from('organizations').select('name').eq('id',orgId).single()]);
      try{
        const res:any=await withTimeout(runToolLoop({
          callModel:(m:any,tools:any)=>callModelRaw({...pv.provider,maxTokens:1200,reasoningEffort:'none',onAttempt:(a:any)=>attempts.push(a)},m,tools),
          registry,db,role:'public',surface:'public',ctx:ctx(out),
          system:publicSystem({org:org.data?.name??'this clinic',tone:st.data?.tone??'friendly',greeting:st.data?.greeting??'',timeZone}),messages,checkClaim:checkAppointmentClaim}),40000);
        reply=res.reply;
        logEvent('widget-chat',{org:orgId,action:'message',outcome:res.stopped??'ok',rechecked:!!res.rechecked,ms:Date.now()-t0,tools:res.calls.map((c:any)=>c.ok?c.name:c.name+':'+c.code),attempts});
      }catch(e){logEvent('widget-chat',{org:orgId,action:'message',outcome:'model_failed',ms:Date.now()-t0,attempts,error:String(e).slice(0,200)});reply=FALLBACK;out.handoff=true;out.reason='error'}
    }
    // A health_risk label must be backed by the visitor's own words.
    if(out.reason==='health_risk'&&!hasHealthSignal(text))out.reason='other';
    // A booking request always gets the booking picker, unless this is a health concern for the team.
    if(!(out.handoff&&out.reason==='health_risk')&&!out.form&&!out.booked&&!out.requested&&wantsBooking(messages)){
      const {data:sv}=await svc.from('services').select('name').eq('org_id',orgId).order('created_at');
      out.form=bookingForm((sv??[]).map((x:any)=>x.name));
    }
    // Changing or cancelling opens the verified self-service panel.
    if(!out.handoff&&wantsManage(messages))out.manage=true;
  }

  await say('bot',reply);
  if(out.handoff){
    // A temporary AI failure alerts the team but does not silence the chat: the next message gets a real answer again.
    // Once with the team, Solara does not answer in this chat again (an AI failure included).
    await svc.from('conversations').update({status:'handoff'}).eq('id',cid);
    const reason=REASONS.includes(out.reason)?out.reason:'other';
    await svc.from('alerts').insert({org_id:orgId,convo:cid,customer:convo.customer,reason,text:text.slice(0,160)});
  }
  return J({reply,handoff:out.handoff,status:out.handoff?'handoff':'handled',form:out.form?cleanForm(out.form):null,manage:!!out.manage&&smsReady(),urgent,
    confirm:!out.handoff&&out.confirm?out.confirm:null});
});
