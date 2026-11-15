import {useEffect,useState} from 'react';
import {Link,Outlet,useLocation} from 'react-router-dom';
import {useAuth,useTable} from '../lib/hooks';import {Logo,Icon,Drawer} from '../lib/ui';
import {db,isLive} from '../lib/db';
import {runReminders} from '../lib/outbox';

/* Grouped by how the front desk works: the day's work, the records behind it, then setup. */
const NAV=[
  [['today','Today','sun'],['inbox','Inbox','chat'],['bookings','Bookings','cal'],['alerts','Alerts','bell']],
  [['customers','Patients','people'],['insights','Insights','chart'],['activity','Activity','list']],
  [['knowledge','Knowledge','book'],['install','Website chat','globe'],['settings','Settings','gear'],['help','Help','help']],
];

export default function Layout(){
  const {user,signOut,switchOrg}=useAuth(),loc=useLocation(),[cv]=useTable('convos'),[al]=useTable('alerts'),[bk]=useTable('bookings');
  const [more,setMore]=useState(false);
  // Live: the database queues reminders on its own schedule. Only the browser-only demo still runs them here.
  useEffect(()=>{if(isLive)return;const run=()=>runReminders(db,user.id).catch(()=>{});run();const t=setInterval(run,60000);return()=>clearInterval(t)},[user.id]);
  useEffect(()=>setMore(false),[loc.pathname]);
  const count={inbox:cv.filter(c=>c.status==='handoff').length,alerts:al.filter(a=>!a.read).length,bookings:bk.filter(b=>b.status==='requested').length};
  const what={inbox:'chats need a person',alerts:'unread alerts',bookings:'appointment requests'};
  const groups=user.platformAdmin?[...NAV,[['admin','Admin','shield']]]:NAV,here=loc.pathname.split('/')[1];
  const item=([p,l,ic])=><Link key={p} to={'/'+p} className={'tab'+(here===p?' on':'')} aria-current={here===p?'page':undefined}>
    <Icon n={ic}/><span>{l}</span>{count[p]>0&&<span className="badge" aria-label={`${count[p]} ${what[p]}`}>{count[p]}</span>}</Link>;
  const clinic=user.orgs?.length>1
    ?<select aria-label="Clinic" value={user.org} onChange={e=>switchOrg(e.target.value)}>{user.orgs.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
    :<b>{user.biz}</b>;
  const title=groups.flat().find(x=>x[0]===here)?.[1]||'Solara';
  return(
    <div id="app" className="in">
      <aside>
        <Logo/>
        <Link to="/bookings?new=1" className="btn side-cta"><Icon n="plus" size={18}/>New booking</Link>
        <nav aria-label="Main">{groups.map((g,i)=><div key={i} className="navg">{g.map(item)}</div>)}</nav>
        <div className="who">{clinic}<span>{user.email}</span><button onClick={signOut}>Sign out</button></div>
      </aside>
      <div className="topbar"><Logo/><span>{title}</span></div>
      <main><div className="vw" key={loc.pathname}><Outlet/></div></main>
      <nav className="botnav" aria-label="Main">
        {groups[0].map(item)}
        <button className={'tab'+(groups.slice(1).flat().some(x=>x[0]===here)?' on':'')} onClick={()=>setMore(true)} aria-haspopup="dialog"><Icon n="more"/><span>More</span></button>
      </nav>
      {more&&<Drawer title="More" sub={user.email} onClose={()=>setMore(false)}>
        <nav className="sheetnav" aria-label="More pages">{groups.slice(1).map((g,i)=><div key={i} className="navg">{g.map(item)}</div>)}</nav>
        <div className="who">{clinic}<button className="btn ghost sm" onClick={signOut}>Sign out</button></div>
      </Drawer>}
    </div>
  );
}
