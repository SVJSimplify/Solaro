/* Help: quick answers, a way to reach Solara support, and the clinic's own support conversations. */
import {useEffect,useState} from 'react';
import {db} from '../lib/db';
import {useToast} from '../lib/hooks';

const FAQ=[
  ['Solara handed a chat to us. What now?','Open Inbox: chats waiting for a person are at the top. Reply there and the patient sees it in the chat within a few seconds.'],
  ['How do I change opening hours?','Knowledge → Clinic hours. Solara uses the new hours straight away, even in chats that are already open.'],
  ['A patient booked a time we can’t do.','Open the request in Bookings and decline it, or move it to a time that works for you.'],
  ['The chat button doesn’t show on our website.','Website chat → check your site is on the Allowed websites list and the code is pasted before </body>. Then use Check it’s live.'],
  ['How do I add my receptionist?','Settings → Team → Invite someone, then send them the link. It only works for the email address you entered.'],
  ['Someone deleted something by mistake.','Deleted records are kept for 30 days. Open a support request below and we will restore it.'],
  ['Can I get a copy of all our data?','Yes. The clinic owner can download everything from Settings → Your data.'],
];
const CATS=[['question','A question'],['problem','Something isn’t working'],['urgent','Urgent: patients are affected'],['feature','An idea or request'],['account','Account or billing']];
const STATUS={open:'Waiting for Solara',answered:'Solara replied',closed:'Closed'};
const when=t=>new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});

function Ticket({t,onChange}){
  const toast=useToast(),[open,setOpen]=useState(t.status==='answered'),[reply,setReply]=useState(''),[busy,setBusy]=useState(false);
  const send=async e=>{e.preventDefault();setBusy(true);try{await db.replyTicket(t.id,reply);setReply('');onChange()}catch(x){toast(x.message)}finally{setBusy(false)}};
  const status=async s=>{try{await db.ticketStatus(t.id,s);onChange()}catch(x){toast(x.message)}};
  return(<li className={'tk '+t.status}>
    <button type="button" className="tk-head" aria-expanded={open} onClick={()=>setOpen(!open)}>
      <b>{t.subject}</b><span className={'chip tk-'+t.status}>{STATUS[t.status]}</span><small>{when(t.updated_at)}</small></button>
    {open&&<div className="tk-body">
      {t.messages.map(m=><div key={m.id} className={'tk-msg'+(m.from_solara?' solara':'')}>
        <small>{m.from_solara?'Solara support':m.author||'Your team'} · {when(m.at)}</small><p>{m.body}</p></div>)}
      {t.status!=='closed'?<form onSubmit={send} className="tk-reply">
        <label className="sr" htmlFor={'r'+t.id}>Reply</label>
        <textarea id={'r'+t.id} rows={3} value={reply} maxLength={5000} onChange={e=>setReply(e.target.value)} placeholder="Add more detail or reply"/>
        <div className="acts"><button className="btn sm" disabled={busy||!reply.trim()}>{busy?'Sending…':'Send'}</button>
          <button type="button" className="btn ghost sm" onClick={()=>status('closed')}>Mark solved</button></div>
      </form>:<button type="button" className="btn ghost sm" onClick={()=>status('open')}>Reopen</button>}
    </div>}
  </li>);
}

export default function Help(){
  const toast=useToast(),[tickets,setTickets]=useState(null),[f,setF]=useState({subject:'',category:'question',body:''}),[busy,setBusy]=useState(false),[err,setErr]=useState('');
  const load=()=>db.tickets().then(setTickets).catch(e=>setErr(e.message));
  useEffect(()=>{load();const t=setInterval(load,60000);return()=>clearInterval(t)},[]);
  const set=k=>e=>setF({...f,[k]:e.target.value});
  const submit=async e=>{e.preventDefault();setErr('');setBusy(true);
    try{await db.newTicket(f.subject.trim(),f.category,f.body.trim());setF({subject:'',category:'question',body:''});toast('Sent. We reply here, usually within one working day.');load()}
    catch(x){setErr(x.message)}finally{setBusy(false)}};
  return(<>
    <header><h1>Help</h1><p className="route">Quick answers, and a direct line to the Solara team.</p></header>
    <div className="help-grid">
      <section className="card st">
        <h3>Quick answers</h3>
        {FAQ.map(([q,a])=><details key={q} className="faq"><summary>{q}</summary><p>{a}</p></details>)}
      </section>
      <section className="card st">
        <h3>Contact Solara support</h3>
        <form onSubmit={submit}>
          <div className="f"><label htmlFor="hs-c">What is it about?</label><select id="hs-c" value={f.category} onChange={set('category')}>{CATS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
          <div className="f"><label htmlFor="hs-s">Subject</label><input id="hs-s" value={f.subject} onChange={set('subject')} maxLength={140} required minLength={3} placeholder="e.g. Reminders aren’t going out"/></div>
          <div className="f"><label htmlFor="hs-b">Details</label><textarea id="hs-b" rows={5} value={f.body} onChange={set('body')} maxLength={5000} required placeholder="What happened, and what did you expect? Please don’t include patient medical details."/></div>
          {f.category==='urgent'&&<p className="help-urgent">Urgent requests go to the top of our list. If patients can’t reach you at all, also call them back from your clinic phone.</p>}
          {err&&<p className="err" role="alert">{err}</p>}
          <button className="btn" disabled={busy||f.subject.trim().length<3||!f.body.trim()}>{busy?'Sending…':'Send to support'}</button>
        </form>
      </section>
    </div>
    <h3 className="sys-h">Your requests</h3>
    {tickets===null&&!err&&<p className="route">Loading…</p>}
    {tickets?.length===0&&<div className="empty">No support requests yet.</div>}
    {tickets?.length>0&&<ul className="tks">{tickets.map(t=><Ticket key={t.id+t.updated_at} t={t} onChange={load}/>)}</ul>}
  </>);
}
