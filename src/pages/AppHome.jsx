/* The Solara app's home for patients: the clinics they talk to, a way to add one (scan its QR code or paste its link),
   and notifications for reminders and replies. Staff choose "I work at a clinic" and get the normal dashboard sign-in. */
import {useEffect,useState} from 'react';
import {appMode,setAppMode,savedClinics,forgetClinic,keyFrom,scanQr,pushToken,notificationsAllowed} from '../lib/native';
import '../widget.css';

const initials=n=>(n||'C').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase();
const open=key=>location.assign('/widget?key='+key);

function Start({onPatient,onStaff}){
  return(<main className="wg ah ah-start">
    <div className="ah-hero">
      <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden="true"><path d="M18 42a14 14 0 0 1 28 0z" fill="#D96F54"/><path d="M32 14v8M12.2 22.2l5.7 5.7M51.8 22.2l-5.7 5.7M8 47h48M18 54h28" stroke="#F2A278" strokeWidth="3.2" strokeLinecap="round"/></svg>
      <h1>Solara</h1>
      <p>Book, change and get reminders for your clinic visits.</p>
    </div>
    <div className="ah-choices">
      <button type="button" className="btn ah-big" onClick={onPatient}>I’m a patient</button>
      <button type="button" className="btn ghost ah-big" onClick={onStaff}>I work at a clinic</button>
    </div>
  </main>);
}

export default function AppHome({onStaff}){
  const [mode,setMode]=useState(appMode()),[list,setList]=useState(savedClinics()),[link,setLink]=useState(''),[err,setErr]=useState(''),[busy,setBusy]=useState(false),[notif,setNotif]=useState(null);
  useEffect(()=>{notificationsAllowed().then(setNotif)},[]);
  if(mode!=='patient')return<Start onPatient={()=>{setAppMode('patient');setMode('patient')}} onStaff={()=>{setAppMode('staff');onStaff()}}/>;

  const add=text=>{const k=keyFrom(text);if(!k)return setErr('That doesn’t look like a clinic link. Ask the clinic for its Solara link or QR code.');setErr('');open(k)};
  const scan=async()=>{setBusy(true);setErr('');try{const v=await scanQr();if(v)add(v)}catch(e){if(!/cancel/i.test(e?.message||''))setErr('Could not open the scanner. Paste the clinic’s link instead.')}finally{setBusy(false)}};
  const allow=async()=>{const t=await pushToken();setNotif(!!t);if(!t)setErr('Notifications are off. You can turn them on in Android Settings → Apps → Solara.')};

  return(<main className="wg ah">
    <header className="wg-head"><div className="wg-id"><h1>Your clinics</h1><p>Chat, book and manage visits</p></div></header>
    <div className="ah-body">
      {notif===false&&<section className="ah-card ah-notif">
        <b>Get reminders and replies</b>
        <p>Turn on notifications so your clinic can remind you about visits and reply when you’re away from the chat.</p>
        <button type="button" className="btn" onClick={allow}>Turn on notifications</button>
      </section>}

      {list.length>0?<ul className="ah-list">{list.map(c=><li key={c.key}>
        <button type="button" className="ah-clinic" onClick={()=>open(c.key)}><span className="wg-avatar" aria-hidden="true">{initials(c.name)}</span><b>{c.name}</b></button>
        <button type="button" className="wg-link" aria-label={'Remove '+c.name} onClick={()=>{forgetClinic(c.key);setList(savedClinics())}}>Remove</button>
      </li>)}</ul>
      :<p className="ah-empty">Add your clinic to start. Scan the QR code at the clinic’s reception or on its website.</p>}

      <section className="ah-card">
        <b>Add a clinic</b>
        <button type="button" className="btn" onClick={scan} disabled={busy}>{busy?'Opening scanner…':'Scan QR code'}</button>
        <form onSubmit={e=>{e.preventDefault();add(link)}} className="ah-link">
          <label htmlFor="ah-l" className="sr">Clinic link</label>
          <input id="ah-l" value={link} onChange={e=>setLink(e.target.value)} placeholder="Or paste the clinic’s link" autoComplete="off" inputMode="url"/>
          <button className="btn ghost" disabled={!link.trim()}>Open</button>
        </form>
        {err&&<p className="wg-err" role="alert">{err}</p>}
      </section>
    </div>
    <p className="wg-foot"><button type="button" className="wg-link" onClick={()=>{setAppMode('staff');onStaff()}}>I work at a clinic</button></p>
  </main>);
}
