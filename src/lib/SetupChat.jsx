import {useState,useRef,useEffect} from 'react';
import {staffAgent} from './llm';
import {db} from './db';
import {ConfirmDeleteDoctor} from './ui';
import {readSetupFile} from './readFile';
import '../forms.css';

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
      const {reply,confirmations=[]}=await staffAgent(hist.current.slice(-16),'setup');
      if(confirmations.length)setPending(p=>[...p.filter(x=>!confirmations.some(c=>c.doctor_id===x.doctor_id)),...confirmations]);
      hist.current.push({role:'assistant',content:reply});
      setMsgs(m=>[...m,{r:'bot',t:reply}]);
      await onSaved?.();
      return true;
    }catch(e){
      hist.current.pop();
      setMsgs(m=>[...m,{r:'bot',t:'Sorry, I couldn’t finish that: '+e.message}]);
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
        {msgs.map((m,i)=><div key={i} className={'setup-msg '+(m.r==='cust'?'me':'bot')}>{m.t}</div>)}
        {busy&&<div className="setup-msg bot typing">Solara is working…</div>}
        {pending.map(c=><ConfirmDeleteDoctor key={c.token} c={c} onConfirm={t=>db.confirmDoctorDeletion(t)} onDone={async(r,ok)=>{
          setPending(p=>p.filter(x=>x.token!==c.token));
          const note=ok?`Removed ${r.removed}.`:`Kept ${c.doctor}. Nothing was removed.`;
          setMsgs(m=>[...m,{r:'bot',t:note}]);hist.current.push({role:'assistant',content:note});
          if(ok)await onSaved?.();
        }}/>)}
      </div>
      <form className="setup-input" onSubmit={e=>{e.preventDefault();send()}}>
        <textarea rows={input.length>80?4:1} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}}
          placeholder="Tell Solara anything about your clinic, or paste a document…" aria-label="Message to Solara" disabled={busy}/>
        <label className="btn ghost sm" style={{cursor:busy?'default':'pointer'}} title="Upload a file: PDF, Excel, CSV or text">Upload
          <input type="file" accept=".txt,.csv,.tsv,.xlsx,.xls,.pdf,.md" onChange={upload} disabled={busy} hidden/></label>
        <button className="btn sm" disabled={busy||!input.trim()}>Send</button>
      </form>
    </div>
  );
}
