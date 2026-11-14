import {useEffect,useState,useRef} from 'react';
import {db} from './db';
import {useAuth,useToast} from './hooks';

/* Clinic opening hours, one row per weekday. This is the only place hours are edited: the database writes the
   "Hours" answer from them, every doctor's open times stay inside them, and bookings outside them are refused. */
const DAYS=[[1,'Monday'],[2,'Tuesday'],[3,'Wednesday'],[4,'Thursday'],[5,'Friday'],[6,'Saturday'],[0,'Sunday']];
const TIMES=Array.from({length:48},(_,i)=>`${String(Math.floor(i/2)).padStart(2,'0')}:${i%2?'30':'00'}`);
const label=t=>{const [h,m]=t.split(':').map(Number);return `${h%12||12}${m?':'+String(m).padStart(2,'0'):''} ${h<12?'AM':'PM'}`};
const norm=x=>JSON.stringify(Object.keys(x||{}).sort().map(k=>[k,x[k].start,x[k].end]));
const same=(a,b)=>norm(a)===norm(b);

export default function ClinicHours({canManage}){
  const {user}=useAuth(),toast=useToast();
  const [saved,setSaved]=useState(null),[h,setH]=useState(null),[busy,setBusy]=useState(false),[err,setErr]=useState('');
  const editing=useRef(false);
  // Live: another person's change shows here unless you are in the middle of editing.
  useEffect(()=>{
    let live=true;
    const load=()=>db.clinicHours(user.id).then(x=>{if(!live)return;setSaved(x);if(!editing.current)setH(x)}).catch(e=>live&&setErr(e.message));
    const on=e=>{const t=e?.detail?.table;if(!t||t==='settings')load()};
    load();addEventListener('solara',on);return()=>{live=false;removeEventListener('solara',on)};
  },[user.id]);
  if(!h)return<section id="hours" className="card st hours-card"><h3>Clinic hours</h3><div className="skel" style={{height:120}}/></section>;

  const dirty=!same(h,saved);editing.current=dirty;
  const set=(d,v)=>setH(p=>{const n={...p};if(v)n[d]=v;else delete n[d];return n});
  const bad=Object.entries(h).find(([,v])=>!(v.start<v.end));
  const copyDown=d=>setH(p=>{const n={...p};for(const [x] of DAYS)if(x!==0&&x!==6&&x!==d&&n[x])n[x]={...p[d]};return n});
  const save=async()=>{
    if(bad)return setErr('Closing time must be after opening time.');
    setBusy(true);setErr('');
    try{const r=await db.saveClinicHours(user.id,h);editing.current=false;setSaved(r);setH(r);toast('Hours saved. Open times, the website chat and Solara now use them.')}
    catch(e){setErr(e.message)}finally{setBusy(false)}
  };
  return(<section id="hours" className="card st hours-card">
    <div className="card-h"><h3>Clinic hours</h3>{dirty&&<small>Unsaved changes</small>}</div>
    <p className="route">The single source for your opening hours. Patients can only book inside them, Solara quotes them, and the Hours answer below is written from them.</p>
    <ul className="hours-list">{DAYS.map(([d,name])=>{const v=h[d];return(
      <li key={d} className={v?'':'off'}>
        <label className="hours-day"><input type="checkbox" checked={!!v} disabled={!canManage} onChange={e=>set(d,e.target.checked?{start:'09:00',end:'17:00'}:null)}/><b>{name}</b></label>
        {v?<span className="hours-range">
          <select aria-label={`${name} opens`} value={v.start} disabled={!canManage} onChange={e=>set(d,{...v,start:e.target.value})}>{TIMES.map(t=><option key={t} value={t}>{label(t)}</option>)}</select>
          <span aria-hidden="true">to</span>
          <select aria-label={`${name} closes`} value={v.end} disabled={!canManage} onChange={e=>set(d,{...v,end:e.target.value})}>{TIMES.slice(1).map(t=><option key={t} value={t}>{label(t)}</option>)}</select>
          {v.start>=v.end&&<em className="err">Closes before it opens</em>}
          {canManage&&d>=1&&d<=5&&<button type="button" className="lk" onClick={()=>copyDown(d)}>Same on weekdays</button>}
        </span>:<span className="route">Closed</span>}
      </li>)})}</ul>
    <p className="err" role="alert">{err}</p>
    {canManage&&<div className="acts"><button type="button" className="btn" disabled={!dirty||busy||!!bad} onClick={save}>{busy?'Saving…':'Save hours'}</button>
      {dirty&&<button type="button" className="btn ghost sm" onClick={()=>{setH(saved);setErr('')}}>Undo changes</button>}</div>}
  </section>);
}
