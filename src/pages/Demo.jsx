import {useEffect,useState,useRef} from 'react';
import {Link} from 'react-router-dom';
import {db} from '../lib/db';
import {ago} from '../lib/ui';
import FormCard from '../lib/FormCard';

/* Local demo: a sample clinic website with Solara's chat (customer side), next to what the
   business sees in real time (business side). Both use the same local data as the app. */
const GREETING='Hi! I’m Solara, the clinic’s assistant. I can answer questions, book appointments, or pass you to our team.';
const HELP='Try: "What are your hours?", "Book a cleaning tomorrow", or "I have severe pain".';

export default function Demo(){
  const [uid,setUid]=useState(null),[ready,setReady]=useState(false);
  useEffect(()=>{db.session().then(s=>{setUid(s?.id??null);setReady(true)})},[]);
  if(!ready)return<div className="demo-wrap"><p>Loading…</p></div>;
  if(!uid)return(<div className="demo-wrap"><div className="card st"><h2>Sign in first</h2>
    <p>The demo uses your clinic’s data. <Link to="/">Sign in</Link>, set up the clinic, then come back here.</p></div></div>);
  return <DemoView uid={uid}/>;
}

function DemoView({uid}){
  const [me,setMe]=useState(null),[convos,setConvos]=useState([]),[bookings,setBookings]=useState([]),
        [doctors,setDoctors]=useState([]),[alerts,setAlerts]=useState([]),[kb,setKb]=useState([]);
  const [visitor,setVisitor]=useState(null),[open,setOpen]=useState(false),[text,setText]=useState(''),[busy,setBusy]=useState(false);
  const [mode,setMode]=useState('customer');
  const box=useRef(null);

  // Live data for both sides, refreshed every 1.5s and on any change.
  useEffect(()=>{
    let live=true;
    const load=async()=>{
      const [s,c,b,d,a,k]=await Promise.all([db.session(),db.list('convos',uid),db.list('bookings',uid),db.list('doctors',uid),db.list('alerts',uid),db.list('kb',uid)]);
      if(!live)return;
      setMe(s);setConvos(c);setBookings(b);setDoctors(d);setAlerts(a);setKb(k);
    };
    load();const t=setInterval(load,1500);addEventListener('solara',load);
    return()=>{live=false;clearInterval(t);removeEventListener('solara',load)};
  },[uid]);

  // The visitor's chat: created once, kept in the same store so the business sees it.
  const visitorRow=visitor&&convos.find(c=>c.id===visitor.id);
  const startChat=async()=>{
    const row=await db.add('convos',uid,{customer:'Website visitor',channel:'Website chat',status:'handled',created:Date.now(),
      messages:[{r:'bot',t:GREETING,at:Date.now()},{r:'bot',t:HELP,at:Date.now()}]});
    setVisitor(row);setOpen(true);
  };
  useEffect(()=>{box.current?.scrollTo({top:box.current.scrollHeight,behavior:'smooth'})},[visitorRow?.messages?.length,open]);

  const send=async()=>{
    const t=text.trim();if(!t||busy||!visitor)return;
    setText('');setBusy(true);
    await db.patch('convos',visitor.id,{messages:[...visitorRow.messages,{r:'cust',t,at:Date.now()}]});
    try{await db.respond(visitor.id,t,uid)}catch(e){await db.patch('convos',visitor.id,{messages:[...(await db.list('convos',uid)).find(c=>c.id===visitor.id).messages,{r:'bot',t:'Sorry, I couldn’t answer just now. Please try again.',at:Date.now()}]})}
    finally{setBusy(false)}
  };
  // A submitted form becomes a visitor message; Solara then reads it and books.
  const submitForm=async(form,{values,text,freeText})=>{
    if(busy||!visitor)return;
    setBusy(true);
    await db.patch('convos',visitor.id,{messages:[...visitorRow.messages,{r:'cust',t:text,at:Date.now(),meta:{fv:{id:form.id,values,freeText}}}]});
    try{await db.respond(visitor.id,text,uid)}catch(e){await db.patch('convos',visitor.id,{messages:[...(await db.list('convos',uid)).find(c=>c.id===visitor.id).messages,{r:'bot',t:'Sorry, I couldn’t answer just now. Please try again.',at:Date.now()}]})}
    finally{setBusy(false)}
  };
  const reset=()=>{setVisitor(null);setOpen(false)};

  const clinic=me?.biz||'Your clinic';
  const hours=kb.find(k=>/hour/i.test(k.title))?.body;
  const upcoming=bookings.filter(b=>b.status!=='cancelled').sort((a,b)=>a.when.localeCompare(b.when)).slice(0,5);
  const needsHuman=convos.filter(c=>c.status==='handoff').length;
  const unread=alerts.filter(a=>!a.read).length;
  const thread=(visitorRow?.messages||[]);

  return(
    <div className="demo-wrap">
      <header className="demo-top">
        <div><h1>Solara demo</h1><p className="route">A sample clinic website, and what the business sees at the same time. Local demo, not live.</p></div>
        <div className="demo-tabs">
          <button className={'btn sm tab'+(mode==='customer'?'':' ghost')} onClick={()=>setMode('customer')}>Customer view</button>
          <button className={'btn sm tab'+(mode==='business'?'':' ghost')} onClick={()=>setMode('business')}>Business view</button>
          <button className="btn ghost sm" onClick={reset}>Reset demo chat</button>
        </div>
      </header>

      <div className={'demo-grid '+(mode==='customer'?'show-customer':'show-business')}>
        {/* CUSTOMER SIDE: a website with the chat in the corner */}
        <section className="site card st" aria-label="Customer view">
          <div className="site-bar"><b>{clinic}</b><span>Book · Contact · Services</span></div>
          <div className="site-hero">
            <h2>Care that fits your schedule</h2>
            <p>Book online, ask a question any time, and reach our team when you need a person.</p>
          </div>
          <div className="site-cols">
            <div><h3>Our team</h3>
              {doctors.length?doctors.map(d=><div key={d.id} className="site-doc"><b>{d.name}</b><small>{d.specialty}</small><small>{d.days?.length?'Working days set':''}</small></div>)
                :<p className="route">Doctors appear here once added.</p>}
            </div>
            <div><h3>Hours</h3><p>{hours||'Hours appear here once added.'}</p></div>
          </div>
          <div className="site-fake"><small>Your website content. Solara is the chat in the corner.</small></div>

          {!open&&<button className="chat-launch" onClick={startChat}>Chat with us</button>}
          {open&&<div className="chat-box" role="dialog" aria-label="Chat with Solara">
            <div className="chat-head"><b>Solara · {clinic}</b><button className="btn ghost sm" onClick={()=>setOpen(false)}>Minimise</button></div>
            <div className="chat-msgs" ref={box}>
              {thread.map((m,i)=><div key={i} className="chat-item">
                <div className={'chat-msg '+(m.r==='cust'?'me':'bot')}>{m.t}</div>
                {m.meta?.form&&<FormCard form={m.meta.form} done={thread.some(x=>x.meta?.fv?.id===m.meta.form.id)} onSubmit={submitForm}/>}
              </div>)}
              {busy&&<div className="chat-msg bot typing">Solara is typing…</div>}
            </div>
            <form className="chat-input" onSubmit={e=>{e.preventDefault();send()}}>
              <input value={text} maxLength={1000} onChange={e=>setText(e.target.value)} placeholder="Type your message…" aria-label="Your message" disabled={busy}/>
              <button className="btn sm" disabled={busy||!text.trim()}>Send</button>
            </form>
          </div>}
        </section>

        {/* BUSINESS SIDE: what the clinic team sees, live */}
        <section className="biz" aria-label="Business view">
          <div className="stats">
            <div className="stat"><small>Chats</small><b>{convos.length}</b></div>
            <div className="stat"><small>Need a human</small><b className={needsHuman?'hot':''}>{needsHuman}</b></div>
            <div className="stat"><small>Upcoming bookings</small><b>{upcoming.length}</b></div>
            <div className="stat"><small>Unread alerts</small><b className={unread?'hot':''}>{unread}</b></div>
          </div>

          <div className="card st"><h3>This visitor’s chat</h3>
            <p className="route">The same conversation appears in the Inbox of your app, where your team can reply or take over.</p>
            {thread.length?<ol className="transcript">{thread.map((m,i)=><li key={i} className={m.r}><b>{m.r==='cust'?'Visitor':'Solara'}</b> {m.t}</li>)}</ol>
              :<div className="empty">Start a chat on the website to see it here.</div>}
            {visitorRow?.status==='handoff'&&<p className="why">Solara passed this chat to your team. Open it in Inbox.</p>}
          </div>

          <div className="card st"><h3>Upcoming bookings</h3>
            {upcoming.length?<ul className="feed">{upcoming.map(b=><li key={b.id}><b>{b.name}</b> · {b.service||'Appointment'} with {b.doctor}<small>{b.when.replace('T',' ')} · {b.phone}</small></li>)}</ul>
              :<div className="empty">No bookings yet. Ask Solara to book one in the chat.</div>}
          </div>

          <div className="card st explain"><h3>What this means</h3>
            <ul>
              <li><b>Chats</b> counts every conversation Solara has had.</li>
              <li><b>Need a human</b> are chats Solara passed to your team (unsure, upset, asked for a person, or a health concern).</li>
              <li><b>Bookings</b> are appointments Solara booked, assigned to a doctor who is free.</li>
              <li><b>Alerts</b> appear in the Alerts tab, and a text goes to your handoff number.</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
