import {useMemo,useState} from 'react';
import {db} from '../lib/db';
import {useAuth,useTable,useToast} from '../lib/hooks';
import {DAYS,slotsFor,dateOf} from '../lib/schedule';
import {clinicNow,nice,clock,STATUS,held,open,awayAt,closedOn,openSlots,conflictOf} from '../lib/avail';
import DateTimePicker from '../lib/DateTimePicker';
import {audit} from '../lib/audit';
import {normalizePhone} from '../lib/phone';

const tel=p=>'tel:'+String(p||'').replace(/[^\d+]/g,'');
const SOURCE={staff:'Front desk',assistant:'Staff assistant',website:'Website chat'};
const MSG={queued:'waiting to send',processing:'sending',sent:'sent',failed:'not sent'};
const KIND={confirmation:'Confirmation',decline:'Decline',reschedule:'New time',cancellation:'Cancellation',reminder:'Reminder',message:'Message'};
const blank={name:'',phone:'',service:'',doctor_id:'',when:''};

/* A day, then only the times that are really open on it. Nobody types a time. */
function SlotPicker({docs,rows,leave,closed,now,service,doctorId,skipId,hide,sel,date,setDate,onPick,busy}){
  const slots=openSlots(docs,date,rows,leave,closed,{service,doctorId,now,skipId}).filter(s=>!(hide&&s.when===hide.when&&s.doctor.id===hide.doctor_id));
  return(<>
    <DateTimePicker mode="date" value={date} onChange={v=>v&&setDate(v)} label="Day"/>
    {closedOn(date,closed,leave)?<p className="route">The clinic is closed that day.</p>
      :!slots.length?<p className="route">No open times that day{service?` for ${service}`:''}. Try another day.</p>
      :<div className="slots" role="group" aria-label="Open times">{slots.map(s=>{const on=sel&&sel.when===s.when&&sel.doctor_id===s.doctor.id;
        return<button type="button" key={s.doctor.id+s.when} className={'slot '+(on?'booked':'free')} aria-pressed={!!on} disabled={busy} onClick={()=>onPick(s)}><b>{clock(s.when)}</b> {s.doctor.name}</button>})}</div>}
  </>);
}

/* The clinic's appointments: requests to decide, the day by doctor, a searchable list, and every action on an appointment.
   Each action is one server transaction (change + audit + patient message); the database re-checks every slot. */
export default function Bookings(){
  const {user}=useAuth(),toast=useToast();
  const [docs]=useTable('doctors'),[rows]=useTable('bookings'),[closed]=useTable('closures'),[svc]=useTable('services'),[leave]=useTable('leave'),[out]=useTable('outbox');
  const now=clinicNow(user.tz),today=now.slice(0,10),manager=!user.role||user.role==='owner'||user.role==='admin';
  const [date,setDate]=useState(today),[view,setView]=useState('day'),[pickId,setPickId]=useState(null),[busy,setBusy]=useState(false);
  const [flt,setFlt]=useState({q:'',status:'open',doctor:'',range:'upcoming'});
  const [f,setF]=useState(blank),[fd,setFd]=useState(today),[move,setMove]=useState(null),[cd,setCd]=useState('');
  const pick=rows.find(b=>b.id===pickId)||null;
  const run=async(fn,done)=>{setBusy(true);try{done?.(await fn())}catch(e){toast(e.message)}finally{setBusy(false)}};

  const requests=rows.filter(b=>b.status==='requested').sort((a,b)=>a.when.localeCompare(b.when));
  const conflicts=useMemo(()=>docs.length?rows.filter(b=>b.when>=now).map(b=>[b,conflictOf(b,docs,closed,leave)]).filter(x=>x[1]):[],[rows,docs,closed,leave,now]);
  const unmarked=rows.filter(b=>b.status==='booked'&&b.when<now).length;
  const day=rows.filter(b=>held(b)&&dateOf(b.when)===date),dayClosed=closedOn(date,closed,leave);
  const list=useMemo(()=>{
    const q=flt.q.trim().toLowerCase(),qd=q.replace(/\D/g,'');
    return rows.filter(b=>(flt.status==='all'||(flt.status==='open'?open(b):b.status===flt.status))
      &&(!flt.doctor||b.doctor_id===flt.doctor)
      &&(flt.range==='all'||(flt.range==='today'?dateOf(b.when)===today:flt.range==='upcoming'?b.when>=now:b.when<now))
      &&(!q||b.name.toLowerCase().includes(q)||(qd.length>=3&&String(b.phone).replace(/\D/g,'').includes(qd))))
      .sort((a,b)=>flt.range==='past'?b.when.localeCompare(a.when):a.when.localeCompare(b.when));
  },[rows,flt,now,today]);

  const decide=(b,ok)=>run(()=>db.bookingDecide(user.id,b.id,ok),r=>toast(r.ok===false?'Already handled by someone else':ok?'Confirmed. The patient is being told.':'Declined. The patient is being told.'));
  const cancel=b=>{if(window.confirm(`Cancel ${b.name}'s appointment on ${nice(b.when)}? The patient will be told.`))run(()=>db.bookingCancel(user.id,b.id),()=>toast('Cancelled'))};
  const mark=(b,s)=>run(()=>db.bookingStatus(user.id,b.id,s),()=>toast(s==='booked'?'Reopened':'Marked '+STATUS[s].toLowerCase()));
  const doMove=(b,s)=>run(()=>db.bookingReschedule(user.id,b.id,s.when,s.doctor.id),()=>{setMove(null);toast(`Moved to ${nice(s.when)} with ${s.doctor.name}`)});
  const service=f.service||svc[0]?.name||'';
  const book=e=>{
    e.preventDefault();
    const phone=normalizePhone(f.phone);
    if(!phone)return toast('Enter a valid US or Indian phone number');
    if(!f.when)return toast('Pick one of the open times');
    run(()=>db.bookingCreate(user.id,{name:f.name.trim(),phone,service,when:f.when,doctor_id:f.doctor_id}),r=>{setF(blank);toast(`Booked with ${r.doctor}`)});
  };
  const startBooking=(d,when)=>{setFd(dateOf(when));setF({...f,when,doctor_id:d.id,service:d.services.includes(service)?service:d.services[0]||''});document.getElementById('bn')?.focus()};
  const closeDay=async()=>{
    if(!cd)return;if(closed.some(c=>c.date===cd))return toast('Already closed that day');
    const n=rows.filter(b=>open(b)&&dateOf(b.when)===cd).length;
    await db.add('closures',user.id,{date:cd});await audit(db,user.id,'closed day',cd);setCd('');
    toast(n?`Day closed. ${n} appointment${n>1?'s':''} that day now need${n>1?'':'s'} moving or cancelling.`:'Day closed');
  };
  const reopen=async c=>{await db.del('closures',c.id);await audit(db,user.id,'reopened day',c.date)};
  const saveDoc=(d,p)=>db.patch('doctors',d.id,p).catch(e=>toast(e.message));
  const toggleDay=(d,n)=>saveDoc(d,{days:d.days.includes(n)?d.days.filter(x=>x!==n):[...d.days,n].sort()});
  const F=k=>e=>setFlt({...flt,[k]:e.target.value});
  const offers=s=>docs.filter(d=>!s||d.services.includes(s));
  const chip=b=><span className={'chip '+b.status}>{STATUS[b.status]||b.status}</span>;

  const detail=pick&&(()=>{
    const past=pick.when<now,why=conflictOf(pick,docs,closed,leave),msgs=out.filter(o=>o.booking_id===pick.id).sort((a,b)=>a.at-b.at);
    return(<section className="card st detail" aria-label="Appointment details"><h3>{pick.name} {chip(pick)}</h3>
      {why&&<p className="warn" role="alert">{why}. Move or cancel this appointment.</p>}
      <dl>
        <dt>When</dt><dd>{nice(pick.when)}{past&&open(pick)?' · time has passed':''}</dd>
        <dt>Phone</dt><dd><a href={tel(pick.phone)}>{pick.phone}</a></dd>
        <dt>Service</dt><dd>{pick.service||'Not set'}</dd>
        <dt>Doctor</dt><dd>{pick.doctor||'Unassigned'}</dd>
        <dt>Booked through</dt><dd>{SOURCE[pick.source]||'Front desk'}{pick.created?` · ${new Date(pick.created).toLocaleDateString([],{month:'short',day:'numeric'})}`:''}</dd>
        <dt>Patient told</dt><dd>{msgs.length?msgs.map(m=><div key={m.id}>{KIND[m.kind]||'Message'}: {MSG[m.status]||m.status}{m.status==='failed'&&m.error?` (${m.error})`:''}</div>):'No messages for this appointment'}</dd>
      </dl>
      <div className="acts">
        {pick.status==='requested'&&<><button className="btn sm" disabled={busy||past||!!why} onClick={()=>decide(pick,true)}>Confirm</button><button className="btn ghost sm" disabled={busy} onClick={()=>decide(pick,false)}>Decline</button></>}
        {pick.status==='booked'&&past&&<><button className="btn sm" disabled={busy} onClick={()=>mark(pick,'completed')}>Completed</button><button className="btn ghost sm" disabled={busy} onClick={()=>mark(pick,'no_show')}>No-show</button></>}
        {(pick.status==='completed'||pick.status==='no_show')&&<button className="btn ghost sm" disabled={busy} onClick={()=>mark(pick,'booked')}>Undo</button>}
        {open(pick)&&<button className="btn ghost sm" disabled={busy} aria-expanded={!!move} onClick={()=>setMove(move?null:{date:past?today:dateOf(pick.when),doctor_id:''})}>{move?'Keep this time':'Move'}</button>}
        {pick.status==='booked'&&<button className="btn ghost sm" disabled={busy} onClick={()=>cancel(pick)}>Cancel booking</button>}
        <button className="btn ghost sm" onClick={()=>{setPickId(null);setMove(null)}}>Close</button>
      </div>
      {move&&open(pick)&&<div className="move"><h4>Move to an open time</h4>
        <div className="f"><label htmlFor="mvd">Doctor</label><select id="mvd" value={move.doctor_id} onChange={e=>setMove({...move,doctor_id:e.target.value})}><option value="">Any doctor{pick.service?` offering ${pick.service}`:''}</option>{offers(pick.service).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        <SlotPicker docs={docs} rows={rows} leave={leave} closed={closed} now={now} service={pick.service} doctorId={move.doctor_id||undefined} skipId={pick.id} hide={pick} date={move.date} setDate={v=>setMove({...move,date:v})} onPick={s=>doMove(pick,s)} busy={busy}/>
      </div>}
    </section>);
  })();

  return(<>
    <header><h1>Bookings</h1>
      <div className="seg" role="group" aria-label="View">{[['day','Day'],['list','List']].map(([v,l])=><button key={v} type="button" className={'btn sm'+(v===view?'':' ghost')} aria-pressed={v===view} onClick={()=>setView(v)}>{l}</button>)}</div>
    </header>

    {requests.length>0&&<section className="card st requests" aria-label="Appointment requests">
      <h3>Appointment requests <span className="badge">{requests.length}</span></h3>
      <p className="route">Requested from your website. Nothing is confirmed until you confirm it.</p>
      {requests.map(b=>{const past=b.when<now,why=conflictOf(b,docs,closed,leave);return<div key={b.id} className="req-row">
        <div><button className="lk" onClick={()=>setPickId(b.id)}><b>{b.name}</b></button> · {b.service} · {b.doctor||'Unassigned'}<br/><small>{nice(b.when)}{past?' · time has passed':why?` · ${why}`:''} · <a href={tel(b.phone)}>{b.phone}</a></small></div>
        <div className="acts">
          {!past&&!why&&<button className="btn sm" disabled={busy} onClick={()=>decide(b,true)}>Confirm</button>}
          <button className="btn ghost sm" disabled={busy} onClick={()=>{setPickId(b.id);setMove({date:past?today:dateOf(b.when),doctor_id:''})}}>Move</button>
          <button className="btn ghost sm" disabled={busy} onClick={()=>decide(b,false)}>Decline</button>
        </div>
      </div>})}
    </section>}

    {conflicts.length>0&&<section className="card st requests" aria-label="Schedule conflicts">
      <h3>Needs attention <span className="badge">{conflicts.length}</span></h3>
      <p className="route">The schedule changed after these were booked. Move or cancel each one.</p>
      {conflicts.map(([b,why])=><div key={b.id} className="req-row">
        <div><b>{b.name}</b> · {nice(b.when)} · {b.doctor||'Unassigned'}<br/><small className="warn">{why}</small></div>
        <div className="acts"><button className="btn sm" onClick={()=>{setPickId(b.id);setMove({date:dateOf(b.when),doctor_id:''})}}>Move</button></div>
      </div>)}
    </section>}

    {unmarked>0&&<p className="route"><button className="lk" onClick={()=>{setView('list');setFlt({q:'',status:'booked',doctor:'',range:'past'})}}>{unmarked} past appointment{unmarked>1?'s':''} still need{unmarked>1?'':'s'} an outcome</button> (completed or no-show). Insights counts only what is marked.</p>}

    {detail}

    {view==='day'&&<>
      <div className="daynav"><button className="btn ghost sm" onClick={()=>setDate(today)} disabled={date===today}>Today</button><DateTimePicker mode="date" value={date} onChange={v=>v&&setDate(v)} label="Day"/><span className="route">{nice(date)} · {day.length} appointment{day.length===1?'':'s'}{dayClosed?' · closed':''}</span></div>
      <div className="docs">
        {docs.map(d=>{
          const mine=day.filter(b=>b.doctor_id===d.id),slots=slotsFor(d,date),extra=mine.filter(b=>!slots.includes(b.when));
          const cell=b=><button key={b.id} className={'slot booked'+(b.status==='requested'?' req':b.status==='booked'?'':' '+b.status)} onClick={()=>setPickId(b.id)}><b>{clock(b.when)}</b> {b.name}{b.status==='requested'?' · request':b.status==='booked'?'':' · '+STATUS[b.status].toLowerCase()}</button>;
          return(<div key={d.id} className="card st">
            <h3>{d.name} <small>{d.specialty}</small></h3>
            <small>{d.start}–{d.end} · {mine.length} booked</small>
            {dayClosed&&!mine.length?<div className="empty">Clinic closed.</div>:slots.length||extra.length
              ?<div className="slots">{slots.map(s=>{
                const b=mine.find(x=>x.when===s),away=!b&&awayAt(d,s,leave);
                return b?cell(b)
                  :away||dayClosed?<span key={s} className="slot off" title={away?.note||''}><b>{clock(s)}</b> {dayClosed?'closed':'away'}</span>
                  :s<now?<span key={s} className="slot off"><b>{clock(s)}</b></span>
                  :<button key={s} className="slot free" onClick={()=>startBooking(d,s)}><b>{clock(s)}</b> free</button>;
              })}{extra.map(cell)}</div>
              :<div className="empty">Not working on this day.</div>}
          </div>);
        })}
        {day.some(b=>!docs.some(d=>d.id===b.doctor_id))&&docs.length>0&&<div className="card st"><h3>Unassigned</h3>
          <div className="slots">{day.filter(b=>!docs.some(d=>d.id===b.doctor_id)).map(b=><button key={b.id} className="slot booked" onClick={()=>setPickId(b.id)}><b>{clock(b.when)}</b> {b.name}</button>)}</div>
        </div>}
      </div>
    </>}

    {view==='list'&&<section className="card st" aria-label="All appointments">
      <div className="filters">
        <input type="search" placeholder="Search name or phone" aria-label="Search name or phone" value={flt.q} onChange={F('q')}/>
        <select aria-label="When" value={flt.range} onChange={F('range')}><option value="upcoming">Upcoming</option><option value="today">Today</option><option value="past">Past</option><option value="all">Any time</option></select>
        <select aria-label="Status" value={flt.status} onChange={F('status')}><option value="open">Requested and confirmed</option>{Object.entries(STATUS).map(([k,l])=><option key={k} value={k}>{l}</option>)}<option value="all">Every status</option></select>
        <select aria-label="Doctor" value={flt.doctor} onChange={F('doctor')}><option value="">All doctors</option>{docs.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>
      </div>
      {list.length?<div className="tblwrap"><table className="tbl">
        <thead><tr><th>When</th><th>Patient</th><th>Service</th><th>Doctor</th><th>Status</th></tr></thead>
        <tbody>{list.slice(0,300).map(b=><tr key={b.id} className={b.id===pickId?'on':''} onClick={()=>{setPickId(b.id);setMove(null);window.scrollTo({top:0,behavior:'smooth'})}}>
          <td>{nice(b.when)}</td><td><button className="lk">{b.name}</button><br/><small>{b.phone}</small></td><td>{b.service}</td><td>{b.doctor||'Unassigned'}</td><td>{chip(b)}</td></tr>)}</tbody>
      </table></div>:<div className="empty">No appointments match.</div>}
      <p className="route">{list.length>300?`Showing the first 300 of ${list.length}. Narrow the search to see the rest.`:`${list.length} appointment${list.length===1?'':'s'}`} · history covers the last 180 days.</p>
    </section>}

    <div className="grid2">
      <form className="card st" onSubmit={book}><h3>New booking</h3>
        <div className="f"><label htmlFor="bn">Patient</label><input id="bn" required value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></div>
        <div className="f"><label htmlFor="bp">Phone</label><input id="bp" type="tel" required value={f.phone} onChange={e=>setF({...f,phone:e.target.value})}/></div>
        <div className="f"><label htmlFor="bs">Service</label><select id="bs" value={service} onChange={e=>setF({...f,service:e.target.value,when:'',doctor_id:''})}>{svc.map(s=><option key={s.id}>{s.name}</option>)}</select></div>
        <div className="f"><span className="flabel">Open times</span>
          <SlotPicker docs={docs} rows={rows} leave={leave} closed={closed} now={now} service={service} sel={f.when?f:null} date={fd} setDate={v=>{setFd(v);setF({...f,when:'',doctor_id:''})}} onPick={s=>setF({...f,when:s.when,doctor_id:s.doctor.id})} busy={busy}/></div>
        <p className="route">{f.when?`${nice(f.when)} with ${docs.find(d=>d.id===f.doctor_id)?.name||'a doctor'}. The patient gets a text confirmation.`:'Pick one of the open times.'}</p>
        <button className={'btn'+(busy?' busy':'')} disabled={busy||!f.when}>Add booking</button>
      </form>

      <div className="card st"><h3>Closed days</h3>
        <p className="route">No bookings can be made on a closed day.</p>
        <DateTimePicker mode="date" value={cd} onChange={setCd} label="Closed day"/>
        <button className="btn sm" type="button" onClick={closeDay} disabled={!cd} style={{marginTop:8}}>Close this day</button>
        <div className="closed-list">{closed.map(c=><div key={c.id} className="closed-row"><span>{c.date}</span><button className="btn ghost sm" type="button" onClick={()=>reopen(c)}>Reopen</button></div>)}{!closed.length&&<p className="route">No closed days.</p>}</div>
        {leave.some(e=>e.doctor_id&&e.date>=today)&&<><h3 style={{marginTop:16}}>Time away</h3>
          <div className="closed-list">{leave.filter(e=>e.doctor_id&&e.date>=today).slice(0,12).map(e=><div key={e.id} className="closed-row"><span>{nice(e.date)} · {e.who}{e.start!=null?' · part of the day':''}</span><small>{e.note}</small></div>)}</div></>}
      </div>

      <div className="card st"><h3>Doctor schedules</h3>
        {!manager&&<p className="route">Only an owner or admin can change schedules.</p>}
        {docs.map(d=>(<div key={d.id} className="sched">
          <b>{d.name}</b>
          <div className="days">{DAYS.map((n,i)=>(
            <label key={i}><input type="checkbox" disabled={!manager} checked={d.days.includes(i)} onChange={()=>toggleDay(d,i)}/>{n}</label>))}</div>
          <div className="hours">
            <input type="time" disabled={!manager} value={d.start} onChange={e=>saveDoc(d,{start:e.target.value})} aria-label={d.name+' start'}/>
            <span>to</span>
            <input type="time" disabled={!manager} value={d.end} onChange={e=>saveDoc(d,{end:e.target.value})} aria-label={d.name+' end'}/>
          </div>
        </div>))}
      </div>
    </div>
  </>);
}
