import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {db} from './db';
import {useAuth,useToast} from './hooks';

/* How much Solara does on its own. The database enforces the mode; this screen only explains and changes it.
   Safe work is always automatic. Risky actions wait for staff unless the owner turns on full autonomy,
   which needs the risks read, a tick, and the clinic name typed. */
const ALWAYS=[
  'Answers patients from your Knowledge and clinic hours',
  'Shows only open, future times and takes booking requests',
  'Sends appointment reminders',
  'Cancels an appointment booked in the chat once the patient confirms and gives a reason',
  'Closes requests whose time passed before anyone confirmed them, and tells the patient',
  'Ends chats it is handling after 7 days of silence',
  'Hands emergencies, health worries and upset patients to your team, and stays out of the chat after that',
];
const RISKY=[
  'Confirming website booking requests',
  'Confirming appointments a patient moves to a new time',
];
const NEVER=[
  'Give medical advice or judge symptoms',
  'Remove doctors or delete records (a person always confirms)',
  'Reply in a chat after it has been handed to your team',
];
const RISKS=[
  'Bookings are confirmed without anyone checking them. A patient may be booked for a service or time your team would have declined.',
  'Patients are told their appointment is confirmed straight away. Undoing it means contacting them.',
  'Solara can misunderstand a message. With no one reviewing, a mistake can reach the patient before your team sees it.',
  'Everything Solara does is still logged in Activity, and you can turn full autonomy off at any time. It only affects what happens from then on.',
];

export default function Autonomy(){
  const {user}=useAuth(),toast=useToast(),owner=user.role==='owner';
  const [s,setS]=useState(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{
    let live=true;const load=()=>db.settings(user.id).then(v=>live&&setS(v)).catch(()=>{});
    const on=e=>{const t=e?.detail?.table;if(!t||t==='settings')load()};
    load();addEventListener('solara',on);return()=>{live=false;removeEventListener('solara',on)};
  },[user.id]);
  if(!s)return null;
  const full=s.autonomy==='full';
  const turnOff=async()=>{setBusy(true);try{await db.setAutonomy(user.id,'assisted');toast('Full autonomy is off. Risky actions wait for your team again.')}catch(e){toast(e.message)}finally{setBusy(false)}};

  return(<section className="card st auto-card" style={{maxWidth:720,marginTop:16}}>
    <div className="card-h"><h3>What Solara does on its own</h3><span className={'auto-badge'+(full?' full':'')}>{full?'Full autonomy':'Staff approve risky actions'}</span></div>
    <div className="auto-cols">
      <div><h4>Always automatic</h4><ul className="auto-list ok">{ALWAYS.map(x=><li key={x}>{x}</li>)}</ul></div>
      <div><h4>{full?'Automatic (full autonomy)':'Waits for staff approval'}</h4><ul className={'auto-list '+(full?'warn':'wait')}>{RISKY.map(x=><li key={x}>{x}</li>)}</ul>
        <h4>Never, in any mode</h4><ul className="auto-list no">{NEVER.map(x=><li key={x}>{x}</li>)}</ul></div>
    </div>
    {full&&s.autonomyAck&&<p className="route">Turned on {s.autonomyAck.email?`by ${s.autonomyAck.email} `:''}on {new Date(s.autonomyAck.at).toLocaleString([],{dateStyle:'medium',timeStyle:'short'})}, with the risks accepted.</p>}
    {owner?<div className="acts">{full
        ?<button className="btn ghost sm" disabled={busy} onClick={turnOff}>Turn off full autonomy</button>
        :<button className="btn sm" onClick={()=>setOpen(true)}>Let Solara run everything…</button>}</div>
      :<p className="route">Only the clinic owner can change this.</p>}
    {open&&<FullDialog biz={user.biz||''} onClose={()=>setOpen(false)} onDone={()=>{setOpen(false);toast('Full autonomy is on. Solara now confirms bookings itself.')}}/>}
  </section>);
}

function FullDialog({biz,onClose,onDone}){
  const {user}=useAuth(),[ok,setOk]=useState(false),[name,setName]=useState(''),[busy,setBusy]=useState(false),[err,setErr]=useState(''),ref=useRef(null);
  useEffect(()=>{ref.current?.focus();const k=e=>e.key==='Escape'&&onClose();addEventListener('keydown',k);return()=>removeEventListener('keydown',k)},[onClose]);
  const match=name.trim().toLowerCase()===biz.trim().toLowerCase()&&biz.trim()!=='';
  const go=async()=>{setBusy(true);setErr('');try{await db.setAutonomy(user.id,'full',name.trim());onDone()}catch(e){setErr(e.message)}finally{setBusy(false)}};
  return createPortal(<div className="ov center" onMouseDown={e=>e.target===e.currentTarget&&onClose()}>
    <div className="dialog auto-dlg" role="alertdialog" aria-modal="true" aria-labelledby="auto-t" tabIndex={-1} ref={ref}>
      <h2 id="auto-t">Let Solara act without approval?</h2>
      <p>With full autonomy, Solara confirms bookings and moved appointments itself, without anyone on your team checking first.</p>
      <h4>Before you turn it on</h4>
      <ul className="auto-risks">{RISKS.map(r=><li key={r}>{r}</li>)}</ul>
      <label className="auto-ack"><input type="checkbox" checked={ok} onChange={e=>setOk(e.target.checked)}/>
        <span>I understand that Solara can make mistakes, and I accept responsibility for the actions it takes on my clinic's behalf while full autonomy is on.</span></label>
      <div className="f"><label htmlFor="auto-n">Type <b>{biz}</b> to confirm</label><input id="auto-n" value={name} onChange={e=>setName(e.target.value)} autoComplete="off" disabled={!ok}/></div>
      <p className="err" role="alert">{err}</p>
      <div className="acts"><button className="btn sm danger" disabled={!ok||!match||busy} onClick={go}>{busy?'Turning on…':'Turn on full autonomy'}</button><button className="btn ghost sm" onClick={onClose}>Keep staff approval</button></div>
    </div></div>,document.body);
}
