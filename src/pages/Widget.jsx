/* Public website chat. Visitors never sign in. A chat is resumed from this browser, and staff replies appear here automatically. */
import {useEffect,useRef,useState} from 'react';
import '../widget.css';

const URL=import.meta.env.VITE_SUPABASE_URL,ANON=import.meta.env.VITE_SUPABASE_ANON_KEY;
const headers={apikey:ANON,Authorization:'Bearer '+ANON,'Content-Type':'application/json'};

async function call(path,body){
  const r=await fetch(URL+path,{method:'POST',headers,body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(j.message||j.error||'Something went wrong. Please try again.'),{status:r.status});
  return j;
}

const isBooking=f=>['name','phone','service','when'].every(n=>f?.fields?.some(x=>x.name===n));
const localToday=()=>{const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10)};

/* Booking request: the visitor picks a service and a day, sees the clinic's real open times (doctor schedules, closures and
   existing bookings already applied on the server) and taps one. The team confirms the request in Solara. */
function BookingPicker({form,chat,onDone,onCancel}){
  const svcField=form.fields.find(f=>f.name==='service'),services=svcField?.options||[];
  const [v,setV]=useState({name:'',phone:'',service:services[0]||'',date:localToday(),time:''});
  const [slots,setSlots]=useState(null),[note,setNote]=useState(''),[tick,setTick]=useState(0),[busy,setBusy]=useState(false),[err,setErr]=useState('');
  const key=useRef('req-'+crypto.randomUUID());
  const set=k=>e=>setV(o=>({...o,[k]:e.target.value,...(k==='date'||k==='service'?{time:''}:{})}));
  useEffect(()=>{
    if(!v.date)return;let live=true;setSlots(null);setNote('');
    call('/functions/v1/widget-chat',{action:'slots',conversation_id:chat.conversation_id,token:chat.token,date:v.date,service:v.service})
      .then(j=>{if(!live)return;setSlots([...new Set((j.slots||[]).map(x=>x.time))]);setNote(j.note||'')}).catch(e=>live&&setNote(e.message));
    return()=>{live=false};
  },[v.date,v.service,chat,tick]);
  const submit=async e=>{
    e.preventDefault();setErr('');
    if(!v.name.trim()||!v.phone.trim())return setErr('Please add your name and phone number.');
    if(!v.time)return setErr('Please choose a time.');
    setBusy(true);
    try{
      await call('/functions/v1/widget-chat',{action:'book',conversation_id:chat.conversation_id,token:chat.token,
        booking:{name:v.name.trim(),phone:v.phone.trim(),service:v.service,when:`${v.date}T${v.time}`,key:key.current}});
      onDone();
    }catch(x){setErr(x.message);key.current='req-'+crypto.randomUUID();setV(o=>({...o,time:''}));setTick(n=>n+1)}
    finally{setBusy(false)}
  };
  return(
    <form className="wg-form" onSubmit={submit} aria-label={form.title}>
      <h2>{form.title}</h2>
      <div className="f"><label htmlFor="bk-name">Full name *</label><input id="bk-name" autoComplete="name" value={v.name} onChange={set('name')} required/></div>
      <div className="f"><label htmlFor="bk-phone">{form.fields.find(f=>f.name==='phone')?.label||'Phone'} *</label><input id="bk-phone" type="tel" autoComplete="tel" value={v.phone} onChange={set('phone')} required/></div>
      {services.length>0&&<div className="f"><label htmlFor="bk-svc">Service *</label><select id="bk-svc" value={v.service} onChange={set('service')}>{services.map(o=><option key={o}>{o}</option>)}</select></div>}
      <div className="f"><label htmlFor="bk-date">Day *</label><input id="bk-date" type="date" min={localToday()} value={v.date} onChange={set('date')} required/></div>
      <fieldset className="wg-slots"><legend>Open times</legend>
        {slots===null&&!note&&<p className="wg-note">Checking open times…</p>}
        {slots?.length>0&&slots.map(t=><button type="button" key={t} className={'wg-slot'+(v.time===t?' on':'')} aria-pressed={v.time===t} onClick={()=>setV(o=>({...o,time:t}))}>{t}</button>)}
        {(slots?.length===0||note)&&<p className="wg-note">{note||'No open times that day. Try another day.'}</p>}
      </fieldset>
      {err&&<p className="wg-err" role="alert">{err}</p>}
      <div className="acts"><button className="btn" disabled={busy||!v.time}>{busy?'Sending…':form.submit||'Request appointment'}</button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Not now</button></div>
      <p className="wg-note">Our team confirms every request here in this chat.</p>
    </form>);
}

/* Patient self-service: prove the phone number with a texted code, then move or cancel your own appointments. */
function ManagePanel({chat,onClose,onChanged}){
  const [step,setStep]=useState('phone'),[phone,setPhone]=useState(''),[code,setCode]=useState(''),[list,setList]=useState([]);
  const [busy,setBusy]=useState(false),[err,setErr]=useState(''),[info,setInfo]=useState(''),[moving,setMoving]=useState(null),[sure,setSure]=useState(null);
  const [date,setDate]=useState(localToday()),[slots,setSlots]=useState(null),[time,setTime]=useState(''),[tick,setTick]=useState(0);
  const key=useRef('mng-'+crypto.randomUUID());
  const api=(action,extra={})=>call('/functions/v1/widget-chat',{action,conversation_id:chat.conversation_id,token:chat.token,...extra});
  const run=async fn=>{setBusy(true);setErr('');try{await fn()}catch(e){setErr(e.message);if(e.status===401)setStep('phone')}finally{setBusy(false)}};
  const load=()=>run(async()=>{const j=await api('my_bookings');setList(j.appointments||[]);setStep('list')});
  useEffect(()=>{
    if(!moving||!date)return;let live=true;setSlots(null);
    api('slots',{date,service:moving.service}).then(j=>live&&setSlots([...new Set((j.slots||[]).map(x=>x.time))])).catch(e=>live&&setErr(e.message));
    return()=>{live=false};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[moving,date,tick]);
  const nice=w=>new Date(w+':00').toLocaleString([],{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  return(
    <section className="wg-form" aria-label="Manage my appointment">
      <h2>Manage my appointment</h2>
      {step==='phone'&&<form onSubmit={e=>{e.preventDefault();run(async()=>{const j=await api('verify_start',{phone});setInfo(j.message);setStep('code')})}}>
        <div className="f"><label htmlFor="mg-phone">Phone number on your appointment</label><input id="mg-phone" type="tel" autoComplete="tel" value={phone} onChange={e=>setPhone(e.target.value)} required/></div>
        <div className="acts"><button className="btn" disabled={busy||!phone.trim()}>{busy?'Sending…':'Text me a code'}</button></div>
      </form>}
      {step==='code'&&<form onSubmit={e=>{e.preventDefault();run(async()=>{await api('verify_check',{code});const j=await api('my_bookings');setList(j.appointments||[]);setStep('list')})}}>
        <p className="wg-note">{info}</p>
        <div className="f"><label htmlFor="mg-code">6-digit code</label><input id="mg-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} required/></div>
        <div className="acts"><button className="btn" disabled={busy||code.length!==6}>{busy?'Checking…':'Verify'}</button><button type="button" className="btn ghost" onClick={()=>{setStep('phone');setCode('')}}>Use another number</button></div>
      </form>}
      {step==='list'&&!moving&&<div>
        {!list.length&&<p className="wg-note">No upcoming appointments on this number.</p>}
        {list.map(b=><div key={b.id} className="wg-appt">
          <div><b>{b.service}</b> with {b.doctor}<br/><small>{nice(b.when)}{b.status==='requested'?' · waiting for confirmation':''}</small></div>
          {sure===b.id
            ?<div className="acts"><button className="btn" disabled={busy} onClick={()=>run(async()=>{await api('cancel',{booking_id:b.id,key:key.current+'-c-'+b.id});setSure(null);onChanged();await load()})}>Yes, cancel it</button><button className="btn ghost" onClick={()=>setSure(null)}>Keep it</button></div>
            :<div className="acts"><button className="btn ghost" onClick={()=>{setMoving(b);setDate(b.when.slice(0,10));setTime('')}}>Reschedule</button><button className="btn ghost" onClick={()=>setSure(b.id)}>Cancel</button></div>}
        </div>)}
      </div>}
      {moving&&<div>
        <p className="wg-note">Moving {moving.service} from {nice(moving.when)}</p>
        <div className="f"><label htmlFor="mg-date">New day</label><input id="mg-date" type="date" min={localToday()} value={date} onChange={e=>{setDate(e.target.value);setTime('')}}/></div>
        <fieldset className="wg-slots"><legend>Open times</legend>
          {slots===null&&<p className="wg-note">Checking open times…</p>}
          {slots?.map(t=><button type="button" key={t} className={'wg-slot'+(time===t?' on':'')} aria-pressed={time===t} onClick={()=>setTime(t)}>{t}</button>)}
          {slots?.length===0&&<p className="wg-note">No open times that day. Try another day.</p>}
        </fieldset>
        <div className="acts">
          <button className="btn" disabled={busy||!time} onClick={()=>run(async()=>{try{await api('reschedule',{booking_id:moving.id,when:`${date}T${time}`,key:key.current+'-r-'+moving.id+date+time})}catch(e){setTick(n=>n+1);setTime('');throw e}setMoving(null);onChanged();await load()})}>{busy?'Saving…':'Move appointment'}</button>
          <button className="btn ghost" onClick={()=>setMoving(null)}>Back</button>
        </div>
      </div>}
      {err&&<p className="wg-err" role="alert">{err}</p>}
      <div className="acts" style={{marginTop:8}}><button type="button" className="btn ghost" onClick={onClose}>Close</button></div>
    </section>);
}

export default function Widget(){
  const org=new URLSearchParams(location.search).get('org');
  const [chat,setChat]=useState(null),[msgs,setMsgs]=useState([]),[text,setText]=useState(''),[busy,setBusy]=useState(false);
  const [err,setErr]=useState(''),[form,setForm]=useState(null),[values,setValues]=useState({}),[name,setName]=useState('Clinic');
  const [greeting,setGreeting]=useState('Hi! How can I help you today?'),[status,setStatus]=useState('handled'),[manage,setManage]=useState(false);
  const lastAt=useRef('1970-01-01T00:00:00Z'),logRef=useRef(null),key=`solara.widget.${org}`;

  const addMsgs=list=>{if(!list.length)return;lastAt.current=list.at(-1).created_at;setMsgs(m=>[...m,...list])};
  const poll=async(c=chat)=>{
    if(!c)return;
    try{const j=await call('/functions/v1/widget-chat',{action:'poll',conversation_id:c.conversation_id,token:c.token,since:lastAt.current});
      addMsgs(j.messages);if(j.status)setStatus(j.status)}catch(e){if(e.status===401)setErr(e.message)}
  };

  // Start a new chat, or resume the one saved in this browser.
  useEffect(()=>{
    if(!org||!URL){setErr('This chat is not set up correctly.');return}
    let saved=null;try{saved=JSON.parse(localStorage.getItem(key)||'null')}catch{}
    (async()=>{
      try{
        let c=saved;
        if(!c){
          const [row]=await call('/rest/v1/rpc/widget_start',{org});
          c={conversation_id:row.conversation_id,token:row.token};
          localStorage.setItem(key,JSON.stringify(c));
          setName(row.org_name);setGreeting(row.greeting);
        }else{
          // Read-only lookup: resuming a chat must not create a new one.
          const [o]=await fetch(URL+'/rest/v1/rpc/widget_info',{method:'POST',headers,body:JSON.stringify({org})}).then(r=>r.ok?r.json():[{}]).catch(()=>[{}]);
          if(o?.org_name){setName(o.org_name);setGreeting(o.greeting)}
        }
        setChat(c);
        await poll(c);
      }catch(e){setErr(e.message)}
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[org]);

  // Staff replies arrive while the chat is open.
  useEffect(()=>{if(!chat)return;const t=setInterval(()=>poll(chat),5000);return()=>clearInterval(t)},[chat]);
  useEffect(()=>{logRef.current?.scrollTo({top:logRef.current.scrollHeight,behavior:'smooth'})},[msgs,form]);

  const send=async content=>{
    if(!chat||busy)return;
    setBusy(true);setErr('');
    try{
      const j=await call('/functions/v1/widget-chat',{conversation_id:chat.conversation_id,token:chat.token,text:content});
      if(j.form){setForm(j.form);setValues({})}else setForm(null);
      if(j.manage)setManage(true);
      if(j.status)setStatus(j.status);
      await poll(chat);
    }catch(e){
      setErr(e.message);
      if(e.status===401){localStorage.removeItem(key)}
    }finally{setBusy(false)}
  };

  const submitText=e=>{e.preventDefault();const t=text.trim();if(!t)return;setText('');send(t)};
  const submitForm=e=>{
    e.preventDefault();
    const missing=form.fields.filter(f=>f.required&&!String(values[f.name]??'').trim());
    if(missing.length){setErr('Please fill in: '+missing.map(f=>f.label).join(', '));return}
    setForm(null);
    send('Form submitted: '+form.fields.map(f=>`${f.label}: ${String(values[f.name]??'').trim()||'(blank)'}`).join('; '));
  };

  if(!org)return<div className="wg"><p className="wg-err" role="alert">This chat link is missing its clinic.</p></div>;

  return(
    <div className="wg">
      <header className="wg-head"><div><h1>{name}</h1><p>Chat with us</p></div>
        {chat&&!manage&&<button type="button" className="btn ghost sm" onClick={()=>setManage(true)}>Manage my appointment</button>}</header>
      <div className="wg-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        <div className="wg-msg bot"><small>Solara</small>{greeting}</div>
        {msgs.map((m,i)=>(
          <div key={i} className={'wg-msg '+(m.role==='cust'?'me':m.role)}>
            <small>{m.role==='cust'?'You':m.role==='staff'?'Team':'Solara'}</small>{m.body}
          </div>))}
        {manage&&chat&&<ManagePanel chat={chat} onClose={()=>setManage(false)} onChanged={()=>poll(chat)}/>}
        {status==='handoff'&&<div className="wg-note">Our team has been notified and will reply here.</div>}
        {form&&isBooking(form)&&chat&&<BookingPicker form={form} chat={chat} onDone={()=>{setForm(null);poll(chat)}} onCancel={()=>setForm(null)}/>}
        {form&&!isBooking(form)&&(
          <form className="wg-form" onSubmit={submitForm} aria-label={form.title||'Enquiry'}>
            <h2>{form.title||'Enquiry'}</h2>
            {form.fields.map(f=>(
              <div key={f.name} className="f">
                <label htmlFor={'wf-'+f.name}>{f.label}{f.required?' *':''}</label>
                {f.type==='select'?
                  <select id={'wf-'+f.name} value={values[f.name]??''} required={f.required} onChange={e=>setValues({...values,[f.name]:e.target.value})}>
                    <option value="">Choose…</option>{(f.options||[]).map(o=><option key={o}>{o}</option>)}</select>
                :f.type==='textarea'?
                  <textarea id={'wf-'+f.name} rows={3} value={values[f.name]??''} required={f.required} onChange={e=>setValues({...values,[f.name]:e.target.value})}/>
                :
                  <input id={'wf-'+f.name} type={['tel','email','date','datetime-local'].includes(f.type)?f.type:'text'} autoComplete={f.type==='tel'?'tel':f.type==='email'?'email':f.name==='name'?'name':'off'}
                    value={values[f.name]??''} required={f.required} onChange={e=>setValues({...values,[f.name]:e.target.value})}/>}
              </div>))}
            <button className="btn" disabled={busy}>{form.submit||'Send'}</button>
          </form>)}
      </div>
      {err&&<p className="wg-err" role="alert">{err}</p>}
      <form className="wg-input" onSubmit={submitText}>
        <label htmlFor="wg-text" className="sr">Type your message</label>
        <input id="wg-text" value={text} onChange={e=>setText(e.target.value)} placeholder="Type your message" maxLength={1000} disabled={!chat||busy}/>
        <button className="btn" disabled={!chat||busy||!text.trim()}>{busy?'Sending…':'Send'}</button>
      </form>
    </div>
  );
}
