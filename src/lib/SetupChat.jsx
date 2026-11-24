import {useState,useRef,useEffect} from 'react';
import {staffAgent} from './llm';
import {db} from './db';
import {ConfirmDeleteDoctor,Icon} from './ui';
import {readSetupFile} from './readFile';
import '../forms.css';

/* What the assistant did, in the clinic's words. Anything unlisted is shown by its own name. */
const DID={add_doctor:'Added a doctor',update_doctor:'Updated a doctor',remove_doctor:'Asked to remove a doctor',save_answer:'Saved an answer',remove_answer:'Removed an answer',add_service:'Added a service',list_setup:'Checked what is saved',
  list_doctors:'Looked up doctors',get_doctor_schedule:'Checked a schedule',record_schedule_exception:'Recorded time away',update_business_fact:'Updated clinic details',check_availability:'Checked open times',book_appointment:'Booked an appointment',find_bookings:'Looked up bookings',cancel_booking:'Cancelled a booking'};
const IDEAS=['Dr. Rao works Monday to Friday, 9 to 5, and does cleanings and exams','What do you have saved so far?','We are closed on public holidays','A cleaning costs $120 without insurance'];
const first={r:'bot',t:'Hi, I’m Solara. I’ll set up your front desk by asking a few questions. Start with your doctors or staff: their names, which days they work, their hours and what they do.'};

/* Chat-based setup. Solara asks, and saves doctors and answers itself with tools as it goes. */
export default function SetupChat({uid,toast,onSaved}){
  const [msgs,setMsgs]=useState([first]),[pending,setPending]=useState([]),[input,setInput]=useState(''),[busy,setBusy]=useState(false);
  const hist=useRef([]),box=useRef(null);
  useEffect(()=>{box.current?.scrollTo({top:box.current.scrollHeight,behavior:'smooth'})},[msgs]);

  /* One turn with the staff assistant. Long text (a pasted or uploaded document) is sent in parts so nothing is cut off. */
  const ask=async(text,label=text)=>{
    setMsgs(m=>[...m,{r:'cust',t:label}]);
    hist.current.push({role:'user',content:text});
    try{
      // Existing doctors are never cleared. Removals arrive as confirmation cards that only a click can approve.
      const {reply,confirmations=[],calls=[]}=await staffAgent(hist.current.slice(-16),'setup');
      if(confirmations.length)setPending(p=>[...p.filter(x=>!confirmations.some(c=>c.doctor_id===x.doctor_id)),...confirmations]);
      hist.current.push({role:'assistant',content:reply});
      setMsgs(m=>[...m,{r:'bot',t:reply,calls}]);
      await onSaved?.();
      return true;
    }catch(e){
      hist.current.pop();
      setMsgs(m=>[...m,{r:'bot',err:true,t:'That did not go through. '+e.message,retry:{text,label}}]);
      return false;
    }
  };
  const chunks=(text,max=10000)=>{
    const out=[];let cur='';
    for(const line of text.split(/\r?\n/)){
      for(let l=line;l.length;){const room=max-cur.length-1;if(room<=0){out.push(cur);cur='';continue}cur+=(cur?'\n':'')+l.slice(0,room);l=l.slice(room)}
      if(cur.length>=max){out.push(cur);cur=''}
    }
    if(cur.trim())out.push(cur);return out;
  };
  const sendLong=async(text,name)=>{
    const parts=chunks(text.trim());
    for(let i=0;i<parts.length;i++){
      const head=parts.length>1?`Part ${i+1} of ${parts.length}${name?` of ${name}`:''}. `:(name?`From ${name}. `:'');
      const ok=await ask(`${head}Save every piece of clinic information in this:\n\n${parts[i]}`,`${name?'📄 '+name:'Pasted information'}${parts.length>1?` (part ${i+1}/${parts.length})`:''}`);
      if(!ok)break;
    }
  };
  const send=async()=>{
    const text=input.trim();
    if(!text||busy)return;
    if(!import.meta.env.VITE_SUPABASE_URL)return toast('AI features need Solara connected to its server first');
    setInput('');setBusy(true);
    try{text.length>1500?await sendLong(text):await ask(text)}finally{setBusy(false)}
  };
  const upload=async e=>{
    const f=e.target.files?.[0];e.target.value='';
    if(!f||busy)return;
    if(!import.meta.env.VITE_SUPABASE_URL)return toast('AI features need Solara connected to its server first');
    setBusy(true);
    try{const text=await readSetupFile(f);if(!text.trim())toast('That file has no readable text');else await sendLong(text,f.name)}
    catch(err){toast('Could not read that file: '+err.message)}
    finally{setBusy(false)}
  };

  return(
    <div className="setup-chat">
      <div className="setup-msgs" ref={box} aria-live="polite">
        {msgs.map((m,i)=><div key={i} className={'setup-msg '+(m.r==='cust'?'me':'bot')+(m.err?' err':'')}>
          {m.r!=='cust'&&<small className="who-l">Solara</small>}{m.t}
          {m.calls?.length>0&&<div className="did" aria-label="What Solara did">{m.calls.map((c,j)=><span key={j} className={'chip '+(c.ok?'completed':'no_show')}><Icon n={c.ok?'check':'alert'} size={12}/>{DID[c.name]||c.name.replace(/_/g,' ')}{c.ok?'':' did not work'}</span>)}</div>}
          {m.retry&&i===msgs.length-1&&!busy&&<button type="button" className="btn ghost sm" onClick={async()=>{setBusy(true);setMsgs(x=>x.slice(0,-2));try{await ask(m.retry.text,m.retry.label)}finally{setBusy(false)}}}>Try again</button>}
        </div>)}
        {busy&&<div className="setup-msg bot working" aria-label="Solara is working"><small className="who-l">Solara</small><span className="dots"><i/><i/><i/></span> Reading and saving…</div>}
        {msgs.length===1&&!busy&&<div className="ideas" aria-label="Things you can say">{IDEAS.map(t=><button type="button" key={t} className="idea" onClick={()=>setInput(t)}>{t}</button>)}</div>}
        {pending.map(c=><ConfirmDeleteDoctor key={c.token} c={c} onConfirm={t=>db.confirmDoctorDeletion(t)} onDone={async(r,ok)=>{
          setPending(p=>p.filter(x=>x.token!==c.token));
          const note=ok?`Removed ${r.removed}.`:`Kept ${c.doctor}. Nothing was removed.`;
          setMsgs(m=>[...m,{r:'bot',t:note}]);hist.current.push({role:'assistant',content:note});
          if(ok)await onSaved?.();
        }}/>)}
      </div>
      <form className="setup-input" onSubmit={e=>{e.preventDefault();send()}}>
        <textarea maxLength={4000} rows={input.length>80?4:1} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}}
          placeholder="Tell Solara anything about your clinic, or paste a document…" aria-label="Message to Solara" disabled={busy}/>
        <label className="btn ghost sm" style={{cursor:busy?'default':'pointer'}} title="Upload a file: PDF, Excel, CSV or text">Upload a file
          <input type="file" accept=".txt,.csv,.tsv,.xlsx,.pdf,.md" onChange={upload} disabled={busy} hidden/></label>
        <button className="btn sm" disabled={busy||!input.trim()}>Send</button>
      </form>
    </div>
  );
}
