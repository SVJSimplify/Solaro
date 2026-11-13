import {useTable} from '../lib/hooks';
import {phoneOf} from '../lib/reasons';
import {ago} from '../lib/ui';

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
  return(<>
    <header><h1>Customers</h1><button className="btn ghost sm" onClick={exportCsv} disabled={!rows.length}>Export CSV</button></header>
    <div className="card st">
      {rows.length?<table><thead><tr><th>Name</th><th>Phone</th><th>Past visits</th><th>Next</th><th>Chats</th><th>Last chat</th></tr></thead><tbody>
        {rows.map(r=><tr key={r.phone+r.name}><td>{r.name}</td><td>{r.phone}</td><td>{r.visits}</td><td>{r.next?r.next.replace('T',' '):'—'}</td><td>{r.chats}</td><td>{r.lastChat?ago(r.lastChat):'—'}</td></tr>)}
      </tbody></table>:<div className="empty">No customers yet. They appear once they book or share a phone number in chat.</div>}
    </div>
  </>);
}
