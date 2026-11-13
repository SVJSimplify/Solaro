import {useState,useEffect} from 'react';
export const RM=matchMedia('(prefers-reduced-motion:reduce)').matches;
export const wait=ms=>new Promise(r=>setTimeout(r,ms));
export const ago=t=>{const m=Math.round((Date.now()-t)/6e4);return m<1?'now':m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'};
export const Logo=()=><div className="logo"><svg><use href="#m"/></svg>solara</div>;
export function Count({n}){
  const [v,setV]=useState(RM?n:0);
  useEffect(()=>{if(RM){setV(n);return}let id;const t0=performance.now(),k=t=>{const p=Math.min(1,(t-t0)/700);setV(Math.round(n*(1-(1-p)**3)));if(p<1)id=requestAnimationFrame(k)};id=requestAnimationFrame(k);return()=>cancelAnimationFrame(id)},[n]);
  return v;
}

/* Import preview. Nothing is written until the user clicks Import; matching records are kept unless they tick "update". */
export function ImportPreview({diff,onApply,onCancel}){
  const [replace,setReplace]=useState(false),[busy,setBusy]=useState(false);
  const dups=diff.dupDoctors.length+diff.dupAnswers.length;
  const go=async()=>{setBusy(true);try{await onApply(diff.plan,replace)}finally{setBusy(false)}};
  return(<div className="card st" role="region" aria-label="Import preview" style={{marginTop:12}}>
    <h3>Review import</h3>
    <p>Adds {diff.newDoctors.length} doctor{diff.newDoctors.length===1?'':'s'} and {diff.newAnswers.length} answer{diff.newAnswers.length===1?'':'s'}. Existing doctors and answers are kept. Nothing is deleted.</p>
    {!!diff.newDoctors.length&&<p className="route">New doctors: {diff.newDoctors.map(d=>d.name).join(', ')}</p>}
    {!!dups&&<>
      <p className="route">Already saved: {[...diff.dupDoctors.map(d=>d.name),...diff.dupAnswers.map(a=>a.title)].join(', ')}</p>
      <label><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/> Replace the saved details of these {dups} with the imported version</label>
    </>}
    <div className="acts" style={{marginTop:8}}>
      <button type="button" className="btn sm" disabled={busy||(!diff.newDoctors.length&&!diff.newAnswers.length&&!replace)} onClick={go}>{busy?'Importing…':'Import'}</button>
      <button type="button" className="btn ghost sm" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </div>);
}

/* Doctor removal confirmation. Only this button deletes, by redeeming the server-issued single-use token. */
export function ConfirmDeleteDoctor({c,onConfirm,onDone}){
  const [busy,setBusy]=useState(false),[err,setErr]=useState('');
  const go=async()=>{setBusy(true);setErr('');try{onDone(await onConfirm(c.token),true)}catch(e){setErr(e.message||'Could not remove the doctor')}finally{setBusy(false)}};
  return(<div className="card st" role="alertdialog" aria-label={'Remove '+c.doctor} style={{borderColor:'var(--err,#c33)'}}>
    <b>Remove {c.doctor}{c.specialty?` (${c.specialty})`:''}?</b>
    <p>This permanently removes the doctor from your schedule and the front desk. {c.upcoming_bookings?`${c.upcoming_bookings} upcoming booking${c.upcoming_bookings===1?'':'s'} will stay but will no longer be linked to this doctor.`:'No upcoming bookings are linked to this doctor.'} This link expires in 5 minutes.</p>
    {err&&<p className="err" role="alert">{err}</p>}
    <div className="acts">
      <button type="button" className="btn sm" disabled={busy} onClick={go}>{busy?'Removing…':'Confirm removal'}</button>
      <button type="button" className="btn ghost sm" disabled={busy} onClick={()=>onDone(null,false)}>Cancel</button>
    </div>
  </div>);
}
