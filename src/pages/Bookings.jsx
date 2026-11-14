import {useEffect,useMemo,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {db} from '../lib/db';
import {useAuth,useTable,useToast} from '../lib/hooks';
import {DAYS,slotsFor,dateOf} from '../lib/schedule';
import {clinicNow,addDays,nice,clock,STATUS,held,open,awayAt,closedOn,openSlots,conflictOf} from '../lib/avail';
import DateButton from '../lib/DateButton';
import {audit} from '../lib/audit';
import {Field,PhoneField,problem,phoneProblem} from '../lib/fields';
import {Icon,Drawer,Empty,useConfirm} from '../lib/ui';

const tel=p=>'tel:'+String(p||'').replace(/[^\d+]/g,'');
const SOURCE={staff:'Front desk',assistant:'Staff assistant',website:'Website chat'};
const MSG={queued:'waiting to send',processing:'sending',sent:'sent',failed:'not sent'};
const KIND={confirmation:'Confirmation',decline:'Decline',reschedule:'New time',cancellation:'Cancellation',reminder:'Reminder',message:'Message'};
const VIEWS=[['day','Day'],['week','Week'],['list','List'],['hours','Hours']];
const blank={name:'',phone:'',service:'',doctor_id:'',when:''};
const dow=d=>new Date(d+'T00:00:00Z').getUTCDay();
const byWhen=(a,b)=>a.when.localeCompare(b.when);

export const Chip=({b,past})=><span className={'chip '+b.status}>{b.status==='booked'&&past?'Needs an outcome':STATUS[b.status]||b.status}</span>;

/* A day, then only the times that are really open on it. Nobody types a time. */
function SlotPicker({docs,rows,leave,closed,now,service,doctorId,skipId,hide,sel,date,setDate,onPick,busy}){
  const slots=openSlots(docs,date,rows,leave,closed,{service,doctorId,now,skipId}).filter(s=>!(hide&&s.when===hide.when&&s.doctor.id===hide.doctor_id));
  return(<>
    <div className="datenav"><button type="button" className="btn icon ghost" aria-label="Previous day" onClick={()=>setDate(addDays(date,-1))}><Icon n="left" size={18}/></button>
      <DateButton value={date} onChange={setDate} label={nice(date)}/>
      <button type="button" className="btn icon ghost" aria-label="Next day" onClick={()=>setDate(addDays(date,1))}><Icon n="right" size={18}/></button></div>
    {closedOn(date,closed,leave)?<p className="route">The clinic is closed that day.</p>
      :!slots.length?<p className="route">No open times that day{service?` for ${service}`:''}. Try another day.</p>
      :<div className="slots pick" role="group" aria-label="Open times">{slots.map(s=>{const on=sel&&sel.when===s.when&&sel.doctor_id===s.doctor.id;
        return<button type="button" key={s.doctor.id+s.when} className={'slot '+(on?'sel':'free')} aria-pressed={!!on} disabled={busy} onClick={()=>onPick(s)} title={`${clock(s.when)} with ${s.doctor.name}`}><b>{clock(s.when)}</b><span className="slot-who">{s.doctor.name}</span></button>})}</div>}
  </>);
}

/* Where an appointment is in its life: requested, confirmed, then the outcome of the visit. */
function Lifecycle({b}){
  if(b.status==='cancelled')return<p className="life-x">Cancelled. The time is open again.</p>;
  const at=b.status==='requested'?0:b.status==='booked'?1:2;
  const steps=[b.source==='website'?'Requested':'Booked',b.status==='requested'?'Waiting for you':'Confirmed',b.status==='no_show'?'No-show':b.status==='completed'?'Completed':'Visit'];
  return<ol className="life" aria-label="Appointment progress">{steps.map((s,i)=><li key={i} className={i<at?'done':i===at?'now':''} aria-current={i===at?'step':undefined}>{s}</li>)}</ol>;
}

/* The appointment workspace: what needs a decision, the day or week by doctor, a searchable list, and every action on an
   appointment in one side panel. Each action is one server transaction, and the database re-checks every slot. */
export default function Bookings(){
  const {user}=useAuth(),toast=useToast(),confirm=useConfirm(),[sp,setSp]=useSearchParams();
  const [docs]=useTable('doctors'),[rows]=useTable('bookings'),[closed]=useTable('closures'),[svc]=useTable('services'),[leave]=useTable('leave'),[out]=useTable('outbox');
  const now=clinicNow(user.tz),today=now.slice(0,10),manager=!user.role||user.role==='owner'||user.role==='admin';
  // View, day and the open appointment live in the address, so Today and Insights can link straight to them and Back works.
  const view=VIEWS.some(v=>v[0]===sp.get('view'))?sp.get('view'):'day',date=/^\d{4}-\d\d-\d\d$/.test(sp.get('date')||'')?sp.get('date'):today,pickId=sp.get('id');
  const go=patch=>setSp(p=>{const n=new URLSearchParams(p);for(const [k,v] of Object.entries(patch))v==null||v===''?n.delete(k):n.set(k,v);return n},{replace:true});
  const [busy,setBusy]=useState(false),[allReq,setAllReq]=useState(false),[allCon,setAllCon]=useState(false),[move,setMove]=useState(null),[cd,setCd]=useState(''),[desc,setDesc]=useState(false);
  const [flt,setFlt]=useState(()=>({q:sp.get('q')||'',status:sp.get('status')||'open',doctor:sp.get('doctor')||'',range:sp.get('range')||'upcoming',service:sp.get('service')||''}));
  const [f,setF]=useState(blank),[fd,setFd]=useState(date),[adding,setAdding]=useState(sp.get('new')==='1'),[tried,setTried]=useState(false);
  // A link may name the doctor (Insights does); turn it into the filter once doctors have loaded.
  useEffect(()=>{const n=sp.get('dn');if(n&&docs.length){const d=docs.find(x=>x.name===n);if(d)setFlt(x=>({...x,doctor:d.id}));go({dn:null})}},[docs]);
  const pick=rows.find(b=>b.id===pickId)||null;
  const run=async(fn,done)=>{setBusy(true);try{done?.(await fn())}catch(e){toast(e.message)}finally{setBusy(false)}};
  const shown=flt.doctor?docs.filter(d=>d.id===flt.doctor):docs,mine=b=>!flt.doctor||b.doctor_id===flt.doctor;

  const requests=rows.filter(b=>b.status==='requested').sort(byWhen);
  const conflicts=useMemo(()=>docs.length?rows.filter(b=>b.when>=now).map(b=>[b,conflictOf(b,docs,closed,leave)]).filter(x=>x[1]):[],[rows,docs,closed,leave,now]);
  const unmarked=rows.filter(b=>b.status==='booked'&&b.when<now).length;
  const day=rows.filter(b=>held(b)&&dateOf(b.when)===date),dayClosed=closedOn(date,closed,leave);
  const list=useMemo(()=>{
    const q=flt.q.trim().toLowerCase(),qd=q.replace(/\D/g,'');
    return rows.filter(b=>(flt.status==='all'||(flt.status==='open'?open(b):b.status===flt.status))
      &&(!flt.doctor||b.doctor_id===flt.doctor)&&(!flt.service||b.service===flt.service)
      &&(flt.range==='all'||(flt.range==='today'?dateOf(b.when)===today:flt.range==='upcoming'?b.when>=now:b.when<now))
      &&(!q||b.name.toLowerCase().includes(q)||(qd.length>=3&&String(b.phone).replace(/\D/g,'').includes(qd))))
      .sort((a,b)=>(flt.range==='past')!==desc?b.when.localeCompare(a.when):a.when.localeCompare(b.when));
  },[rows,flt,now,today,desc]);

  const decide=(b,ok)=>run(()=>db.bookingDecide(user.id,b.id,ok),r=>toast(r.ok===false?'Already handled by someone else':ok?'Confirmed. The patient is being told.':'Declined. The patient is being told.'));
  const decline=async b=>{if(await confirm({title:`Decline ${b.name}'s request?`,body:`They asked for ${nice(b.when)}. They will be told this time is not available and invited to pick another.`,confirm:'Decline request',cancel:'Keep it',danger:true}))decide(b,false)};
  const cancel=async b=>{if(await confirm({title:`Cancel ${b.name}'s appointment?`,body:`${nice(b.when)} with ${b.doctor||'no doctor assigned'}. The patient will be told and the time opens up again.`,confirm:'Cancel appointment',cancel:'Keep it',danger:true}))run(()=>db.bookingCancel(user.id,b.id),()=>toast('Cancelled. The patient is being told.'))};
  const mark=(b,s)=>run(()=>db.bookingStatus(user.id,b.id,s),()=>toast(s==='booked'?'Reopened':'Marked '+STATUS[s].toLowerCase()));
  const doMove=(b,s)=>run(()=>db.bookingReschedule(user.id,b.id,s.when,s.doctor.id),()=>{setMove(null);toast(`Moved to ${nice(s.when)} with ${s.doctor.name}`)});
  const service=f.service||svc[0]?.name||'';
  const book=e=>{
    e.preventDefault();
    setTried(true);
    const wrong=(!f.when&&'Pick one of the open times.')||problem('person',f.name,{label:'Patient name'})||phoneProblem(f.phone);
    if(wrong)return toast(wrong);
    const phone=f.phone;
    run(()=>db.bookingCreate(user.id,{name:f.name.trim(),phone,service,when:f.when,doctor_id:f.doctor_id}),r=>{setF(blank);setTried(false);setAdding(false);go({new:null});toast(`Booked with ${r.doctor}. A text confirmation is queued.`)});
  };
  const openNew=(d,when,doc)=>{setFd(d||date);setF({...f,when:when||'',doctor_id:doc?.id||'',service:doc?(doc.services.includes(service)?service:doc.services[0]||''):f.service});setAdding(true)};
  const openAppt=(b,moving)=>{go({id:b.id});setMove(moving?{date:b.when<now?today:dateOf(b.when),doctor_id:''}:null)};
  const closeAppt=()=>{go({id:null});setMove(null)};
  const closeDay=async()=>{
    if(!cd)return;if(closed.some(c=>c.date===cd))return toast('Already closed that day');
    const n=rows.filter(b=>open(b)&&dateOf(b.when)===cd).length;
    if(n&&!await confirm({title:`Close ${nice(cd)}?`,body:`${n} appointment${n>1?'s are':' is'} booked that day. Closing does not cancel them: each one will be listed under “Needs attention” to move or cancel.`,confirm:'Close the day'}))return;
    await db.add('closures',user.id,{date:cd});await audit(db,user.id,'closed day',cd);setCd('');toast('Day closed');
  };
  const reopen=async c=>{await db.del('closures',c.id);await audit(db,user.id,'reopened day',c.date);toast('Reopened')};
  const saveDoc=(d,p)=>db.patch('doctors',d.id,p).catch(e=>toast(e.message));
  const toggleDay=(d,n)=>saveDoc(d,{days:d.days.includes(n)?d.days.filter(x=>x!==n):[...d.days,n].sort()});
  const F=k=>e=>setFlt({...flt,[k]:e.target.value});
  const offers=s=>docs.filter(d=>!s||d.services.includes(s));
  const ws=addDays(date,-dow(date)),step=view==='week'?7:1;

  const apptCard=b=><button key={b.id} className={'appt '+b.status} onClick={()=>openAppt(b)} title={`${STATUS[b.status]} · ${b.service||'appointment'} · ${b.doctor||'Unassigned'}`}>
    <b>{clock(b.when)}</b><span>{b.name}</span><small>{b.status==='requested'?'Request · ':b.status==='no_show'?'No-show · ':b.status==='completed'?'Done · ':''}{b.doctor||'Unassigned'}</small></button>;

  return(<>
    <header><h1>Bookings</h1>
      <span className="hdr-actions"><button className="btn" onClick={()=>openNew(view==='list'||view==='hours'||date<today?today:date)}><Icon n="plus" size={18}/>New booking</button></span>
    </header>

    {(requests.length>0||conflicts.length>0)&&<div className="needs">
      {requests.length>0&&<section className="card requests" aria-label="Appointment requests">
        <h3>Requests to decide <span className="badge">{requests.length}</span></h3>
        <p className="route">Asked for on your website. Nothing is confirmed until you confirm it.</p>
        {(allReq?requests:requests.slice(0,3)).map(b=>{const past=b.when<now,why=conflictOf(b,docs,closed,leave);return<div key={b.id} className="req-row">
          <button className="req-main" onClick={()=>openAppt(b)}><b>{b.name}</b><span>{nice(b.when)} · {b.service||'Appointment'} · {b.doctor||'Unassigned'}</span>{(past||why)&&<small className="warn">{past?'This time has passed':why}</small>}</button>
          <div className="acts">
            {!past&&!why&&<button className="btn sm" disabled={busy} onClick={()=>decide(b,true)}>Confirm</button>}
            <button className="btn ghost sm" disabled={busy} onClick={()=>openAppt(b,true)}>Move</button>
            <button className="btn ghost sm" disabled={busy} onClick={()=>decline(b)}>Decline</button>
          </div>
        </div>})}
        {requests.length>3&&<button className="lk more" onClick={()=>setAllReq(!allReq)}>{allReq?'Show fewer':`Show all ${requests.length}`}</button>}
      </section>}
      {conflicts.length>0&&<section className="card requests" aria-label="Schedule conflicts">
        <h3>Needs attention <span className="badge">{conflicts.length}</span></h3>
        <p className="route">The schedule changed after these were booked. Move or cancel each one.</p>
        {(allCon?conflicts:conflicts.slice(0,3)).map(([b,why])=><div key={b.id} className="req-row">
          <button className="req-main" onClick={()=>openAppt(b)}><b>{b.name}</b><span>{nice(b.when)} · {b.doctor||'Unassigned'}</span><small className="warn">{why}</small></button>
          <div className="acts"><button className="btn sm" onClick={()=>openAppt(b,true)}>Move</button></div>
        </div>)}
        {conflicts.length>3&&<button className="lk more" onClick={()=>setAllCon(!allCon)}>{allCon?'Show fewer':`Show all ${conflicts.length}`}</button>}
      </section>}
    </div>}

    <div className="toolbar">
      <div className="seg" role="group" aria-label="View">{VIEWS.map(([v,l])=><button key={v} type="button" className="btn sm" aria-pressed={v===view} onClick={()=>go({view:v})}>{l}</button>)}</div>
      {(view==='day'||view==='week')&&<div className="datenav">
        <button className="btn icon ghost" aria-label={view==='week'?'Previous week':'Previous day'} onClick={()=>go({date:addDays(date,-step)})}><Icon n="left" size={18}/></button>
        <button className="btn ghost sm" onClick={()=>go({date:today})} disabled={date===today}>Today</button>
        <button className="btn icon ghost" aria-label={view==='week'?'Next week':'Next day'} onClick={()=>go({date:addDays(date,step)})}><Icon n="right" size={18}/></button>
        <DateButton value={date} onChange={v=>go({date:v})} label={view==='week'?`${nice(ws)} to ${nice(addDays(ws,6))}`:nice(date)}/>
      </div>}
      {view!=='hours'&&docs.length>1&&<select className="tool-sel" aria-label="Doctor" value={flt.doctor} onChange={F('doctor')}><option value="">All doctors</option>{docs.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>}
    </div>

    {unmarked>0&&view!=='hours'&&<p className="note"><Icon n="clock" size={18}/><span><button className="lk" onClick={()=>{go({view:'list'});setFlt({...flt,q:'',status:'booked',range:'past',service:''})}}>{unmarked} past appointment{unmarked>1?'s':''} still need{unmarked>1?'':'s'} an outcome.</button> Mark each one completed or no-show so Insights stays accurate.</span></p>}

    {view==='day'&&<>
      <p className="dayline">{day.filter(mine).length} appointment{day.filter(mine).length===1?'':'s'}{dayClosed?' · the clinic is closed':''}</p>
      {!docs.length?<div className="card"><Empty icon="people" title="No doctors yet">Add your doctors in Knowledge to start booking.</Empty></div>
      :<div className="docs">
        {shown.map(d=>{
          const own=day.filter(b=>b.doctor_id===d.id),slots=slotsFor(d,date),extra=own.filter(b=>!slots.includes(b.when));
          const cell=b=><button key={b.id} className={'slot booked '+b.status} onClick={()=>openAppt(b)}><b>{clock(b.when)}</b> {b.name}{b.status==='requested'?' · request':b.status==='booked'?'':' · '+STATUS[b.status].toLowerCase()}</button>;
          return(<div key={d.id} className="card doc">
            <div className="doc-h"><h3>{d.name}</h3><small>{d.specialty?d.specialty+' · ':''}{d.start}–{d.end} · {own.length} booked</small></div>
            {dayClosed&&!own.length?<p className="route">Clinic closed.</p>:slots.length||extra.length
              ?<div className="slots">{slots.map(s=>{
                const b=own.find(x=>x.when===s),away=!b&&awayAt(d,s,leave);
                return b?cell(b)
                  :away||dayClosed?<span key={s} className="slot off" title={away?.note||''}><b>{clock(s)}</b> {dayClosed?'closed':'away'}</span>
                  :s<now?<span key={s} className="slot off"><b>{clock(s)}</b></span>
                  :<button key={s} className="slot free" onClick={()=>openNew(date,s,d)} aria-label={`Book ${d.name} at ${clock(s)}`}><b>{clock(s)}</b> open</button>;
              })}{extra.map(cell)}</div>
              :<p className="route">Not working this day.</p>}
          </div>);
        })}
        {!flt.doctor&&day.some(b=>!docs.some(d=>d.id===b.doctor_id))&&<div className="card doc"><div className="doc-h"><h3>Unassigned</h3></div>
          <div className="slots">{day.filter(b=>!docs.some(d=>d.id===b.doctor_id)).map(b=><button key={b.id} className={'slot booked '+b.status} onClick={()=>openAppt(b)}><b>{clock(b.when)}</b> {b.name}</button>)}</div>
        </div>}
      </div>}
    </>}

    {view==='week'&&<div className="week">{Array.from({length:7},(_,i)=>addDays(ws,i)).map(d=>{
      const items=rows.filter(b=>held(b)&&dateOf(b.when)===d&&mine(b)).sort(byWhen),shut=closedOn(d,closed,leave);
      const free=d>=today&&!shut?openSlots(shown,d,rows,leave,closed,{now}).length:0;
      return(<section key={d} className={'wday'+(d===today?' today':'')+(d<today?' past':'')} aria-label={nice(d)}>
        <button className="wday-h" onClick={()=>go({view:'day',date:d})} title="Open this day"><b>{DAYS[dow(d)]} {Number(d.slice(8))}</b><small>{shut?'Closed':items.length?`${items.length} booked`:'—'}</small></button>
        {items.map(apptCard)}
        {free>0&&<button className="wfree" onClick={()=>openNew(d)}><Icon n="plus" size={14}/>{free} open</button>}
      </section>);
    })}</div>}

    {view==='list'&&<section className="card" aria-label="All appointments">
      <div className="filters">
        <label className="search"><Icon n="search" size={18}/><input type="search" placeholder="Search name or phone" aria-label="Search name or phone" value={flt.q} onChange={F('q')}/></label>
        <select aria-label="When" value={flt.range} onChange={F('range')}><option value="upcoming">Upcoming</option><option value="today">Today</option><option value="past">Past</option><option value="all">Any time</option></select>
        <select aria-label="Status" value={flt.status} onChange={F('status')}><option value="open">Requested and confirmed</option>{Object.entries(STATUS).map(([k,l])=><option key={k} value={k}>{l}</option>)}<option value="all">Every status</option></select>
        <select aria-label="Service" value={flt.service} onChange={F('service')}><option value="">All services</option>{svc.map(s=><option key={s.id}>{s.name}</option>)}</select>
      </div>
      {list.length?<div className="tblwrap"><table className="tbl">
        <thead><tr><th><button className="sort" onClick={()=>setDesc(!desc)} aria-label="Reverse the order">When <Icon n={(flt.range==='past')!==desc?'right':'left'} size={12}/></button></th><th>Patient</th><th>Service</th><th>Doctor</th><th>Status</th></tr></thead>
        <tbody>{list.slice(0,300).map(b=><tr key={b.id} className={b.id===pickId?'on':''} tabIndex={0} onClick={()=>openAppt(b)} onKeyDown={e=>e.key==='Enter'&&openAppt(b)}>
          <td>{nice(b.when)}</td><td><b>{b.name}</b><br/><small>{b.phone}</small></td><td>{b.service}</td><td>{b.doctor||'Unassigned'}</td><td><Chip b={b} past={b.when<now}/></td></tr>)}</tbody>
      </table></div>:<Empty icon="search" title="No appointments match">Change the filters, or search by a different name or number.</Empty>}
      <p className="route">{list.length>300?`Showing the first 300 of ${list.length}. Narrow the search to see the rest.`:`${list.length} appointment${list.length===1?'':'s'}`} · history covers the last 180 days.</p>
    </section>}

    {view==='hours'&&<div className="grid2">
      <div className="card"><h3>Doctor schedules</h3>
        <p className="route">{manager?'Changes apply to new bookings straight away. Existing appointments that no longer fit are listed under “Needs attention”.':'Only an owner or admin can change schedules.'}</p>
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
      <div className="card"><h3>Closed days</h3>
        <p className="route">No bookings can be made on a closed day.</p>
        <div className="closer"><DateButton value={cd} onChange={setCd} label={cd?nice(cd):'Pick a day'} title="Day to close"/><button className="btn sm" type="button" onClick={closeDay} disabled={!cd}>Close this day</button></div>
        <div className="closed-list">{closed.map(c=><div key={c.id} className="closed-row"><span>{nice(c.date)}</span><button className="btn ghost sm" type="button" onClick={()=>reopen(c)}>Reopen</button></div>)}{!closed.length&&<p className="route">No closed days.</p>}</div>
        <h3 style={{marginTop:20}}>Time away</h3>
        {leave.some(e=>e.doctor_id&&e.date>=today)
          ?<div className="closed-list">{leave.filter(e=>e.doctor_id&&e.date>=today).slice(0,12).map(e=><div key={e.id} className="closed-row"><span>{nice(e.date)} · {e.who}{e.start!=null?' · part of the day':''}</span><small>{e.note}</small></div>)}</div>
          :<p className="route">No confirmed time away. Tell the assistant in Knowledge when a doctor is off.</p>}
      </div>
    </div>}

    {pick&&(()=>{
      const past=pick.when<now,why=conflictOf(pick,docs,closed,leave),msgs=out.filter(o=>o.booking_id===pick.id).sort((a,b)=>a.at-b.at);
      return(<Drawer title={pick.name} sub={`${nice(pick.when)} · ${pick.service||'Appointment'}`} onClose={closeAppt}>
        <Lifecycle b={pick}/>
        {why&&<p className="note bad" role="alert"><Icon n="alert" size={18}/><span>{why}. Move or cancel this appointment.</span></p>}
        {past&&pick.status==='booked'&&<p className="note"><Icon n="clock" size={18}/><span>This visit is over. Did the patient come?</span></p>}
        <div className="acts primary">
          {pick.status==='requested'&&<><button className="btn" disabled={busy||past||!!why} onClick={()=>decide(pick,true)}>Confirm</button><button className="btn ghost" disabled={busy} onClick={()=>decline(pick)}>Decline</button></>}
          {pick.status==='booked'&&past&&<><button className="btn" disabled={busy} onClick={()=>mark(pick,'completed')}><Icon n="check" size={18}/>Completed</button><button className="btn ghost" disabled={busy} onClick={()=>mark(pick,'no_show')}>No-show</button></>}
          {(pick.status==='completed'||pick.status==='no_show')&&<button className="btn ghost" disabled={busy} onClick={()=>mark(pick,'booked')}>Undo outcome</button>}
          {open(pick)&&<button className="btn ghost" disabled={busy} aria-expanded={!!move} onClick={()=>setMove(move?null:{date:past?today:dateOf(pick.when),doctor_id:''})}>{move?'Keep this time':'Move'}</button>}
          {pick.status==='booked'&&!past&&<button className="btn ghost" disabled={busy} onClick={()=>cancel(pick)}>Cancel</button>}
        </div>
        {move&&open(pick)&&<div className="move"><h4>Move to an open time</h4>
          <div className="f"><label htmlFor="mvd">Doctor</label><select id="mvd" value={move.doctor_id} onChange={e=>setMove({...move,doctor_id:e.target.value})}><option value="">Any doctor{pick.service?` offering ${pick.service}`:''}</option>{offers(pick.service).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
          <SlotPicker docs={docs} rows={rows} leave={leave} closed={closed} now={now} service={pick.service} doctorId={move.doctor_id||undefined} skipId={pick.id} hide={pick} date={move.date} setDate={v=>setMove({...move,date:v})} onPick={s=>doMove(pick,s)} busy={busy}/>
        </div>}
        <dl className="facts">
          <dt>Phone</dt><dd><a href={tel(pick.phone)}>{pick.phone}</a></dd>
          <dt>Doctor</dt><dd>{pick.doctor||'Unassigned'}</dd>
          <dt>Booked through</dt><dd>{SOURCE[pick.source]||'Front desk'}{pick.created?`, ${new Date(pick.created).toLocaleDateString([],{month:'short',day:'numeric'})}`:''}</dd>
          <dt>Patient told</dt><dd>{msgs.length?msgs.map(m=><div key={m.id} className={m.status==='failed'?'warn':''}>{KIND[m.kind]||'Message'}: {MSG[m.status]||m.status}{m.status==='failed'&&m.error?` (${m.error})`:''}</div>):'No messages for this appointment'}</dd>
        </dl>
        {pick.status==='booked'&&past&&<button className="lk" disabled={busy} onClick={()=>cancel(pick)}>Cancel this appointment instead</button>}
      </Drawer>);
    })()}

    {adding&&<Drawer title="New booking" sub="Pick a service, then one of the open times." onClose={()=>{setAdding(false);go({new:null})}}>
      <form onSubmit={book}>
        <div className="f"><label htmlFor="bs">Service</label><select id="bs" value={service} onChange={e=>setF({...f,service:e.target.value,when:'',doctor_id:''})}>{svc.map(s=><option key={s.id}>{s.name}</option>)}</select></div>
        <div className="f"><span className="flabel">Open times</span>
          <SlotPicker docs={docs} rows={rows} leave={leave} closed={closed} now={now} service={service} sel={f.when?f:null} date={fd} setDate={v=>{setFd(v);setF({...f,when:'',doctor_id:''})}} onPick={s=>setF({...f,when:s.when,doctor_id:s.doctor.id})} busy={busy}/></div>
        <Field id="bn" label="Patient name" kind="person" value={f.name} onChange={v=>setF({...f,name:v})} autoComplete="off" show={tried}/>
        <PhoneField id="bp" label="Phone" value={f.phone} onChange={v=>setF({...f,phone:v})} tz={user.tz} show={tried} hint="Used for the confirmation and reminder texts."/>
        <p className="route">{f.when?`${nice(f.when)} with ${docs.find(d=>d.id===f.doctor_id)?.name||'a doctor'}. The patient gets a text confirmation.`:'Pick one of the open times above.'}</p>
        <button className={'btn'+(busy?' busy':'')} disabled={busy||!f.when} style={{width:'100%'}}>Add booking</button>
      </form>
    </Drawer>}
  </>);
}
