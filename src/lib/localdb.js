import {respondWith} from './respond';
import {DEFAULT_DOCTORS,DEFAULT_SERVICES,assignDoctor} from './schedule';
/* ============ DATA LAYER — swap this object for Supabase later ============
   Every method is async and returns plain objects, so each maps 1:1 to a
   supabase-js call (noted per method). Nothing outside `db` touches storage. */
export const local=(()=>{
  const pending=new Map();
  const K='solara.v1',L=()=>{try{return JSON.parse(localStorage.getItem(K))||{}}catch(e){return{}}},S=s=>{try{localStorage.setItem(K,JSON.stringify(s))}catch(e){}dispatchEvent(new Event('solara'))},id=()=>crypto.randomUUID();
  const st=()=>{const s=L();s.users??=[];s.convos??=[];s.bookings??=[];s.alerts??=[];s.doctors??=[];s.services??=[];s.audit??=[];s.outbox??=[];s.closures??=[];s.kb??=[];s.settings??={};return s};
  const seed=(s,uid)=>{s.kb.push(...[
   ['Hours','Mon–Fri 8am–6pm, Saturday 9am–2pm. Closed Sunday.','hours open close when'],
   ['Insurance','We accept Cigna, Aetna, Delta Dental and most major plans. Share your member ID and we will verify coverage.','insurance cigna aetna cover plan'],
   ['Pricing','A routine cleaning is $120 without insurance. Exams and X-rays are quoted at your visit.','price cost how much fee']
  ].map(([title,body,keywords])=>({id:id(),owner:uid,title,body,keywords})));
   s.settings[uid]={tone:'friendly',handoff:'+91 90000 00000',greeting:'Hi! How can I help you today?'};
   s.convos.push({id:id(),owner:uid,customer:'Priya S.',channel:'Web chat',status:'handoff',unread:1,created:Date.now()-36e5,messages:[{r:'cust',t:'I have a tooth emergency, a swollen jaw since last night',at:Date.now()-36e5},{r:'bot',t:'I’m sorry you’re in pain. I’ve flagged this for our team and they will call you shortly.',at:Date.now()-36e5+4e3}]})};
  return{
   /* supabase.auth.signUp / signInWithPassword */
   async signUp(email,pw,biz){const s=st();if(s.users.find(u=>u.email===email))throw Error('That email already has an account.');const u={id:id(),email,pw:btoa(pw),biz};s.users.push(u);seed(s,u.id);S(s);s.session=u.id;S(s);return{id:u.id,email,biz,role:'owner'}},
   async signIn(email,pw){const s=st(),u=s.users.find(u=>u.email===email&&u.pw===btoa(pw));if(!u)throw Error('Wrong email or password.');s.session=u.id;S(s);return{id:u.id,email,biz:u.biz,role:'owner'}},
   async session(){const s=st(),u=s.users.find(u=>u.id===s.session);return u?{id:u.id,email:u.email,biz:u.biz,role:'owner'}:null},
   async signOut(){const s=st();delete s.session;S(s)},
   /* supabase.from(t).select().eq('owner',uid) */
   async list(t,uid){
    if(t==='doctors'&&!st().doctors.some(d=>d.owner===uid)){const s=st();s.doctors.push(...DEFAULT_DOCTORS.map(d=>({...d,id:id(),owner:uid})));S(s)}
    if(t==='services'&&!st().services.some(x=>x.owner===uid)){const s=st();s.services.push(...DEFAULT_SERVICES.map(n=>({id:id(),owner:uid,name:n})));S(s)}
    return st()[t].filter(x=>x.owner===uid)},
   /* supabase.from(t).insert(row) */
   async add(t,uid,row){const s=st(),r={id:id(),owner:uid,created:Date.now(),...row};s[t].push(r);S(s);return r},
   /* supabase.from(t).update(patch).eq('id',id) */
   async patch(t,i,p){const s=st(),r=s[t].find(x=>x.id===i);Object.assign(r,p);S(s);return r},
   /* supabase.from(t).delete().eq('id',id) */
   async del(t,i){if(t==='doctors')throw Error('Doctors are removed only through a confirmation card.');const s=st();s[t]=s[t].filter(x=>x.id!==i);S(s)},
   /* Demo-mode equivalents of the server functions. One write at the end, so a failed import changes nothing. */
   async importSetup(uid,p,replace=false){
    const s=st(),r={doctors_added:0,doctors_updated:0,doctors_skipped:0,answers_added:0,answers_updated:0,answers_skipped:0};
    const key=v=>String(v||'').trim().toLowerCase();
    for(const d of p.doctors){if(!key(d.name))throw Error('Every doctor needs a name');const hit=s.doctors.find(x=>x.owner===uid&&key(x.name)===key(d.name));
     if(!hit){s.doctors.push({...d,name:d.name.trim(),id:id(),owner:uid,created:Date.now()});r.doctors_added++}else if(replace){Object.assign(hit,{...d,name:hit.name});r.doctors_updated++}else r.doctors_skipped++}
    for(const a of p.answers){if(!key(a.title)||!String(a.body||'').trim())throw Error('Every answer needs a topic and text');const hit=s.kb.find(x=>x.owner===uid&&key(x.title)===key(a.title));
     if(!hit){s.kb.push({...a,id:id(),owner:uid,created:Date.now()});r.answers_added++}else if(replace){Object.assign(hit,{body:a.body,keywords:a.keywords,starter:false});r.answers_updated++}else r.answers_skipped++}
    S(s);return r;
   },
   async requestDoctorDeletion(i){const s=st(),d=s.doctors.find(x=>x.id===i);if(!d)throw Error('Doctor not found');const token=id();pending.set(token,{id:i,exp:Date.now()+3e5});
    return{token,doctor_id:i,doctor:d.name,specialty:d.specialty||'',upcoming_bookings:s.bookings.filter(b=>b.doctor_id===i&&b.status!=='cancelled'&&new Date(b.when)>=new Date()).length,expires_in:300}},
   async confirmDoctorDeletion(token){const p=pending.get(token);pending.delete(token);if(!p||p.exp<Date.now())throw Error('This confirmation is invalid, expired or already used');
    const s=st(),d=s.doctors.find(x=>x.id===p.id);if(!d)throw Error('That doctor no longer exists');s.doctors=s.doctors.filter(x=>x.id!==p.id);S(s);return{removed:d.name}},
   async postMessage(cid,text){const s=st(),c=s.convos.find(x=>x.id===cid);if(c){c.messages.push({r:'staff',t:text,at:Date.now()});S(s)}},
   async settings(uid){return st().settings[uid]||{}},
   async saveSettings(uid,v){const s=st();s.settings[uid]={...s.settings[uid],...v};S(s)}
  }})();


/* Same call the Supabase adapter makes, so pages never care which backend is active. */
local.respond=(id,text,uid)=>respondWith(local,id,uid);
