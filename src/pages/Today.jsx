import {Link} from 'react-router-dom';
import {useAuth,useTable} from '../lib/hooks';
import {clinicNow,nice,clock,STATUS,held,open,conflictOf} from '../lib/avail';
import {dateOf} from '../lib/schedule';

const Tile=({to,label,value,sub,hot})=><Link to={to} className={'card st tile'+(hot?' hot':'')}><small>{label}</small><b>{value}</b><span>{sub}</span></Link>;

/* The clinic's day at a glance. Every number is read from the same records the other pages edit, so it cannot drift from them. */
export default function Today(){
  const {user}=useAuth();
  const [rows]=useTable('bookings'),[docs]=useTable('doctors'),[closed]=useTable('closures'),[leave]=useTable('leave'),[cv]=useTable('convos'),[al]=useTable('alerts'),[out]=useTable('outbox');
  const now=clinicNow(user.tz),today=now.slice(0,10);
  const day=rows.filter(b=>held(b)&&dateOf(b.when)===today).sort((a,b)=>a.when.localeCompare(b.when));
  const left=day.filter(b=>open(b)&&b.when>=now).length;
  const requests=rows.filter(b=>b.status==='requested').length,handoff=cv.filter(c=>c.status==='handoff').length,unread=al.filter(a=>!a.read).length;
  const unmarked=rows.filter(b=>b.status==='booked'&&b.when<now).length;
  const conflicts=docs.length?rows.filter(b=>b.when>=now&&conflictOf(b,docs,closed,leave)).length:0;
  const failed=out.filter(o=>o.status==='failed'&&o.at>Date.now()-7*864e5).length,stuck=out.filter(o=>o.status==='queued'&&o.at<Date.now()-10*6e4).length;
  const away=leave.filter(e=>e.date===today&&e.doctor_id),shut=closed.some(c=>c.date===today)||leave.some(e=>e.date===today&&e.kind==='closure'&&!e.doctor_id&&e.start==null);
  return(<>
    <header><h1>Today</h1><span className="route">{nice(today)} · {user.biz}</span></header>
    <div className="tiles">
      <Tile to="/bookings" label="Appointments today" value={day.length} sub={shut?'the clinic is closed today':`${left} still to come`}/>
      <Tile to="/bookings" label="Requests to decide" value={requests} sub="from your website, waiting for you" hot={requests>0}/>
      <Tile to="/inbox" label="Chats needing a person" value={handoff} sub={`${unread} unread alert${unread===1?'':'s'}`} hot={handoff>0}/>
      <Tile to="/bookings" label="Needs attention" value={conflicts+unmarked} sub={`${conflicts} schedule conflict${conflicts===1?'':'s'} · ${unmarked} without an outcome`} hot={conflicts>0}/>
      <Tile to="/activity" label="Texts not sent" value={failed+stuck} sub={stuck?`${stuck} waiting over 10 minutes: check the text provider`:`${failed} failed in the last 7 days`} hot={failed+stuck>0}/>
    </div>
    <div className="grid2" style={{marginTop:16}}>
      <section className="card st"><h3>Today's schedule</h3>
        {!day.length?<div className="empty">{shut?'Closed today.':'No appointments today.'}</div>
          :<ul className="feed">{day.map(b=><li key={b.id}><b>{clock(b.when)}</b> {b.name} · {b.service||'appointment'} · {b.doctor||'Unassigned'}
            <small><span className={'chip '+b.status}>{b.status==='booked'&&b.when<now?'Needs an outcome':STATUS[b.status]}</span></small></li>)}</ul>}
        <p className="route"><Link to="/bookings">Open bookings</Link></p>
      </section>
      <section className="card st"><h3>Who is away today</h3>
        {!away.length?<div className="empty">Everyone scheduled is in.</div>
          :<ul className="feed">{away.map(e=><li key={e.id}><b>{e.who}</b> {e.start!=null?'part of the day':'all day'}<small>{e.note}</small></li>)}</ul>}
      </section>
    </div>
  </>);
}
