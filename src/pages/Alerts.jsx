import {useState} from 'react';
import {Link} from 'react-router-dom';
import {db} from '../lib/db';
import {useTable,useToast} from '../lib/hooks';
import {ago,Empty,Icon} from '../lib/ui';
import {REASON,phoneOf} from '../lib/reasons';
import CallPanel from '../lib/CallPanel';

/* Every hand-off Solara makes lands here. The reason opens a call panel when the patient gave a number. */
export default function Alerts(){
  const [al]=useTable('alerts'),[cv]=useTable('convos'),toast=useToast();
  const [callId,setCallId]=useState(null),[tab,setTab]=useState('new');
  const unread=al.filter(a=>!a.read),list=[...(tab==='new'?unread:al)].sort((a,b)=>b.created-a.created);
  const chatOf=a=>cv.find(c=>c.id===a.convo);
  const read=async a=>{if(!a.read)await db.patch('alerts',a.id,{read:true})};
  const readAll=async()=>{for(const a of unread)await db.patch('alerts',a.id,{read:true});toast('All alerts marked as read')};
  return(<>
    <header><div><h1>Alerts</h1><p>When Solara hands a chat to your team, the reason is recorded here.</p></div>
      <span className="hdr-actions">{unread.length>0&&<button className="btn ghost sm" onClick={readAll}><Icon n="check" size={16}/>Mark all as read</button>}</span></header>
    <div className="toolbar"><div className="seg" role="group" aria-label="Show">{[['new',`New${unread.length?` (${unread.length})`:''}`],['all','All']].map(([k,l])=><button key={k} type="button" className="btn sm" aria-pressed={k===tab} onClick={()=>setTab(k)}>{l}</button>)}</div></div>
    <section className="card alerts">
      {!list.length&&<Empty icon="bell" title={tab==='new'?'No new alerts':'No alerts yet'}>{tab==='new'&&al.length?'Everything has been read.':'Solara has not needed a person yet.'}</Empty>}
      {list.map(a=>{
        const phone=phoneOf(chatOf(a)?.messages||[]),urgent=a.reason==='emergency'||a.reason==='health_risk';
        return(<div key={a.id} className={'alert-row'+(urgent?' urgent':'')+(a.read?' read':'')}>
          <div className="alert-m"><b>{a.customer||'Website visitor'}</b>{!a.read&&<span className="pill hot">New</span>}{urgent&&<span className="pill urgent">Urgent</span>}<small>{ago(a.created)}</small></div>
          <p>{phone?<button className="why" onClick={()=>setCallId(callId===a.id?null:a.id)} aria-expanded={callId===a.id}>{REASON[a.reason]||REASON.other}</button>:<span className="why-t">{REASON[a.reason]||REASON.other}</span>}{a.text?` · ${a.text}`:''}</p>
          {callId===a.id&&phone&&<CallPanel phone={phone} onClose={()=>setCallId(null)}/>}
          <div className="acts"><Link className="btn sm" to={'/inbox?c='+a.convo} onClick={()=>read(a)}>Open chat</Link>{!a.read&&<button className="btn ghost sm" onClick={()=>read(a)}>Mark as read</button>}</div>
        </div>);
      })}
    </section>
  </>);
}
