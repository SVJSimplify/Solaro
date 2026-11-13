import {useState} from 'react';
import {Link} from 'react-router-dom';
import {db} from '../lib/db';
import {useTable} from '../lib/hooks';
import {ago} from '../lib/ui';
import {REASON,phoneOf} from '../lib/reasons';
import CallPanel from '../lib/CallPanel';

/* Every hand-off Solara makes lands here. The reason opens a call panel when the customer gave a number. */
export default function Alerts(){
  const [al]=useTable('alerts'),[cv]=useTable('convos');
  const [callId,setCallId]=useState(null);
  const list=[...al].sort((a,b)=>b.created-a.created);
  const chatOf=a=>cv.find(c=>c.id===a.convo);
  const open=async a=>{if(!a.read)await db.patch('alerts',a.id,{read:true})};
  return(
    <section className="alerts">
      <header><h1>Alerts</h1></header>
      {!list.length&&<p className="muted">No alerts. Solara hasn't needed a human yet.</p>}
      {list.map(a=>{
        const phone=phoneOf(chatOf(a)?.messages||[]);
        return(
          <div key={a.id} className={'row st'+(a.reason==='emergency'||a.reason==='health_risk'?' urgent':'')}>
            <b>{a.customer}{!a.read&&<span className="pill hot">New</span>}</b>
            {phone
              ?<button className="why" onClick={()=>setCallId(callId===a.id?null:a.id)} aria-expanded={callId===a.id}>{REASON[a.reason]||REASON.other}</button>
              :<small>{REASON[a.reason]||REASON.other}</small>}
            <small>{a.text}</small>
            <small>{ago(a.created)}</small>
            {callId===a.id&&phone&&<CallPanel phone={phone} onClose={()=>setCallId(null)}/>}
            <Link to={'/inbox?c='+a.convo} onClick={()=>open(a)}>Open chat</Link>
          </div>);
      })}
    </section>
  );
}
