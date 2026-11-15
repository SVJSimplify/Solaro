/* Platform admin: everything deleted in the last 30 days, one row per action, with restore. */
import {useEffect,useState} from 'react';
import {adminApi} from '../../lib/supabasedb';
import {useToast} from '../../lib/hooks';

const LABEL={organizations:'clinic',settings:'settings',members:'team member',doctors:'doctor',services:'service',kb:'answer',closures:'closure',
  schedule_rules:'schedule rule',schedule_exceptions:'time off',business_entities:'record',entity_relationships:'link',business_facts:'fact',
  conversations:'chat',bookings:'booking',messages:'message',alerts:'alert'};
const describe=sum=>Object.entries(sum||{}).sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${n} ${LABEL[t]||t}${n===1?'':'s'}`).join(', ');
const when=t=>new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
const daysLeft=t=>Math.max(0,30-Math.floor((Date.now()-new Date(t))/864e5));

export default function Trash(){
  const toast=useToast(),[rows,setRows]=useState(null),[err,setErr]=useState(''),[busy,setBusy]=useState(null);
  const load=()=>adminApi.trash().then(setRows).catch(e=>setErr(e.message));
  useEffect(()=>{load()},[]);
  const restore=async r=>{
    if(!confirm(`Restore ${describe(r.summary)} for ${r.clinic}?`))return;
    setBusy(r.batch);
    try{const got=await adminApi.restore(r.batch);toast('Restored '+describe(got));load()}catch(e){toast(e.message)}finally{setBusy(null)}};
  return(<>
    <p className="route">Anything deleted from a clinic is kept here for 30 days, then removed for good. Restoring puts back everything that one action deleted.</p>
    {err&&<p className="err" role="alert">{err}</p>}
    {rows===null&&!err&&<p className="route">Loading…</p>}
    {rows&&!rows.length&&<div className="empty">Nothing has been deleted in the last 30 days.</div>}
    {rows?.length>0&&<div className="card adm-list"><table>
      <thead><tr><th>Clinic</th><th>What was deleted</th><th>When</th><th>By</th><th aria-label="Restore"/></tr></thead>
      <tbody>{rows.map(r=><tr key={r.batch}>
        <td><b>{r.clinic}</b></td>
        <td>{describe(r.summary)}</td>
        <td>{when(r.deleted_at)}<small>{daysLeft(r.deleted_at)} days left</small></td>
        <td>{r.deleted_by||<small>System</small>}</td>
        <td><button type="button" className="btn ghost sm" disabled={busy!==null} onClick={()=>restore(r)}>{busy===r.batch?'Restoring…':'Restore'}</button></td>
      </tr>)}</tbody></table></div>}
  </>);
}
