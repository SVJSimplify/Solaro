import {useState,useEffect} from 'react';
import {useNavigate} from 'react-router-dom';
import {db} from '../lib/db';import {useAuth,useToast} from '../lib/hooks';import {Logo,ImportPreview} from '../lib/ui';import {diffImport} from '../lib/importer';
import SolaraFormat from '../lib/SolaraFormat';
import {addStarterAnswers} from '../lib/starterAnswers';
import SetupChat from '../lib/SetupChat';

const PHONE=/^\+?[0-9 ()-]{7,20}$/;
const STEPS=['Front desk','Answers','Go live'];
const msg=x=>x?.message||'Something went wrong. Please try again.';

export default function Onboarding(){
  const {user}=useAuth(),toast=useToast(),nav=useNavigate();
  const [step,setStep]=useState(0),[busy,setBusy]=useState(false),[err,setErr]=useState(''),[ready,setReady]=useState(false);
  const [s,setS]=useState({greeting:'Hi! How can I help you today?',tone:'friendly',handoff:''});
  const [items,setItems]=useState([]),[fmt,setFmt]=useState(false),[preview,setPreview]=useState(null);

  useEffect(()=>{
    let live=true;
    Promise.all([db.settings(user.id),db.list('kb',user.id)])
      .then(([v,kb])=>{if(!live)return;setS(o=>({...o,...v}));setItems(kb);setReady(true)})
      .catch(x=>live&&setErr(msg(x)));
    return()=>{live=false};
  },[user.id]);

  const run=async fn=>{
    setErr('');setBusy(true);
    try{await fn()}catch(x){setErr(msg(x))}finally{setBusy(false)}
  };
  const set=k=>e=>setS({...s,[k]:e.target.value});
  const refresh=async()=>setItems(await db.list('kb',user.id));

  const saveFront=()=>run(async()=>{
    const g=s.greeting.trim(),h=s.handoff.trim();
    if(!g||g.length>160)return setErr('Greeting is required (160 characters max).');
    if(!PHONE.test(h))return setErr('Enter a valid hand-off phone number.');
    await db.saveSettings(user.id,{greeting:g,tone:s.tone,handoff:h});
    setStep(1);
  });

  const removeEntry=id=>run(async()=>{await db.del('kb',id);await refresh()});

  /* Solara formats the pasted or uploaded document and adds its doctors and answers. */
  /* Shows a preview first; existing doctors and answers are kept unless the user ticks "replace". Nothing is deleted. */
  const importDocument=async p=>{
    setPreview(diffImport(p,await db.list('doctors',user.id),await db.list('kb',user.id)));setFmt(false);
  };
  const applyImport=(p,replace)=>run(async()=>{
    const r=await db.importSetup(user.id,p,replace);
    await refresh();setPreview(null);
    toast(`Added ${r.doctors_added} doctors, ${r.answers_added} answers${replace?`; updated ${r.doctors_updated+r.answers_updated}`:''}`);
  });

  const finish=()=>run(async()=>{
    if(!items.length)return setErr('Add at least one answer first.');
    toast('You’re live');
    nav('/inbox',{replace:true});
  });

  if(!ready)return<div id="auth">{err?<p className="err" role="alert">{err}</p>:null}</div>;

  return(
    <div id="auth"><div className="card st" style={{maxWidth:560,width:'100%'}}>
      <Logo/>
      <ol aria-label="Setup progress" style={{display:'flex',gap:8,listStyle:'none',padding:0,margin:'8px 0 16px'}}>
        {STEPS.map((l,i)=><li key={l} aria-current={i===step?'step':undefined} style={{opacity:i===step?1:.5,fontWeight:i===step?700:400}}>{i+1}. {l}</li>)}
      </ol>

      {step===0&&<form onSubmit={e=>{e.preventDefault();saveFront()}} noValidate>
        <h2>How should your front desk sound?</h2>
        <div className="f"><label htmlFor="g">Greeting</label><input id="g" value={s.greeting} onChange={set('greeting')} maxLength={160}/></div>
        <div className="f"><label htmlFor="tn">Tone</label><select id="tn" value={s.tone} onChange={set('tone')}>{['friendly','formal','casual'].map(o=><option key={o}>{o}</option>)}</select></div>
        <div className="f"><label htmlFor="h">Hand-off phone number</label><input id="h" type="tel" autoComplete="tel" placeholder="+1 555 000 0000" value={s.handoff} onChange={set('handoff')}/></div>
        <p className="err" role="alert">{err}</p>
        <button className={'btn'+(busy?' busy':'')} disabled={busy} style={{width:'100%'}}>Next</button>
      </form>}

      {step===1&&<div>
        <h2>What do customers ask most?</h2>
        <p style={{color:'var(--muted)'}}>Add at least one answer. Your front desk only replies from these.</p>
        <button type="button" className="btn sm" disabled={busy} onClick={()=>setFmt(true)} style={{marginBottom:12}}>Upload your clinic info and let Solara set it up</button>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={()=>run(async()=>{const n=await addStarterAnswers(db,user.id,items);await refresh();toast(n?`Added ${n} starter answers`:'Starter answers already added')})} style={{marginBottom:12,marginLeft:8}}>Add starter answers</button>
        <p style={{color:'var(--muted)'}}>No document? Just talk to Solara and it will set everything up.</p>
        <SetupChat uid={user.id} toast={toast} onSaved={refresh}/>
        {fmt&&<SolaraFormat toast={toast} onClose={()=>setFmt(false)} onImport={importDocument}/>}
        {preview&&<ImportPreview diff={preview} onApply={applyImport} onCancel={()=>setPreview(null)}/>}
        <ul style={{listStyle:'none',padding:0,margin:'16px 0'}}>
          {items.map(x=><li key={x.id} style={{display:'flex',justifyContent:'space-between',gap:8,padding:'6px 0'}}>
            <span><b>{x.title}</b>: {x.body}</span>
            <button type="button" className="btn ghost sm" aria-label={'Remove '+x.title} disabled={busy} onClick={()=>removeEntry(x.id)}>Remove</button>
          </li>)}
        </ul>
        <p className="err" role="alert">{err}</p>
        <div style={{display:'flex',gap:8}}>
          <button type="button" className="btn ghost" disabled={busy} onClick={()=>{setErr('');setStep(0)}}>Back</button>
          <button type="button" className="btn" disabled={busy||!items.length} style={{flex:1}} onClick={()=>{setErr('');setStep(2)}}>Next</button>
        </div>
      </div>}

      {step===2&&<div>
        <h2>Ready to go live</h2>
        <p style={{color:'var(--muted)'}}>{items.length} answer{items.length===1?'':'s'} loaded. Hand-offs go to {s.handoff}.</p>
        <p className="err" role="alert">{err}</p>
        <div style={{display:'flex',gap:8}}>
          <button type="button" className="btn ghost" disabled={busy} onClick={()=>{setErr('');setStep(1)}}>Back</button>
          <button type="button" className={'btn'+(busy?' busy':'')} disabled={busy} style={{flex:1}} onClick={finish}>Open my inbox</button>
        </div>
      </div>}
    </div></div>
  );
}
