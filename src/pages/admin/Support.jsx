/* Platform admin: every clinic's support requests. Open first (urgent at the top), then answered, then closed. */
import {useEffect,useState} from 'react';
import {adminApi} from '../../lib/supabasedb';
import {useToast} from '../../lib/hooks';

const CAT={question:'Question',problem:'Problem',urgent:'Urgent',feature:'Idea',account:'Account'};
const STATUS={open:'Needs a reply',answered:'Answered',closed:'Closed'};
const when=t=>new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
const age=t=>{const h=(Date.now()-new Date(t))/36e5;return h<1?Math.round(h*60)+' min':h<48?Math.round(h)+' h':Math.round(h/24)+' d'};

function Row({t,onChange}){
  const toast=useToast(),[open,setOpen]=useState(false),[reply,setReply]=useState(''),[busy,setBusy]=useState(false);
  const send=async e=>{e.preventDefault();setBusy(true);try{await adminApi.answer(t.id,reply);setReply('');toast('Reply sent');onChange()}catch(x){toast(x.message)}finally{setBusy(false)}};
  const status=async s=>{try{await adminApi.ticketStatus(t.id,s);onChange()}catch(x){toast(x.message)}};
  const late=t.status==='open'&&(Date.now()-new Date(t.updated_at))>864e5;
  return(<li className={'tk '+t.status}>
    <button type="button" className="tk-head" aria-expanded={open} onClick={()=>setOpen(!open)}>
      {t.category==='urgent'&&<span className="chip sys-bad">Urgent</span>}
      <b>{t.subject}<small className="tk-clinic">{t.clinic} · {CAT[t.category]}</small></b>
      <span className={'chip tk-'+t.status}>{STATUS[t.status]}</span>
      <small className={late?'tk-late':''}>{age(t.updated_at)} ago</small></button>
    {open&&<div className="tk-body">
      {t.messages.map(m=><div key={m.id} className={'tk-msg'+(m.from_solara?' solara':'')}>
        <small>{m.from_solara?'Solara support':m.author||'Clinic'} · {when(m.at)}</small><p>{m.body}</p></div>)}
      <form onSubmit={send} className="tk-reply">
        <label className="sr" htmlFor={'a'+t.id}>Reply as Solara support</label>
        <textarea id={'a'+t.id} rows={3} value={reply} maxLength={5000} onChange={e=>setReply(e.target.value)} placeholder="Reply as Solara support"/>
        <div className="acts"><button className="btn sm" disabled={busy||!reply.trim()}>{busy?'Sending…':'Send reply'}</button>
          {t.status!=='closed'?<button type="button" className="btn ghost sm" onClick={()=>status('closed')}>Close</button>
            :<button type="button" className="btn ghost sm" onClick={()=>status('open')}>Reopen</button>}</div>
      </form>
    </div>}
  </li>);
}

export default function Support(){
  const [rows,setRows]=useState(null),[err,setErr]=useState(''),[show,setShow]=useState('active');
  const load=()=>adminApi.support().then(setRows).catch(e=>setErr(e.message));
  useEffect(()=>{load();const t=setInterval(load,60000);return()=>clearInterval(t)},[]);
  const list=(rows??[]).filter(t=>show==='all'||t.status!=='closed');
  const waiting=(rows??[]).filter(t=>t.status==='open').length;
  return(<>
    <p className="route">{waiting?`${waiting} request${waiting===1?'':'s'} waiting for a reply. Aim to answer within one working day; urgent ones first.`:'No requests waiting for a reply.'}</p>
    <div className="toolbar"><select aria-label="Show" value={show} onChange={e=>setShow(e.target.value)} style={{width:'auto'}}>
      <option value="active">Open and answered</option><option value="all">All, including closed</option></select></div>
    {err&&<p className="err" role="alert">{err}</p>}
    {rows===null&&!err&&<p className="route">Loading…</p>}
    {rows&&!list.length&&<div className="empty">Nothing here.</div>}
    {list.length>0&&<ul className="tks">{list.map(t=><Row key={t.id+t.updated_at} t={t} onChange={load}/>)}</ul>}
  </>);
}
