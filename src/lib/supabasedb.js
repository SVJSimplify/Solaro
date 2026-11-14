import {createClient} from '@supabase/supabase-js';
import {respondWith} from './respond';
import {DEFAULT_DOCTORS,DEFAULT_SERVICES,withClinic} from './schedule';
const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_ANON_KEY;
const sb=url?createClient(url,key):null;
const TABLE={convos:'conversations',kb:'kb',services:'services',doctors:'doctors',bookings:'bookings',closures:'closures',alerts:'alerts',audit:'audit',outbox:'outbox'};
let org=null,chans=[],clinics=1;
/* Change notifications. Realtime events say which table changed; screens reload only that table, and bursts (a chat
   writing several rows at once) are coalesced into one reload per table. */
const APP_TABLE={conversations:'convos',messages:'convos',audit_events:'audit',schedule_exceptions:'leave'};
const pending=new Set();let timer=null;
const ping=(table)=>{
  pending.add(table?APP_TABLE[table]??table:'*');
  if(table==='settings')pending.add('doctors');   // doctors carry the clinic hours
  if(timer)return;
  timer=setTimeout(()=>{const tables=[...pending];pending.clear();timer=null;
    for(const t of tables)dispatchEvent(new CustomEvent('solara',{detail:{table:t==='*'?null:t}}))},250);
};
const must=r=>{if(r.error)throw Error(r.error.message);return r.data};
const ms=t=>t?new Date(t).getTime():0;
const hm=t=>String(t||'').slice(0,5);

/* App field names <-> table columns, one pair per table. */
const TO={
  kb:r=>({title:r.title,body:r.body,keywords:r.keywords,starter:!!r.starter}),
  services:r=>({name:r.name}),
  doctors:r=>({name:r.name,specialty:r.specialty||'',services:r.services||[],days:r.days||[],start_time:r.start,end_time:r.end,slot:r.slot||30}),
  bookings:r=>({name:r.name,phone:r.phone,service:r.service||'',starts_at:r.when,doctor_id:r.doctor_id||null,doctor:r.doctor||'',status:r.status||'booked',reminded:!!r.reminded}),
  closures:r=>({date:r.date}),
  alerts:r=>({convo:r.convo,customer:r.customer||'',reason:r.reason||'other',text:r.text||'',read:!!r.read}),
  audit:r=>({action:r.action,detail:r.detail||''}),
  outbox:r=>({channel:r.channel,to_addr:r.to||'',body:r.body||''}),   // always starts queued; only the server marks it sent
};
const FROM={
  kb:r=>({id:r.id,title:r.title,body:r.body,keywords:r.keywords,starter:r.starter,managed:!!r.managed,created:ms(r.created_at)}),
  services:r=>({id:r.id,name:r.name,created:ms(r.created_at)}),
  doctors:r=>({id:r.id,name:r.name,specialty:r.specialty,services:r.services,days:r.days,start:hm(r.start_time),end:hm(r.end_time),slot:r.slot,created:ms(r.created_at)}),
  bookings:r=>({id:r.id,name:r.name,phone:r.phone,service:r.service,when:r.starts_at.slice(0,16),doctor_id:r.doctor_id,doctor:r.doctor,status:r.status,reminded:r.reminded,duration:r.duration_min??30,source:r.source,conversation_id:r.conversation_id,requested_at:r.requested_at,decided_at:r.decided_at,cancelReason:r.cancel_reason||'',created:ms(r.created_at)}),
  closures:r=>({id:r.id,date:r.date,created:ms(r.created_at)}),
  alerts:r=>({id:r.id,convo:r.convo,customer:r.customer,reason:r.reason,text:r.text,read:r.read,created:ms(r.created_at)}),
  audit:r=>({id:r.id,action:r.action,detail:r.detail,at:ms(r.created_at)}),
  outbox:r=>({id:r.id,channel:r.channel,to:r.to_addr,body:r.body,status:r.status,kind:r.kind,booking_id:r.booking_id,error:r.last_error||'',attempts:r.attempts||0,sent:ms(r.sent_at),at:ms(r.created_at)}),
};
const LIMIT={convos:200,alerts:2000,audit:5000,outbox:2000};
const COL={when:'starts_at',start:'start_time',end:'end_time',to:'to_addr'};
const patchOf=p=>Object.fromEntries(Object.entries(p).filter(([k])=>k!=='id').map(([k,v])=>[COL[k]||k,v]));

/* Resolve the user's clinic (created on first login), seed defaults once, stream live changes into the UI.
   Someone who belongs to several clinics chooses one; nothing is picked for them. The choice is remembered on this device. */
const ORG_KEY='solara.org';
const saved=()=>{try{return localStorage.getItem(ORG_KEY)}catch{return null}};
/* One realtime channel for the clinic. Changes arrive as table pings. If the connection drops, anything missed while it was
   down is caught up by reloading every screen once it is back, and again when the tab returns to the foreground. */
let wasDown=false,lastWake=0;
function live(tables){
  let ch=sb.channel('rt-'+org);
  for(const t of tables)ch=ch.on('postgres_changes',{event:'*',schema:'public',table:t,filter:'org_id=eq.'+org},()=>ping(t));
  return ch.subscribe(st=>{
    if(st==='SUBSCRIBED'){if(wasDown)ping();wasDown=false}
    else if(st==='CHANNEL_ERROR'||st==='TIMED_OUT'||st==='CLOSED')wasDown=true;
  });
}
if(typeof window!=='undefined'){
  const wake=()=>{if(!org||document.visibilityState==='hidden'||Date.now()-lastWake<15000)return;lastWake=Date.now();ping()};
  addEventListener('visibilitychange',wake);addEventListener('focus',wake);addEventListener('online',()=>{lastWake=0;wake()});
}
async function enter(user){
  const biz=user.user_metadata?.biz||'My business';
  let m=must(await sb.from('members').select('org_id, role, organizations(name,timezone)').eq('user_id',user.id).order('created_at'));
  if(!m.length){const id=must(await sb.rpc('create_org',{org_name:biz}));m=[{org_id:id,role:'owner',organizations:{name:biz,timezone:null}}]}
  const orgs=m.map(x=>({id:x.org_id,name:x.organizations?.name||'Clinic',role:x.role}));
  const me=m.find(x=>x.org_id===saved())||(m.length===1?m[0]:null);
  const base={id:user.id,email:user.email,orgs};clinics=orgs.length;
  chans.forEach(c=>sb.removeChannel(c));chans=[];
  if(!me){org=null;return{...base,needsOrg:true}}
  org=me.org_id;
  await seed();
  const tables=['conversations','messages','bookings','kb','doctors','closures','alerts','services','audit_events','outbox','schedule_exceptions','settings'];
  chans=[live(tables)];
  const {data:pa}=await sb.rpc('is_platform_admin');
  return{...base,biz:me.organizations.name,org,tz:me.organizations.timezone||null,role:me.role,platformAdmin:!!pa};
}
async function seed(){
  const empty=async t=>!(await sb.from(TABLE[t]).select('id',{count:'exact',head:true}).eq('org_id',org)).count;
  if(await empty('services'))must(await sb.from('services').insert(DEFAULT_SERVICES.map(name=>({org_id:org,name}))));
  if(await empty('doctors'))must(await sb.from('doctors').insert(DEFAULT_DOCTORS.map(d=>({org_id:org,...TO.doctors(d)}))));
}

export const remote={
  async signUp(email,password,biz){
    const r=must(await sb.auth.signUp({email,password,options:{data:{biz}}}));
    if(!r.session)throw Error('Check your email to confirm your account, then sign in.');
    return enter(r.user);
  },
  async signIn(email,password){return enter(must(await sb.auth.signInWithPassword({email,password})).user)},
  async session(){const {data}=await sb.auth.getSession();return data.session?enter(data.session.user):null},
  async chooseOrg(id){try{localStorage.setItem(ORG_KEY,id)}catch{}return this.session()},
  /* Password recovery. The link in the email comes back to whatever address the app is served from, so a new domain needs no code change
     (add it to Supabase Auth's allowed redirect URLs). */
  async resetPassword(email){must(await sb.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin}))},
  async updatePassword(password){must(await sb.auth.updateUser({password}))},
  onRecovery(cb){sb.auth.onAuthStateChange(e=>{if(e==='PASSWORD_RECOVERY')cb()})},
  async signOut(){await sb.auth.signOut();chans.forEach(c=>sb.removeChannel(c));chans=[];org=null},

  /* RLS scopes every query to the caller's organization, so the uid argument is unused here. */
  /* Every list is bounded, so a clinic with years of history loads the same amount as a new one:
     the latest 200 chats (with their messages), bookings from 180 days ago onward, the latest alerts, activity and outbox.
     Small configuration tables (doctors, services, knowledge, closures) load in full. */
  async list(t){
    if(t==='convos'){
      const d=must(await sb.from('conversations').select('*, messages(id,role,body,meta,created_at)').eq('org_id',org).order('created_at',{ascending:false}).limit(LIMIT.convos));
      return d.map(c=>({id:c.id,customer:c.customer,channel:c.channel,status:c.status,alerted:c.alerted,created:ms(c.created_at),
        messages:[...c.messages].sort((a,b)=>ms(a.created_at)-ms(b.created_at)).map(m=>({id:m.id,r:m.role,t:m.body,at:ms(m.created_at),meta:m.meta||undefined}))}));
    }
    if(t==='leave'){
      // Confirmed time away and closures from yesterday onward. Tentative entries are not loaded: they never change availability.
      const d=must(await sb.from('schedule_exceptions').select('id,on_date,kind,start_min,end_min,note,business_entities(legacy_doctor_id,name)').eq('org_id',org)
        .eq('status','confirmed').in('kind',['leave','unavailable','closure']).gte('on_date',new Date(Date.now()-2*864e5).toISOString().slice(0,10)).order('on_date').limit(1000));
      return d.map(e=>({id:e.id,date:String(e.on_date).slice(0,10),kind:e.kind,start:e.start_min,end:e.end_min,note:e.note||'',doctor_id:e.business_entities?.legacy_doctor_id??null,who:e.business_entities?.name||''}))
        .filter(e=>e.kind==='closure'||e.doctor_id);
    }
    if(t==='doctors'){
      // Doctors carry the clinic's weekly hours, so every slot shown is inside both (the database enforces the same).
      const [d,h]=await Promise.all([sb.from('doctors').select('*').eq('org_id',org).order('created_at'),sb.from('settings').select('hours').eq('org_id',org).maybeSingle()]);
      return withClinic(must(d).map(FROM.doctors),must(h)?.hours??null);
    }
    let q=sb.from(TABLE[t]).select('*').eq('org_id',org);
    if(t==='bookings')q=q.gte('starts_at',new Date(Date.now()-180*864e5).toISOString().slice(0,10));
    if(LIMIT[t])q=q.order('created_at',{ascending:false}).limit(LIMIT[t]);
    const d=must(await q.order('created_at'));
    return (LIMIT[t]?[...d].reverse():d).map(FROM[t]);
  },
  async add(t,_u,row){
    if(t==='convos'){
      const c=must(await sb.from('conversations').insert({org_id:org,customer:row.customer,channel:row.channel,status:row.status}).select().single());
      if(row.messages?.length)must(await sb.from('messages').insert(row.messages.map(m=>({org_id:org,conversation_id:c.id,role:m.r,body:m.t,meta:m.meta??null}))));
      ping();return{id:c.id};
    }
    if(t==='audit'){must(await sb.rpc('log_audit',{p_org:org,p_action:row.action,p_text:row.detail||''}));ping();return{}}   // one audit trail: audit_events
    const out=must(await sb.from(TABLE[t]).insert({org_id:org,...TO[t](row)}).select().single());
    ping();return FROM[t](out);
  },
  /* The UI sends the full message list; only the new tail is inserted. */
  async patch(t,id,p){
    if(t==='convos'){
      // Only messages without an id are new. The old "count rows, insert the rest" dropped a staff reply whenever a
      // patient message arrived between loading the chat and sending.
      if(p.messages){
        const fresh=p.messages.filter(m=>!m.id);
        if(fresh.length)must(await sb.from('messages').insert(fresh.map(m=>({org_id:org,conversation_id:id,role:m.r,body:m.t,meta:m.meta??null}))));
      }
      const u={};if(p.status)u.status=p.status;if('alerted' in p)u.alerted=p.alerted;
      if(Object.keys(u).length)must(await sb.from('conversations').update(u).eq('id',id));
    }else must(await sb.from(TABLE[t]).update(patchOf(p)).eq('id',id));
    ping();
  },
  /* Conditional update: changes the row only if it still matches `when`. Returns true for the one caller that won,
     so two staff members (or two open tabs) can never both confirm a request or both send a reminder. */
  async claim(t,id,when,set){
    let q=sb.from(TABLE[t]).update(patchOf(set)).eq('id',id);
    for(const [k,v] of Object.entries(when))q=q.eq(COL[k]||k,v);
    const r=must(await q.select('id'));ping(TABLE[t]);return r.length>0;
  },
  async del(t,id){
    if(t==='doctors')throw Error('Doctors are removed only through a confirmation card.');
    must(await sb.from(TABLE[t]).delete().eq('id',id));ping();
  },
  /* Doctor removal: the server issues a 5-minute, single-use token bound to this user, clinic and doctor; Confirm redeems it. */
  async requestDoctorDeletion(id){return must(await sb.rpc('request_doctor_deletion',{p_org:org,p_doctor:id}))},
  async confirmDoctorDeletion(token){const r=must(await sb.rpc('confirm_doctor_deletion',{p_org:org,p_token:token}));ping();return r},
  /* One transaction on the server: keeps existing records, skips duplicates unless replace is true, never deletes. */
  async importSetup(_u,p,replace=false){
    const r=must(await sb.rpc('import_setup',{p_org:org,p_doctors:p.doctors.map(d=>({name:d.name,specialty:d.specialty||'',services:d.services||[],days:d.days||[],start:d.start,end:d.end,slot:d.slot||30})),
      p_answers:p.answers.map(a=>({title:a.title,body:a.body,keywords:a.keywords||''})),p_replace:!!replace}));
    ping();return r;
  },
  /* A team message into one chat. The website chat shows it to the visitor on its next poll. */
  async postMessage(convoId,text){must(await sb.from('messages').insert({org_id:org,conversation_id:convoId,role:'staff',body:text}));ping()},
  // Sites where this clinic's website chat has loaded (null if install tracking isn't set up on the server yet).
  async widgetKey(){return must(await sb.rpc('widget_key_get',{p_org:org}))},
  async widgetKeyRotate(){const k=must(await sb.rpc('widget_key_rotate',{p_org:org}));return k},
  async widgetInstalls(){const r=await sb.from('widget_installs').select('origin,first_seen,last_seen').eq('org_id',org).order('last_seen',{ascending:false});return r.error?null:r.data},
  async settings(){const d=must(await sb.from('settings').select('*').eq('org_id',org).maybeSingle());return d?{greeting:d.greeting,tone:d.tone,handoff:d.handoff_phone,autoConfirm:!!d.auto_confirm_web}:{}},
  /* Clinic hours. The database keeps every doctor inside them and updates doctors when they change. */
  /* Clinic hours by weekday: {"0".."6":{start,end}}; a missing day is closed. Edited in Knowledge; the database keeps the Hours answer in step. */
  async clinicHours(){return must(await sb.from('settings').select('hours').eq('org_id',org).maybeSingle())?.hours??{}},
  async saveClinicHours(_u,h){const r=must(await sb.rpc('set_clinic_hours',{p_org:org,p_hours:h}));ping('settings');ping('kb');ping('audit');return r},
  /* Logs: kind activity|messages|handoffs; ids, or a period [from,to). Returns how many were removed. */
  async deleteLogs(_u,kind,{ids,from,to}={}){const n=must(await sb.rpc('delete_logs',{p_org:org,p_kind:kind,p_ids:ids??null,p_from:from??null,p_to:to??null}));ping('audit');ping('outbox');ping('alerts');return n},
  async removeInstall(_u,origin){must(await sb.from('widget_installs').delete().eq('org_id',org).eq('origin',origin))},
  async saveSettings(_u,v){must(await sb.from('settings').upsert({org_id:org,greeting:v.greeting,tone:v.tone,handoff_phone:v.handoff,...('autoConfirm' in v?{auto_confirm_web:!!v.autoConfirm}:{})}));ping()},
  /* Appointment actions. Each is one transaction on the server: the change, the audit record and the patient's message. */
  async bookingCreate(_u,r){const x=must(await sb.rpc('booking_create',{p_org:org,p_name:r.name,p_phone:r.phone,p_service:r.service||'',p_when:r.when,p_doctor:r.doctor_id}));ping('bookings');return x},
  async bookingDecide(_u,id,ok){const x=must(await sb.rpc('booking_decide',{p_id:id,p_confirm:!!ok}));ping('bookings');return x},
  async bookingReschedule(_u,id,when,doctorId){const x=must(await sb.rpc('booking_reschedule',{p_id:id,p_when:when,p_doctor:doctorId||null}));ping('bookings');return x},
  async bookingCancel(_u,id){const x=must(await sb.rpc('booking_cancel',{p_id:id}));ping('bookings');return x},
  async bookingStatus(_u,id,status){const x=must(await sb.rpc('booking_set_status',{p_id:id,p_status:status}));ping('bookings');return x},
  /* Counted in the database over the whole period, in the clinic's time zone. */
  async insights(_u,days){return must(await sb.rpc('insights_summary',{p_org:org,p_days:days}))},
  /* Runs in this browser with the local LLM provider; storage goes to Supabase. */
  async closeConversation(id,close){must(await sb.rpc('conversation_close',{p_id:id,p_close:!!close}));ping('conversations')},
  async respond(id,_text,uid){await respondWith(remote,id,uid)}
};

export const multiClinic=()=>clinics>1;

/* The signed-in Supabase client. The central tool executor uses it so row-level security applies to every tool call. */
export const client=()=>sb;

/* Short-lived session token, sent to the server with each AI request. */
export async function accessToken(){const {data}=await sb.auth.getSession();return data.session?.access_token??null}

/* Platform admin actions (only work for platform admins; the database checks each one). Null in the local demo. */
export const adminApi=sb?{
  async clinics(){return must(await sb.rpc('admin_list_orgs'))},
  async plans(){return must(await sb.from('plans').select('name,label,daily_ai_limit').order('daily_ai_limit'))},
  async setClinic(org,plan,override,model,widget){must(await sb.rpc('admin_set_org_ai',{org,p_plan:plan,p_override:override,p_model:model,p_widget:widget}))},
  async setKey(org,key){must(await sb.rpc('admin_set_model_key',{org,p_key:key}))}
}:null;
