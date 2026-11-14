import {useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {db} from '../lib/db';
import {useAuth,useTable,useToast,useClinicNow} from '../lib/hooks';
import {clinicNow,addDays,nice,clock,STATUS,held,open,conflictOf,openSlots,closedOn} from '../lib/avail';
import {DAYS,slotsFor,dateOf,hoursOn} from '../lib/schedule';
import {Icon,Empty,ago,useConfirm} from '../lib/ui';

const M=t=>{const [h,m]=t.split(':').map(Number);return h*60+m};
const hour=m=>{const h=Math.floor(m/60)%24;return `${h%12||12}${h<12?'am':'pm'}`};

/* The clinic's day on one screen: what needs a decision, who is in and when, and what is coming.
   Everything is read from the same records the other pages edit, and every item opens the place where it is handled. */
export default function Today(){
  const {user}=useAuth(),toast=useToast(),nav=useNavigate(),confirm=useConfirm(),[busy,setBusy]=useState(false);
  const [rows]=useTable('bookings'),[docs]=useTable('doctors'),[closed]=useTable('closures'),[leave]=useTable('leave'),[cv]=useTable('convos'),[al]=useTable('alerts'),[out]=useTable('outbox'),[log]=useTable('audit');
  const now=useClinicNow(user.tz),today=now.slice(0,10),nowMin=M(now.slice(11));
  const day=rows.filter(b=>held(b)&&dateOf(b.when)===today).sort((a,b)=>a.when.localeCompare(b.when));
  const shut=closedOn(today,closed,leave),left=day.filter(b=>open(b)&&b.when>=now).length;
  const requests=rows.filter(b=>b.status==='requested').sort((a,b)=>a.when.localeCompare(b.when));
  const next=rows.filter(b=>open(b)&&b.when>=now).sort((a,b)=>a.when.localeCompare(b.when)).slice(0,6);
  const handoff=cv.filter(c=>c.status==='handoff').length,unread=al.filter(a=>!a.read).length;
  const unmarked=rows.filter(b=>b.status==='booked'&&b.when<now).length;
  const conflicts=docs.length?rows.filter(b=>b.when>=now&&conflictOf(b,docs,closed,leave)).length:0;
  const unsent=out.filter(o=>(o.status==='failed'&&o.at>Date.now()-7*864e5)||(o.status==='queued'&&o.at<Date.now()-10*6e4)).length;
  const todo=[
    [requests.length,'cal',`appointment request${requests.length===1?'':'s'} to decide`,'/bookings'],
    [handoff,'chat',`chat${handoff===1?'':'s'} waiting for a person`,'/inbox'],
    [conflicts,'alert',`booking${conflicts===1?'':'s'} that no longer fit${conflicts===1?'s':''} the schedule`,'/bookings'],
    [unmarked,'clock',`past visit${unmarked===1?'':'s'} without an outcome`,'/bookings?view=list&status=booked&range=past'],
    [unread,'bell',`unread alert${unread===1?'':'s'}`,'/alerts'],
    [unsent,'alert',`text${unsent===1?'':'s'} to patients not sent`,'/activity'],
  ].filter(x=>x[0]>0);

  // Timeline window: from the first doctor in to the last one out (or the day's appointments, if they fall outside).
  const working=docs.map(d=>hoursOn(d,today)).filter(Boolean);
  let t0=Math.min(...working.map(h=>h.start),...day.map(b=>M(b.when.slice(11)))),t1=Math.max(...working.map(h=>h.end),...day.map(b=>M(b.when.slice(11))+(b.duration||30)));
  if(!isFinite(t0)||t1<=t0){t0=480;t1=1080}
  t0=Math.floor(t0/60)*60;t1=Math.ceil(t1/60)*60;
  const pos=m=>`${Math.max(0,Math.min(100,(m-t0)/(t1-t0)*100))}%`,span=(a,b)=>({left:pos(a),width:`${Math.max(0,(Math.min(b,t1)-Math.max(a,t0))/(t1-t0)*100)}%`});
  const hours=[];for(let m=t0;m<=t1;m+=60)hours.push(m);
  const week=Array.from({length:7},(_,i)=>{const d=addDays(today,i);return{d,n:rows.filter(b=>held(b)&&dateOf(b.when)===d).length,shut:closedOn(d,closed,leave)}}),peak=Math.max(1,...week.map(w=>w.n));

  const decide=async(b,ok)=>{
    if(!ok&&!await confirm({title:`Decline ${b.name}'s request?`,body:`They asked for ${nice(b.when)}. They will be told this time is not available.`,confirm:'Decline request',cancel:'Keep it',danger:true}))return;
    setBusy(true);
    try{const r=await db.bookingDecide(user.id,b.id,ok);toast(r.ok===false?'Already handled by someone else':ok?'Confirmed. The patient is being told.':'Declined. The patient is being told.')}
    catch(e){toast(e.message)}finally{setBusy(false)}
  };
  const openAppt=b=>nav(`/bookings?view=day&date=${dateOf(b.when)}&id=${b.id}`);

  return(<>
    <header><div><h1>{nice(today)}</h1><p>{shut?'The clinic is closed today.':day.length?`${day.length} appointment${day.length===1?'':'s'} today, ${left} still to come.`:'No appointments today.'}</p></div>
      <span className="hdr-actions"><Link className="btn" to="/bookings?new=1"><Icon n="plus" size={18}/>New booking</Link></span></header>

    <section className={'todo'+(todo.length?'':' clear')} aria-label="Waiting on you">
      {todo.length?todo.map(([n,ic,label,to])=><Link key={label} to={to} className="todo-i"><Icon n={ic} size={18}/><b>{n}</b><span>{label}</span><Icon n="right" size={14}/></Link>)
        :<p><Icon n="check" size={18}/>Nothing is waiting on you right now.</p>}
    </section>

    <section className="card" aria-label="Today's schedule by doctor">
      <div className="card-h"><h3>Today by doctor</h3><Link to={`/bookings?view=day&date=${today}`}>Open the day</Link></div>
      {!docs.length?<Empty icon="people" title="No doctors yet">Add your doctors in Knowledge and their day appears here.</Empty>
      :<div className="tl-wrap"><div className="tl" style={{'--cols':hours.length-1}}>
        <div className="tl-row tl-axis"><span className="tl-name"/><div className="tl-lane">{hours.map(m=><i key={m} style={{left:pos(m)}}>{hour(m)}</i>)}</div></div>
        {docs.map(d=>{
          const hrs=hoursOn(d,today),inToday=slotsFor(d,today).length>0,mine=day.filter(b=>b.doctor_id===d.id),away=leave.filter(e=>e.date===today&&e.doctor_id===d.id);
          const free=inToday&&!shut?openSlots([d],today,rows,leave,closed,{now}).length:0;
          return(<div key={d.id} className="tl-row">
            <span className="tl-name"><b>{d.name}</b><small>{shut?'Closed':!inToday?'Not in today':away.some(e=>e.start==null)?'Away':free?<Link to={`/bookings?view=day&date=${today}&doctor=${d.id}`}>{free} open</Link>:'Full'}</small></span>
            <div className="tl-lane">
              {inToday&&!shut&&<span className="tl-work" style={span(hrs.start,hrs.end)}/>}
              {away.map(e=><span key={e.id} className="tl-away" style={span(e.start??hrs?.start??M(d.start),e.end??hrs?.end??M(d.end))} title={e.note||'Away'}>Away</span>)}
              {mine.map(b=><button key={b.id} className={'tl-appt '+b.status} style={span(M(b.when.slice(11)),M(b.when.slice(11))+(b.duration||30))} onClick={()=>openAppt(b)}
                title={`${clock(b.when)} · ${b.name} · ${b.service||'appointment'} · ${STATUS[b.status]}`} aria-label={`${clock(b.when)}, ${b.name}, ${STATUS[b.status]}`}><span>{b.name}</span></button>)}
              {nowMin>=t0&&nowMin<=t1&&<span className="tl-now" style={{left:pos(nowMin)}} aria-hidden="true"/>}
            </div>
          </div>);
        })}
      </div></div>}
      <p className="legend"><span><i className="sw booked"/>Confirmed</span><span><i className="sw requested"/>Requested</span><span><i className="sw completed"/>Completed</span><span><i className="sw no_show"/>No-show</span><span><i className="sw nowl"/>Now</span></p>
    </section>

    <div className="grid2">
      <section className="card" aria-label="Requests to decide">
        <div className="card-h"><h3>Requests to decide</h3>{requests.length>3&&<Link to="/bookings">All {requests.length}</Link>}</div>
        {!requests.length?<Empty icon="check" title="No requests waiting">New website requests appear here the moment they come in.</Empty>
          :requests.slice(0,3).map(b=>{const past=b.when<now,why=conflictOf(b,docs,closed,leave);return<div key={b.id} className="req-row">
            <button className="req-main" onClick={()=>openAppt(b)}><b>{b.name}</b><span>{nice(b.when)} · {b.service||'Appointment'} · {b.doctor||'Unassigned'}</span>{(past||why)&&<small className="warn">{past?'This time has passed':why}</small>}</button>
            <div className="acts">{!past&&!why?<button className="btn sm" disabled={busy} onClick={()=>decide(b,true)}>Confirm</button>:<button className="btn sm" onClick={()=>openAppt(b)}>Review</button>}<button className="btn ghost sm" disabled={busy} onClick={()=>decide(b,false)}>Decline</button></div>
          </div>})}
      </section>
      <section className="card" aria-label="Coming up">
        <div className="card-h"><h3>Coming up</h3><Link to="/bookings?view=list">All appointments</Link></div>
        {!next.length?<Empty icon="cal" title="Nothing booked ahead">Upcoming appointments appear here.</Empty>
          :<ul className="agenda">{next.map(b=><li key={b.id}><button onClick={()=>openAppt(b)}><time>{dateOf(b.when)===today?clock(b.when):nice(b.when)}</time><b>{b.name}</b><small>{b.service||'Appointment'} · {b.doctor||'Unassigned'}</small><span className={'chip '+b.status}>{STATUS[b.status]}</span></button></li>)}</ul>}
      </section>
      <section className="card" aria-label="The week ahead">
        <div className="card-h"><h3>The week ahead</h3><Link to={`/bookings?view=week&date=${today}`}>Open the week</Link></div>
        <div className="wk">{week.map(w=><button key={w.d} className={'wk-d'+(w.d===today?' today':'')} onClick={()=>nav(`/bookings?view=day&date=${w.d}`)} aria-label={`${nice(w.d)}: ${w.shut?'closed':w.n+' appointments'}. Open this day.`}>
          <b>{w.shut?'–':w.n}</b><span className="wk-bar"><i style={{height:`${w.n/peak*100}%`}}/></span><small>{DAYS[new Date(w.d+'T00:00:00Z').getUTCDay()]}</small></button>)}</div>
      </section>
      <section className="card" aria-label="Recent activity">
        <div className="card-h"><h3>Recent activity</h3><Link to="/activity">Full log</Link></div>
        {!log.length?<Empty icon="list" title="Nothing yet">Bookings, changes and hand-offs are recorded here.</Empty>
          :<ul className="feed">{[...log].sort((a,b)=>b.at-a.at).slice(0,6).map(r=><li key={r.id}><b>{r.action}</b> {r.detail}<small>{ago(r.at)}</small></li>)}</ul>}
      </section>
    </div>
  </>);
}
