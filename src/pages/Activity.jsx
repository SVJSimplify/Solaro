import {useState} from 'react';
import {db} from '../lib/db';
import {useAuth,useTable,useToast} from '../lib/hooks';
import {ago,useConfirm} from '../lib/ui';

/* Activity log and outgoing messages, kept for accountability. Owners and admins can delete entries
   (one at a time or a whole period); the list always shows what is in the database. */
const csvCell=v=>`"${String(v??'').replace(/"/g,'""')}"`;
export const LOG_RANGES=[[7,'7 days'],[30,'30 days'],[90,'90 days'],[365,'1 year'],[0,'All time']];
const fmt=t=>new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});

export default function Activity(){
  const {user}=useAuth(),toast=useToast(),confirm=useConfirm();
  const [log]=useTable('audit'),[out]=useTable('outbox');
  const [days,setDays]=useState(30),[busy,setBusy]=useState(null);
  const manager=['owner','admin'].includes(user.role);
  const since=days?Date.now()-days*864e5:0;
  const rows=log.filter(r=>r.at>=since).sort((a,b)=>b.at-a.at),msgs=out.filter(m=>m.at>=since).sort((a,b)=>b.at-a.at);
  const label=LOG_RANGES.find(r=>r[0]===days)[1].toLowerCase();

  const remove=async(kind,ids,what)=>{
    setBusy(kind+ids.join());
    try{const n=await db.deleteLogs(user.id,kind,{ids});toast(n?`Deleted ${what}`:'Already deleted')}
    catch(e){toast(e.message)}finally{setBusy(null)}
  };
  const clearPeriod=async kind=>{
    const isLog=kind==='activity',n=isLog?rows.length:msgs.filter(m=>m.status==='sent'||m.status==='failed').length;
    if(!n)return;
    if(!await confirm({title:`Delete ${n} ${isLog?'log entr'+(n===1?'y':'ies'):'message record'+(n===1?'':'s')}?`,
      body:`Everything shown for ${days?'the last '+label:'all time'} is removed for good. ${isLog?'Appointments and chats are not affected.':'Messages still waiting to send are kept.'}`,
      confirm:'Delete',cancel:'Keep',danger:true}))return;
    setBusy(kind);
    try{const k=await db.deleteLogs(user.id,kind,days?{from:new Date(since).toISOString()}:{from:'1970-01-01T00:00:00Z'});toast(`Deleted ${k} ${isLog?'entries':'records'}`)}
    catch(e){toast(e.message)}finally{setBusy(null)}
  };
  const exportCsv=()=>{
    const body=rows.map(r=>[new Date(r.at).toISOString(),r.action,r.detail].map(csvCell).join(','));
    const url=URL.createObjectURL(new Blob([['When,Action,Detail',...body].join('\n')],{type:'text/csv'}));
    const a=document.createElement('a');a.href=url;a.download='activity.csv';a.click();URL.revokeObjectURL(url);
  };
  const Del=({kind,id,what})=>manager&&<button type="button" className="row-del" aria-label={'Delete '+what} title="Delete" disabled={!!busy} onClick={()=>remove(kind,[id],what)}>×</button>;

  return(<>
    <header><div><h1>Activity</h1><p>Every booking, change and message, newest first.</p></div>
      <span className="hdr-actions">
        <span className="seg" role="group" aria-label="Time range">{LOG_RANGES.map(([d,l])=><button key={d} type="button" className="btn sm" aria-pressed={d===days} onClick={()=>setDays(d)}>{l}</button>)}</span>
        <button className="btn ghost sm" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
      </span></header>
    <div className="grid2">
      <div className="card st"><div className="card-h"><h3>Log <small className="route">{rows.length}</small></h3>
          {manager&&rows.length>0&&<button className="lk" disabled={!!busy} onClick={()=>clearPeriod('activity')}>Delete {days?'these':'all'}</button>}</div>
        {rows.length?<ul className="feed">{rows.map(r=><li key={r.id} className={busy==='activity'+r.id?'gone':''}><b>{r.action}</b> {r.detail}<small title={fmt(r.at)}>{ago(r.at)}</small><Del kind="activity" id={r.id} what="this entry"/></li>)}</ul>
          :<div className="empty">Nothing in the last {label}.</div>}
      </div>
      <div className="card st"><div className="card-h"><h3>Messages to patients <small className="route">{msgs.length}</small></h3>
          {manager&&msgs.some(m=>m.status==='sent'||m.status==='failed')&&<button className="lk" disabled={!!busy} onClick={()=>clearPeriod('messages')}>Delete {days?'these':'all'}</button>}</div>
        <p className="route">Each message shows what really happened to it. “Waiting” has not been sent; “not sent” needs a call or a retry.</p>
        {msgs.length?<ul className="feed">{msgs.map(m=><li key={m.id} className={busy==='messages'+m.id?'gone':''}><b>{m.channel.toUpperCase()} to {m.to||'—'}</b> {m.body}<small title={fmt(m.at)}>{ago(m.at)} · <span className={'chip '+(m.status==='failed'?'no_show':m.status==='sent'?'completed':'requested')}>{({queued:'waiting',processing:'sending',sent:'sent',failed:'not sent'})[m.status]||m.status}</span>{m.status==='failed'&&m.error?' '+m.error:''}</small>
          {(m.status==='sent'||m.status==='failed')&&<Del kind="messages" id={m.id} what="this message record"/>}</li>)}</ul>:<div className="empty">No messages in the last {label}.</div>}
      </div>
    </div>
  </>);
}
