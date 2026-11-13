import {useTable} from '../lib/hooks';
import {phoneOf} from '../lib/reasons';
import {useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {ago,Icon,Empty} from '../lib/ui';
import {nice} from '../lib/avail';

/* One record per phone number, built from bookings and chats. Exportable as CSV. */
const key=p=>String(p||'').replace(/\D/g,'').slice(-10);
const csvCell=v=>`"${String(v??'').replace(/"/g,'""')}"`;

export default function Customers(){
  const [bk]=useTable('bookings'),[cv]=useTable('convos');
  const now=new Date().toISOString().slice(0,16);
  const people=new Map();
  const get=(k,name,phone)=>{if(!people.has(k))people.set(k,{name,phone,visits:0,next:null,chats:0,lastChat:0});return people.get(k)};
  for(const b of bk){
    if(b.status==='cancelled')continue;
    const k=key(b.phone);if(!k)continue;
    const p=get(k,b.name,b.phone);
    if(b.when<now)p.visits++;else if(!p.next||b.when<p.next)p.next=b.when;
  }
  for(const c of cv){
    const ph=phoneOf(c.messages);const k=key(ph);if(!k)continue;
    const p=get(k,c.customer,ph);p.chats++;p.lastChat=Math.max(p.lastChat,c.created||0);
  }
  const rows=[...people.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const exportCsv=()=>{
    const head=['Name','Phone','Past visits','Next appointment','Chats','Last chat'];
    const body=rows.map(r=>[r.name,r.phone,r.visits,r.next?.replace('T',' ')||'',r.chats,r.lastChat?new Date(r.lastChat).toISOString().slice(0,10):''].map(csvCell).join(','));
    const url=URL.createObjectURL(new Blob([[head.map(csvCell).join(','),...body].join('\n')],{type:'text/csv'}));
    const a=document.createElement('a');a.href=url;a.download='customers.csv';a.click();URL.revokeObjectURL(url);
  };
  const [q,setQ]=useState(''),[by,setBy]=useState('name'),nav=useNavigate();
  const ql=q.trim().toLowerCase(),qd=ql.replace(/\D/g,'');
  const shown=rows.filter(r=>!ql||r.name.toLowerCase().includes(ql)||(qd.length>=3&&key(r.phone).includes(qd)))
    .sort((a,b)=>by==='name'?a.name.localeCompare(b.name):by==='next'?(a.next||'9').localeCompare(b.next||'9'):b[by]-a[by]);
  const Th=({k,children})=><th aria-sort={by===k?'ascending':undefined}><button className="sort" onClick={()=>setBy(k)}>{children}{by===k&&<Icon n="right" size={12}/>}</button></th>;
  const openP=r=>nav('/bookings?view=list&range=all&status=all&q='+encodeURIComponent(key(r.phone)));
  return(<>
    <header><div><h1>Patients</h1><p>One record per phone number, built from bookings and chats.</p></div>
      <span className="hdr-actions"><button className="btn ghost sm" onClick={exportCsv} disabled={!rows.length}>Export CSV</button></span></header>
    <div className="toolbar"><label className="search"><Icon n="search" size={18}/><input type="search" placeholder="Search name or phone" aria-label="Search name or phone" value={q} onChange={e=>setQ(e.target.value)}/></label><span className="route">{shown.length} of {rows.length}</span></div>
    <div className="card">
      {shown.length?<div className="tblwrap"><table className="tbl"><thead><tr><Th k="name">Name</Th><th>Phone</th><Th k="visits">Past visits</Th><Th k="next">Next appointment</Th><Th k="chats">Chats</Th><th>Last chat</th></tr></thead><tbody>
        {shown.map(r=><tr key={r.phone+r.name} tabIndex={0} onClick={()=>openP(r)} onKeyDown={e=>e.key==='Enter'&&openP(r)} title="Open this patient's appointments"><td><b>{r.name}</b></td><td>{r.phone}</td><td>{r.visits}</td><td>{r.next?nice(r.next):'—'}</td><td>{r.chats}</td><td>{r.lastChat?ago(r.lastChat)+' ago':'—'}</td></tr>)}
      </tbody></table></div>:<Empty icon="people" title={rows.length?'No patients match':'No patients yet'}>{rows.length?'Try a different name or number.':'They appear once they book or share a phone number in chat.'}</Empty>}
    </div>
  </>);
}
