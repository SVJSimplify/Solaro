import {useState} from 'react';
import {db} from '../lib/db';
import {useAuth,useTable,useToast} from '../lib/hooks';
import {DAYS,assignDoctor,slotsFor,activeOn} from '../lib/schedule';
import DateTimePicker from '../lib/DateTimePicker';
import {audit} from '../lib/audit';
import {normalizePhone} from '../lib/phone';
import {queue} from '../lib/outbox';

const today=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};
const blank={name:'',phone:'',service:'',when:'',doctor_id:null};
const clock=w=>w.slice(11);
const nice=w=>new Date(w+':00').toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});

/* Day view: each doctor's real slots, booked ones show who, free ones can be booked directly. */
export default function Bookings(){
  const {user}=useAuth(),toast=useToast(),[docs]=useTable('doctors'),[rows]=useTable('bookings');
  const [closed]=useTable('closures'),[svc]=useTable('services');
  const [date,setDate]=useState(today()),[f,setF]=useState(blank),[pick,setPick]=useState(null),[cd,setCd]=useState('');
  const closeDay=async()=>{if(!cd)return;if(closed.some(c=>c.date===cd))return toast('Already closed that day');await db.add('closures',user.id,{date:cd});await audit(db,user.id,'closed day',cd);setCd('');toast('Day closed')};
  const reopen=async c=>{await db.del('closures',c.id);await audit(db,user.id,'reopened day',c.date)};
  const day=activeOn(rows,date),set=k=>e=>setF({...f,[k]:e.target.value});
  const routed=f.when?assignDoctor(docs,rows,f.when,f.service,f.doctor_id):null;

  const book=async e=>{
    e?.preventDefault();
    if(closed.some(c=>c.date===f.when.slice(0,10)))return toast('The business is closed that day');
    const phone=normalizePhone(f.phone);
    if(!phone)return toast('Enter a valid US or Indian phone number');
    if(!routed)return toast('No doctor is free at that time');
    await db.add('bookings',user.id,{name:f.name.trim(),phone,service:f.service,when:f.when,doctor_id:routed.id,doctor:routed.name,status:'booked'});
    await audit(db,user.id,'booking',`${f.name.trim()} with ${routed.name} at ${f.when.replace('T',' ')}`);
    setF(blank);toast(`Booked with ${routed.name}`);
  };
  const bookSlot=(doc,when)=>{setF({...blank,when,doctor_id:doc.id,service:doc.services[0]});setPick(null)};
  const cancel=async b=>{await db.patch('bookings',b.id,{status:'cancelled'});await audit(db,user.id,'cancellation',`${b.name} at ${b.when.replace('T',' ')}`);setPick(null);toast('Cancelled')};
  const saveDoc=(d,p)=>db.patch('doctors',d.id,p);
  const toggleDay=(d,n)=>saveDoc(d,{days:d.days.includes(n)?d.days.filter(x=>x!==n):[...d.days,n].sort()});
  const unassigned=day.filter(b=>!docs.some(d=>d.id===b.doctor_id));
  /* Website requests wait here for a person. Confirm or decline tells the patient in their chat (or by SMS without one). */
  const requests=rows.filter(b=>b.status==='requested').sort((a,b)=>a.when.localeCompare(b.when));
  const [deciding,setDeciding]=useState(null);
  const decide=async(b,ok)=>{
    setDeciding(b.id);
    try{
      await db.patch('bookings',b.id,{status:ok?'booked':'cancelled'});
      await audit(db,user.id,ok?'booking.confirmed':'booking.declined',`${b.name} with ${b.doctor||'unassigned'} at ${b.when.replace('T',' ')}`);
      const msg=ok?`Good news: your ${b.service||'appointment'} with ${b.doctor} on ${nice(b.when)} is confirmed. See you then!`
        :`Sorry, we can't offer ${nice(b.when)}. Please choose another time here, or reply and we'll help.`;
      if(b.conversation_id)await db.postMessage(b.conversation_id,msg);else await queue(db,user.id,{channel:'sms',to:b.phone,body:msg});
      if(pick?.id===b.id)setPick(null);
      toast(ok?'Confirmed, the patient has been told':'Declined, the patient has been told');
    }catch(e){toast('Could not update: '+e.message)}finally{setDeciding(null)}
  };
  const past=b=>b.when<new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,16);

  return(<>
    <header><h1>Bookings</h1><DateTimePicker mode="date" value={date} onChange={v=>v&&setDate(v)} label="Day"/></header>

    {requests.length>0&&<section className="card st requests" aria-label="Appointment requests">
      <h3>Appointment requests <span className="badge">{requests.length}</span></h3>
      <p className="route">Requested from your website. Nothing is confirmed until you confirm it.</p>
      {requests.map(b=><div key={b.id} className="req-row">
        <div><b>{b.name}</b> · {b.service} · {b.doctor||'Unassigned'}<br/><small>{nice(b.when)}{past(b)?' · time has passed':''} · <a href={'tel:'+b.phone.replace(/[^\d+]/g,'')}>{b.phone}</a></small></div>
        <div className="acts">
          {!past(b)&&<button className="btn sm" disabled={deciding===b.id} onClick={()=>decide(b,true)}>Confirm</button>}
          <button className="btn ghost sm" disabled={deciding===b.id} onClick={()=>decide(b,false)}>Decline</button>
        </div>
      </div>)}
    </section>}

    <div className="docs">
      {docs.map(d=>{
        const mine=day.filter(b=>b.doctor_id===d.id),slots=slotsFor(d,date);
        return(<div key={d.id} className="card st">
          <h3>{d.name} <small>{d.specialty}</small></h3>
          <small>{d.start}–{d.end} · {mine.length} booked</small>
          {slots.length
            ?<div className="slots">{slots.map(s=>{
              const b=mine.find(x=>x.when===s);
              return b
                ?<button key={s} className={'slot booked'+(b.status==='requested'?' req':'')} onClick={()=>setPick(b)}><b>{clock(s)}</b> {b.name}{b.status==='requested'?' · request':''}</button>
                :<button key={s} className="slot free" onClick={()=>bookSlot(d,s)}><b>{clock(s)}</b> free</button>;
            })}</div>
            :<div className="empty">Not working on this day.</div>}
        </div>);
      })}
      {unassigned.length>0&&<div className="card st"><h3>Unassigned</h3>
        {unassigned.map(b=><button key={b.id} className="slot booked" onClick={()=>setPick(b)}><b>{clock(b.when)}</b> {b.name}</button>)}
      </div>}
    </div>

    {pick&&<div className="card st detail"><h3>{pick.name}</h3>
      <dl>
        <dt>When</dt><dd>{pick.when.replace('T',' ')}</dd>
        <dt>Phone</dt><dd><a href={'tel:'+pick.phone.replace(/[^\d+]/g,'')}>{pick.phone}</a></dd>
        <dt>Service</dt><dd>{pick.service}</dd>
        <dt>Doctor</dt><dd>{pick.doctor||'Unassigned'}</dd>
        <dt>Status</dt><dd>{pick.status==='requested'?'Requested, waiting for you':pick.status||'booked'}</dd>
        {pick.source&&pick.source!=='staff'&&<><dt>From</dt><dd>{pick.source==='website'?'Website chat':'Assistant'}</dd></>}
      </dl>
      <div className="acts">{pick.status==='requested'?<><button className="btn sm" disabled={deciding===pick.id||past(pick)} onClick={()=>decide(pick,true)}>Confirm</button><button className="btn ghost sm" disabled={deciding===pick.id} onClick={()=>decide(pick,false)}>Decline</button></>
        :<button className="btn ghost sm" onClick={()=>cancel(pick)}>Cancel booking</button>}<button className="btn ghost sm" onClick={()=>setPick(null)}>Close</button></div>
    </div>}

    <div className="grid2">
      <div className="card st"><h3>Closed days</h3>
        <p className="route">Bookings are blocked on closed days.</p>
        <DateTimePicker mode="date" value={cd} onChange={setCd} label="Closed day"/>
        <button className="btn sm" type="button" onClick={closeDay} disabled={!cd} style={{marginTop:8}}>Close this day</button>
        <div className="closed-list">{closed.map(c=><div key={c.id} className="closed-row"><span>{c.date}</span><button className="btn ghost sm" type="button" onClick={()=>reopen(c)}>Reopen</button></div>)}{!closed.length&&<p className="route">No closed days.</p>}</div>
      </div>
      <form className="card st" onSubmit={book}><h3>New booking</h3>
        <div className="f"><label htmlFor="bn">Customer</label><input id="bn" required value={f.name} onChange={set('name')}/></div>
        <div className="f"><label htmlFor="bp">Phone</label><input id="bp" type="tel" required value={f.phone} onChange={set('phone')}/></div>
        <div className="f"><label htmlFor="bs">Service</label><select id="bs" value={f.service} onChange={set('service')}>{svc.map(s=><option key={s.id}>{s.name}</option>)}</select></div>
        <div className="f"><span className="flabel">Date & time</span><DateTimePicker mode="datetime" value={f.when} onChange={v=>setF({...f,when:v})} label="Date and time"/></div>
        <p className="route">{!f.when?'Pick a time to see which doctor is free.':routed?`Routed to ${routed.name}.`:'No doctor is free at that time.'}</p>
        <button className="btn" disabled={!routed}>Add booking</button>
      </form>

      <div className="card st"><h3>Doctor schedules</h3>
        {docs.map(d=>(<div key={d.id} className="sched">
          <b>{d.name}</b>
          <div className="days">{DAYS.map((n,i)=>(
            <label key={i}><input type="checkbox" checked={d.days.includes(i)} onChange={()=>toggleDay(d,i)}/>{n}</label>))}</div>
          <div className="hours">
            <input type="time" value={d.start} onChange={e=>saveDoc(d,{start:e.target.value})} aria-label={d.name+' start'}/>
            <span>to</span>
            <input type="time" value={d.end} onChange={e=>saveDoc(d,{end:e.target.value})} aria-label={d.name+' end'}/>
          </div>
        </div>))}
      </div>
    </div>
  </>);
}
