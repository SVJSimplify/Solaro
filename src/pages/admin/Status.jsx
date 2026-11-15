/* Platform admin: live health checks (refreshed every 30 s), open alerts and recent history.
   The same checks run every 5 minutes on the server and open or resolve alerts on their own. */
import {useEffect,useState} from 'react';
import {adminApi} from '../../lib/supabasedb';
import {useToast} from '../../lib/hooks';

const HEALTH_URL='https://wqhxpfzbvtkdwzehddjr.supabase.co/functions/v1/health';
const STATUS={ok:['All systems normal','ok'],degraded:['Working, with warnings','warn'],down:['Something critical is failing','bad']};
const when=t=>t?new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'';
const since=t=>{const m=Math.round((Date.now()-new Date(t))/6e4);return m<60?m+' min':m<1440?Math.round(m/60)+' h':Math.round(m/1440)+' d'};

export default function Status(){
  const toast=useToast(),[h,setH]=useState(null),[err,setErr]=useState('');
  const load=()=>adminApi.health().then(x=>{setH(x);setErr('')}).catch(e=>setErr(e.message));
  useEffect(()=>{load();const t=setInterval(load,30000);return()=>clearInterval(t)},[]);
  const resolve=async a=>{try{await adminApi.resolveAlert(a.id);toast('Marked resolved');load()}catch(e){toast(e.message)}};
  if(err)return<p className="err" role="alert">{err}</p>;
  if(!h)return<p className="route">Checking…</p>;
  const [label,tone]=STATUS[h.status]??STATUS.down;
  return(<>
    <div className={'card st sys-head '+tone} role="status">
      <span className="sys-dot" aria-hidden="true"/><div><b>{label}</b><small>Checked {when(h.checked_at)} · refreshes every 30 seconds</small></div>
    </div>

    <div className="card adm-list" style={{marginTop:16}}><table>
      <thead><tr><th>Check</th><th>State</th><th>Detail</th></tr></thead>
      <tbody>{h.checks.map(c=><tr key={c.key}>
        <td><b>{c.label}</b></td>
        <td><span className={'chip '+(c.ok?'sys-ok':c.severity==='critical'?'sys-bad':'sys-warn')}>{c.ok?'OK':c.severity==='critical'?'Failing':'Warning'}</span></td>
        <td>{c.detail}</td></tr>)}</tbody></table></div>

    <h3 className="sys-h">Open alerts</h3>
    {!h.open.length?<div className="empty">No open alerts.</div>:<div className="card adm-list"><table>
      <thead><tr><th>Alert</th><th>Detail</th><th>Open for</th><th aria-label="Resolve"/></tr></thead>
      <tbody>{h.open.map(a=><tr key={a.id}>
        <td><span className={'chip '+(a.severity==='critical'?'sys-bad':'sys-warn')}>{a.severity==='critical'?'Critical':'Warning'}</span> <b>{a.title}</b></td>
        <td>{a.detail}</td><td>{since(a.opened_at)}</td>
        <td><button type="button" className="btn ghost sm" onClick={()=>resolve(a)}>Resolve</button></td></tr>)}</tbody></table></div>}

    {h.recent.length>0&&<><h3 className="sys-h">Recently resolved</h3><div className="card adm-list"><table>
      <thead><tr><th>Alert</th><th>Opened</th><th>Resolved</th><th>By</th></tr></thead>
      <tbody>{h.recent.map(a=><tr key={a.id}><td><b>{a.title}</b><small>{a.detail}</small></td><td>{when(a.opened_at)}</td><td>{when(a.resolved_at)}</td><td>{a.resolved_by==='auto'?'Automatically':a.resolved_by}</td></tr>)}</tbody></table></div></>}

    <div className="card st" style={{marginTop:16}}>
      <h3>Get emailed when Solara goes down</h3>
      <p className="route">Add this address to an uptime monitor (UptimeRobot or Better Stack, both free). It answers 503 when a critical check fails or the database can't be reached.</p>
      <div className="inst-row"><code className="sys-url">{HEALTH_URL}</code>
        <button type="button" className="btn ghost sm" onClick={()=>navigator.clipboard.writeText(HEALTH_URL).then(()=>toast('Copied'))}>Copy</button></div>
    </div>
  </>);
}
