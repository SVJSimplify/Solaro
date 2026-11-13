import {useEffect} from 'react';
import {Link,Outlet,useLocation} from 'react-router-dom';
import {useAuth,useTable} from '../lib/hooks';import {Logo} from '../lib/ui';
import {db,isLive} from '../lib/db';
import {runReminders} from '../lib/outbox';
const T=[['today','Today'],['inbox','Inbox'],['alerts','Alerts'],['customers','Customers'],['bookings','Bookings'],['insights','Insights'],['knowledge','Knowledge'],['activity','Activity'],['settings','Settings']];

export default function Layout(){
  const {user,signOut,switchOrg}=useAuth(),loc=useLocation(),[cv]=useTable('convos'),[al]=useTable('alerts'),[bk]=useTable('bookings');
  // Live: the database queues reminders on its own schedule. Only the browser-only demo still runs them here.
  useEffect(()=>{if(isLive)return;const run=()=>runReminders(db,user.id).catch(()=>{});run();const t=setInterval(run,60000);return()=>clearInterval(t)},[user.id]);
  const n=cv.filter(c=>c.status==='handoff').length,unread=al.filter(a=>!a.read).length,req=bk.filter(b=>b.status==='requested').length;
  return(
    <div id="app" className="in">
      <aside><Logo/>
        <nav id="tabs" style={{display:'contents'}}>
          {[...T,...(user.platformAdmin?[['admin','Admin']]:[])].map(([p,l])=><Link key={p} to={'/'+p} className="tab" aria-selected={loc.pathname==='/'+p}>{l}{p==='inbox'&&n>0&&<span className="badge" key={n}>{n}</span>}{p==='alerts'&&unread>0&&<span className="badge" key={unread}>{unread}</span>}{p==='bookings'&&req>0&&<span className="badge" key={'r'+req} aria-label={req+' appointment requests'}>{req}</span>}</Link>)}
        </nav>
        <div className="who">{user.orgs?.length>1?<select aria-label="Clinic" value={user.org} onChange={e=>switchOrg(e.target.value)}>{user.orgs.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>:<div>{user.biz}</div>}<div>{user.email}</div><button onClick={signOut}>Sign out</button></div>
      </aside>
      <main><div className="vw" key={loc.pathname}><Outlet/></div></main>
    </div>
  );
}
