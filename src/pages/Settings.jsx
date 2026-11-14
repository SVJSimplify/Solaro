import {useState,useEffect} from 'react';
const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
import {db} from '../lib/db';import {useAuth,useTable,useToast} from '../lib/hooks';import {normalizePhone} from '../lib/phone';import {Field,PhoneField,problem,phoneProblem} from '../lib/fields';

export default function Settings(){
  const {user:me}=useAuth(),canManage=['owner','admin'].includes(me.role);
  const {user}=useAuth(),toast=useToast(),[s,setS]=useState({greeting:'',tone:'friendly',handoff:''}),[err,setErr]=useState('');
  const [hrs,setHrs]=useState({days:[1,2,3,4,5],start:'08:00',end:'17:00'}),[hErr,setHErr]=useState('');
  useEffect(()=>{const load=()=>db.settings(user.id).then(v=>{setS(o=>({...o,...v}));if(v.hours)setHrs(v.hours)}).catch(x=>setErr(x.message));load();
    const on=e=>{if(e?.detail?.table==='settings')load()};addEventListener('solara',on);return()=>removeEventListener('solara',on)},[user.id]);
  const saveHrs=async e=>{e.preventDefault();setHErr('');
    if(!hrs.days.length)return setHErr('Pick at least one open day.');if(!(hrs.start<hrs.end))return setHErr('Closing time must be after opening time.');
    try{await db.saveHours(user.id,{...hrs,days:[...hrs.days].sort()});toast('Hours saved. Doctors, open times and the website chat are updated.')}catch(x){setHErr(x.message)}};
  const set=k=>e=>setS({...s,[k]:e.target.value}),put=k=>v=>setS({...s,[k]:v});
  const [svc]=useTable('services'),[nm,setNm]=useState('');
  const addSvc=async e=>{e.preventDefault();const n=nm.trim();if(problem('service',n))return toast(problem('service',n,{label:'Service name'}));if(svc.some(x=>x.name.toLowerCase()===n.toLowerCase()))return toast('That service is already on the list.');await db.add('services',user.id,{name:n});setNm('')};
  const save=async e=>{
    e.preventDefault();setErr('');
    const h=String(s.handoff||'').trim(),wrong=problem('line',s.greeting,{label:'Greeting'})||phoneProblem(h,{required:false,label:'Hand-off number'});
    if(wrong)return setErr(wrong);
    try{await db.saveSettings(user.id,{...s,handoff:h?normalizePhone(h):''});toast('Saved')}catch(x){setErr(x.message)}
  };
  return(<>
    <header><h1>Settings</h1></header>
    {!canManage&&<p className="route">Only owners and admins can change these settings.</p>}
    <form className="card st" style={{maxWidth:520}} onSubmit={save}>
      <Field id="g" label="Greeting" kind="line" value={s.greeting} onChange={put('greeting')} disabled={!canManage} count hint="The first thing patients read in the chat."/>
      <div className="f"><label htmlFor="tn">Tone</label><select id="tn" value={s.tone} onChange={set('tone')} disabled={!canManage}>{['friendly','formal','casual'].map(o=><option key={o}>{o}</option>)}</select></div>
      <PhoneField id="h" label="Hand-off phone number" value={s.handoff} onChange={put('handoff')} tz={me.tz} required={false} disabled={!canManage} autoComplete="tel" hint="Patients are given this number when Solara hands a chat to your team."/>
      <div className="f"><label><input type="checkbox" checked={!!s.autoConfirm} onChange={e=>setS({...s,autoConfirm:e.target.checked})} disabled={!canManage}/> Confirm website bookings automatically</label>
        <small className="route">Off: website bookings arrive as requests on the Bookings page and the patient is told once your team confirms. On: open times are booked straight away.</small></div>
      <p className="err" role="alert">{err}</p>
      {canManage&&<button className="btn">Save settings</button>}
    </form>
    <form className="card st" style={{maxWidth:520,marginTop:16}} onSubmit={saveHrs}>
      <h3>Clinic hours</h3>
      <p className="route">Every doctor works inside these hours. Change them and each doctor's hours, the open times patients see and Solara's answers update straight away.</p>
      <div className="inst-tabs" role="group" aria-label="Open days">{DAYS.map((n,i)=><button key={n} type="button" disabled={!canManage} aria-pressed={hrs.days.includes(i)} className={'inst-tab'+(hrs.days.includes(i)?' on':'')}
        onClick={()=>setHrs(h=>({...h,days:h.days.includes(i)?h.days.filter(x=>x!==i):[...h.days,i]}))}>{n}</button>)}</div>
      <div className="inst-row">
        <div className="f"><label htmlFor="ho">Opens</label><input id="ho" type="time" step={1800} value={hrs.start} disabled={!canManage} onChange={e=>setHrs(h=>({...h,start:e.target.value}))}/></div>
        <div className="f"><label htmlFor="hc">Closes</label><input id="hc" type="time" step={1800} value={hrs.end} disabled={!canManage} onChange={e=>setHrs(h=>({...h,end:e.target.value}))}/></div>
      </div>
      <p className="err" role="alert">{hErr}</p>
      {canManage&&<button className="btn">Save hours</button>}
    </form>
    <section className="card st" style={{maxWidth:520,marginTop:16}}>
      <h3>Services</h3>
      <p className="route">Customers pick from this list in booking forms. Change it anytime.</p>
      {svc.map(x=><div key={x.id} className="closed-row"><span>{x.name}</span>{canManage&&<button type="button" className="btn ghost sm" onClick={()=>db.del('services',x.id)}>Remove</button>}</div>)}
      {canManage&&<form className="acts" onSubmit={addSvc} style={{marginTop:10}}>
        <input value={nm} onChange={e=>setNm(e.target.value.replace(/[^\p{L}\p{N} &/+.,'’()-]/gu,'').replace(/^\s+/,''))} maxLength={60} placeholder="New service" aria-label="New service"/>
        <button className="btn sm">Add</button>
      </form>}
    </section>
    {canManage&&<section className="card st" style={{maxWidth:520,marginTop:16}}>
      <h3>Website chat</h3>
      <p className="route">Customise the chat button, copy your code and check it's live on your site.</p>
      <a className="btn sm" href="/install">Set up website chat</a>
    </section>}
  </>);
}
