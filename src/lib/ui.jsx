import {useState,useEffect,useRef,useCallback,createContext,useContext} from 'react';
import {createPortal} from 'react-dom';
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

/* ---------- Shared building blocks: one icon set, one drawer, one confirmation dialog ---------- */
const P={
  sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  chat:'M4 5h16v11H9l-5 4z',cal:'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',bell:'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  people:'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5a6 6 0 0 1 3.5 5.5',
  chart:'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3',book:'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  list:'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  gear:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  shield:'M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z',more:'M5 12h.01M12 12h.01M19 12h.01',plus:'M12 5v14M5 12h14',
  left:'M15 5l-7 7 7 7',right:'M9 5l7 7-7 7',x:'M6 6l12 12M18 6L6 18',search:'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  check:'M5 12.5l4.5 4.5L19 7.5',alert:'M12 4l9 16H3zM12 10v4M12 17h.01',clock:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
};
export const Icon=({n,size=20})=><svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={n==='more'?3:1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n]}/></svg>;

/* Focus moves into an overlay when it opens, Escape closes it, and focus returns to where it was. */
function useOverlay(onClose,ref){
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const prev=document.activeElement;ref.current?.focus();
    const k=e=>{if(e.key==='Escape'){e.stopPropagation();close.current()}};
    document.addEventListener('keydown',k,true);
    return()=>{document.removeEventListener('keydown',k,true);prev?.focus?.()};
  },[ref]);
}

/* Side panel on wide screens, bottom sheet on phones. The page behind stays where it was. */
export function Drawer({title,sub,onClose,children}){
  const ref=useRef(null);useOverlay(onClose,ref);
  // Rendered on <body>: a page's entrance animation would otherwise trap a fixed overlay inside the page area.
  return createPortal(<div className="ov" onMouseDown={e=>e.target===e.currentTarget&&onClose()}>
    <section className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
      <div className="drawer-h"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div><button className="btn icon ghost" onClick={onClose} aria-label="Close"><Icon n="x"/></button></div>
      <div className="drawer-b">{children}</div>
    </section>
  </div>,document.body);
}

/* const confirm=useConfirm(); if(await confirm({title,body,confirm:'Cancel appointment',danger:true})) ... */
const ConfirmCtx=createContext(()=>Promise.resolve(false));
export const useConfirm=()=>useContext(ConfirmCtx);
function Dialog({q,done}){
  const ref=useRef(null);useOverlay(()=>done(false),ref);
  return createPortal(<div className="ov center" onMouseDown={e=>e.target===e.currentTarget&&done(false)}>
    <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" tabIndex={-1} ref={ref}>
      <h3 id="dlg-t">{q.title}</h3>{q.body&&<p>{q.body}</p>}
      <div className="acts"><button className={'btn sm'+(q.danger?' danger':'')} onClick={()=>done(true)}>{q.confirm||'Confirm'}</button><button className="btn ghost sm" onClick={()=>done(false)}>{q.cancel||'Cancel'}</button></div>
    </div>
  </div>,document.body);
}
export function ConfirmProvider({children}){
  const [q,setQ]=useState(null);
  const ask=useCallback(o=>new Promise(res=>setQ({...o,res})),[]);
  return<ConfirmCtx.Provider value={ask}>{children}{q&&<Dialog q={q} done={v=>{q.res(v);setQ(null)}}/>}</ConfirmCtx.Provider>;
}
export const Empty=({icon='sun',title,children})=><div className="empty"><Icon n={icon} size={28}/><b>{title}</b>{children&&<span>{children}</span>}</div>;
