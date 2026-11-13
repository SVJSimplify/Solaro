import {db} from '../lib/db';
import {useAuth,useTable} from '../lib/hooks';
import {ago} from '../lib/ui';

/* Activity log and outgoing messages. Both are kept for accountability. */
const csvCell=v=>`"${String(v??'').replace(/"/g,'""')}"`;

export default function Activity(){
  const {user}=useAuth();
  const [log]=useTable('audit'),[out]=useTable('outbox');
  const rows=[...log].sort((a,b)=>b.at-a.at),msgs=[...out].sort((a,b)=>b.at-a.at);
  const exportCsv=()=>{
    const body=rows.map(r=>[new Date(r.at).toISOString(),r.action,r.detail].map(csvCell).join(','));
    const url=URL.createObjectURL(new Blob([['When,Action,Detail',...body].join('\n')],{type:'text/csv'}));
    const a=document.createElement('a');a.href=url;a.download='activity.csv';a.click();URL.revokeObjectURL(url);
  };
  return(<>
    <header><h1>Activity</h1><button className="btn ghost sm" onClick={exportCsv} disabled={!rows.length}>Export CSV</button></header>
    <div className="grid2">
      <div className="card st"><h3>Log</h3>
        {rows.length?<ul className="feed">{rows.map(r=><li key={r.id}><b>{r.action}</b> {r.detail}<small>{ago(r.at)}</small></li>)}</ul>:<div className="empty">Nothing yet.</div>}
      </div>
      <div className="card st"><h3>Messages to patients</h3>
        <p className="route">Each message shows what really happened to it. “Waiting” has not been sent; “not sent” needs a call or a retry.</p>
        {msgs.length?<ul className="feed">{msgs.map(m=><li key={m.id}><b>{m.channel.toUpperCase()} to {m.to||'—'}</b> {m.body}<small>{ago(m.at)} · <span className={'chip '+(m.status==='failed'?'no_show':m.status==='sent'?'completed':'requested')}>{({queued:'waiting',processing:'sending',sent:'sent',failed:'not sent'})[m.status]||m.status}</span>{m.status==='failed'&&m.error?' '+m.error:''}</small></li>)}</ul>:<div className="empty">No messages yet.</div>}
      </div>
    </div>
  </>);
}
