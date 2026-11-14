import {useMemo,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {useAuth,useTable,useClinicNow} from '../lib/hooks';
import {phoneOf} from '../lib/reasons';
import {ago,Icon,Empty} from '../lib/ui';
import {nice,clock,STATUS} from '../lib/avail';

/* One record per phone number, built live from bookings and chats in the clinic's own time.
   Filters narrow by where the patient stands (upcoming, new, returning, lapsed, missed), by doctor and by service. */
const key=p=>String(p||'').replace(/\D/g,'').slice(-10);
const csvCell=v=>`"${String(v??'').replace(/"/g,'""')}"`;
const initials=n=>String(n||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]?.toUpperCase()||'').join('')||'?';
const DAY=864e5;
const FILTERS=[
  ['all','Everyone'],
  ['upcoming','Upcoming visit'],
  ['requested','Waiting to confirm'],
  ['new','New this month'],
  ['returning','Returning'],
  ['missed','Missed a visit'],
  ['lapsed','No visit in 6 months'],
  ['chat','Chatted only'],
];
const SORTS=[['next','Next visit'],['recent','Recently active'],['name','Name'],['visits','Most visits']];

function build(bk,cv,now){
  const people=new Map();
  const get=(k,name,phone)=>{
    if(!people.has(k))people.set(k,{k,name,phone,visits:0,noShows:0,cancelled:0,next:null,nextStatus:null,nextDoctor:'',nextService:'',
      lastVisit:null,services:new Set(),doctors:new Set(),chats:0,lastChat:0,first:Infinity,last:0,total:0});
    return people.get(k);
  };
  for(const b of [...bk].sort((a,b)=>a.created-b.created)){
    const k=key(b.phone);if(!k)continue;
    const p=get(k,b.name,b.phone);p.name=b.name||p.name;p.phone=b.phone||p.phone;p.total++;
    p.first=Math.min(p.first,b.created||Infinity);p.last=Math.max(p.last,b.created||0);
    if(b.service)p.services.add(b.service);if(b.doctor)p.doctors.add(b.doctor);
    if(b.status==='cancelled'){p.cancelled++;continue}
    if(b.status==='no_show'){p.noShows++;continue}
    const ahead=b.when>=now&&(b.status==='booked'||b.status==='requested');
    if(ahead){if(!p.next||b.when<p.next){p.next=b.when;p.nextStatus=b.status;p.nextDoctor=b.doctor||'';p.nextService=b.service||''}}
    else if(b.when<now&&b.status!=='requested'){p.visits++;if(!p.lastVisit||b.when>p.lastVisit)p.lastVisit=b.when}
  }
  for(const c of cv){
    const ph=phoneOf(c.messages)||(String(c.customer).match(/\+?\d[\d\s()-]{8,}/)?.[0]??'');const k=key(ph);if(!k)continue;
    const named=String(c.customer).split(' · ')[0];
    const p=get(k,/website visitor|test customer/i.test(named)?'Website visitor':named,ph);
    p.chats++;p.lastChat=Math.max(p.lastChat,c.created||0);p.first=Math.min(p.first,c.created||Infinity);p.last=Math.max(p.last,c.created||0);
  }
  return[...people.values()].map(p=>({...p,services:[...p.services],doctors:[...p.doctors],first:isFinite(p.first)?p.first:0}));
}

export default function Customers(){
  const {user}=useAuth(),nav=useNavigate(),now=useClinicNow(user.tz);
  const [bk]=useTable('bookings'),[cv]=useTable('convos');
  const [q,setQ]=useState(''),[f,setF]=useState('all'),[doc,setDoc]=useState(''),[svc,setSvc]=useState(''),[by,setBy]=useState('next');
  const rows=useMemo(()=>build(bk,cv,now),[bk,cv,now]);
  const sixMonths=(()=>{const d=new Date(now.slice(0,10)+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-6);return d.toISOString().slice(0,10)})();
  const test={
    all:()=>true,
    upcoming:p=>!!p.next,
    requested:p=>p.nextStatus==='requested',
    new:p=>p.first>Date.now()-30*DAY,
    returning:p=>p.visits>=2,
    missed:p=>p.noShows>0,
    lapsed:p=>!p.next&&p.visits>0&&(p.lastVisit||'')<sixMonths,
    chat:p=>!p.total&&p.chats>0,
  };
  const counts=Object.fromEntries(FILTERS.map(([k])=>[k,rows.filter(test[k]).length]));
  const doctors=[...new Set(rows.flatMap(r=>r.doctors))].sort(),services=[...new Set(rows.flatMap(r=>r.services))].sort();
  const ql=q.trim().toLowerCase(),qd=ql.replace(/\D/g,'');
  const shown=rows.filter(r=>test[f](r)&&(!doc||r.doctors.includes(doc))&&(!svc||r.services.includes(svc))
      &&(!ql||r.name.toLowerCase().includes(ql)||(qd.length>=3&&r.k.includes(qd))))
    .sort((a,b)=>by==='name'?a.name.localeCompare(b.name):by==='visits'?b.visits-a.visits||a.name.localeCompare(b.name)
      :by==='recent'?b.last-a.last:(a.next||'9').localeCompare(b.next||'9')||b.last-a.last);
  const exportCsv=()=>{
    const head=['Name','Phone','Visits','No-shows','Cancelled','Next appointment','Next status','Last visit','Services','Doctors','Chats'];
    const body=shown.map(r=>[r.name,r.phone,r.visits,r.noShows,r.cancelled,r.next?.replace('T',' ')||'',r.nextStatus?STATUS[r.nextStatus]:'',r.lastVisit?.replace('T',' ')||'',r.services.join('; '),r.doctors.join('; '),r.chats].map(csvCell).join(','));
    const url=URL.createObjectURL(new Blob([[head.map(csvCell).join(','),...body].join('\n')],{type:'text/csv'}));
    const a=document.createElement('a');a.href=url;a.download='patients.csv';a.click();URL.revokeObjectURL(url);
  };
  const openP=r=>nav('/bookings?view=list&range=all&status=all&q='+encodeURIComponent(r.k));
  const clear=()=>{setQ('');setF('all');setDoc('');setSvc('')};
  const filtered=f!=='all'||doc||svc||ql;

  return(<>
    <header><div><h1>Patients</h1><p>{rows.length} {rows.length===1?'person':'people'}, one per phone number, kept up to date from bookings and chats.</p></div>
      <span className="hdr-actions"><button className="btn ghost sm" onClick={exportCsv} disabled={!shown.length}>Export CSV</button></span></header>

    <div className="pt-filters" role="group" aria-label="Show">
      {FILTERS.map(([k,l])=><button key={k} type="button" className={'pt-f'+(f===k?' on':'')} aria-pressed={f===k} onClick={()=>setF(k)} disabled={k!=='all'&&!counts[k]&&f!==k}>
        {l}<span>{counts[k]}</span></button>)}
    </div>
    <div className="toolbar pt-tools">
      <label className="search"><Icon n="search" size={18}/><input type="search" placeholder="Search name or phone" aria-label="Search name or phone" value={q} onChange={e=>setQ(e.target.value)}/></label>
      <select aria-label="Doctor" value={doc} onChange={e=>setDoc(e.target.value)}><option value="">Any doctor</option>{doctors.map(d=><option key={d}>{d}</option>)}</select>
      <select aria-label="Service" value={svc} onChange={e=>setSvc(e.target.value)}><option value="">Any service</option>{services.map(s=><option key={s}>{s}</option>)}</select>
      <select aria-label="Sort by" value={by} onChange={e=>setBy(e.target.value)}>{SORTS.map(([k,l])=><option key={k} value={k}>Sort: {l}</option>)}</select>
      <span className="route">{shown.length} of {rows.length}</span>
      {filtered&&<button type="button" className="lk" onClick={clear}>Clear filters</button>}
    </div>

    {shown.length?<ul className="pt-list">{shown.map(r=>(
      <li key={r.k}><button className="pt-row" onClick={()=>openP(r)} title="Open this patient's appointments">
        <span className="pt-av" aria-hidden="true">{initials(r.name)}</span>
        <span className="pt-id"><b>{r.name}</b><small>{r.phone}</small>
          {(r.services.length>0)&&<span className="pt-tags">{r.services.slice(0,3).map(s=><i key={s}>{s}</i>)}{r.services.length>3&&<i>+{r.services.length-3}</i>}</span>}</span>
        <span className="pt-next">{r.next?<><small>Next visit</small><b>{r.next.slice(0,10)===now.slice(0,10)?'Today, '+clock(r.next):nice(r.next)}</b><span><span className={'chip '+r.nextStatus}>{STATUS[r.nextStatus]}</span>{r.nextDoctor&&<em>{r.nextDoctor}</em>}</span></>
          :<><small>Next visit</small><b className="mu">None booked</b>{r.lastVisit&&<span><em>Last seen {nice(r.lastVisit.slice(0,10))}</em></span>}</>}</span>
        <span className="pt-stats">
          <span><b>{r.visits}</b><small>visit{r.visits===1?'':'s'}</small></span>
          <span className={r.noShows?'bad':''}><b>{r.noShows}</b><small>missed</small></span>
          <span><b>{r.chats}</b><small>chat{r.chats===1?'':'s'}</small></span>
        </span>
        <span className="pt-when"><small>{r.last?'Active '+ago(r.last)+(ago(r.last)==='now'?'':' ago'):''}</small><Icon n="right" size={16}/></span>
      </button></li>))}</ul>
    :<div className="card"><Empty icon="people" title={rows.length?'No patients match':'No patients yet'}>{rows.length?<>Try another filter. <button className="lk" onClick={clear}>Clear filters</button></>:'They appear once they book or share a phone number in chat.'}</Empty></div>}
  </>);
}
