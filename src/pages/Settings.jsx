import {useState,useEffect} from 'react';
import {db} from '../lib/db';import {useAuth,useTable,useToast} from '../lib/hooks';import {normalizePhone} from '../lib/phone';import {Field,PhoneField,problem,phoneProblem} from '../lib/fields';

export default function Settings(){
  const {user:me}=useAuth(),canManage=['owner','admin'].includes(me.role);
  const {user}=useAuth(),toast=useToast(),[s,setS]=useState({greeting:'',tone:'friendly',handoff:''}),[err,setErr]=useState('');
  useEffect(()=>{db.settings(user.id).then(v=>setS(o=>({...o,...v}))).catch(x=>setErr(x.message))},[user.id]);
  const set=k=>e=>setS({...s,[k]:e.target.value}),put=k=>v=>setS({...s,[k]:v});
  const [svc]=useTable('services'),[nm,setNm]=useState('');
  const scriptCode=`<script src="${location.origin}/embed.js" data-org="${me.org}" async></script>`;
  const embedCode=`<iframe src="${location.origin}/widget?org=${me.org}" title="Chat with ${me.biz}" width="360" height="560" style="border:0;max-width:100%" loading="lazy"></iframe>`;
  const addSvc=async e=>{e.preventDefault();const n=nm.trim();if(problem('service',n))return toast(problem('service',n,{label:'Service name'}));if(svc.some(x=>x.name.toLowerCase()===n.toLowerCase()))return toast('That service is already on the list.');await db.add('services',user.id,{name:n});setNm('')};
  const save=async e=>{
    e.preventDefault();setErr('');
    const h=String(s.handoff||'').trim(),wrong=problem('line',s.greeting,{label:'Greeting'})||phoneProblem(h,{required:false,label:'Hand-off number'});
    if(wrong)return setErr(wrong);
    try{await db.saveSettings(user.id,{...s,handoff:h?normalizePhone(h):''});toast('Saved')}catch(x){setErr(x.message)}
  };
  return(<>
    <header><h1>Settings</h1></header>
    {!canManage&&<p className="route">Only owners and admins can change these settings.</p>}
    <form className="card st" style={{maxWidth:520}} onSubmit={save}>
      <Field id="g" label="Greeting" kind="line" value={s.greeting} onChange={put('greeting')} disabled={!canManage} count hint="The first thing patients read in the chat."/>
      <div className="f"><label htmlFor="tn">Tone</label><select id="tn" value={s.tone} onChange={set('tone')} disabled={!canManage}>{['friendly','formal','casual'].map(o=><option key={o}>{o}</option>)}</select></div>
      <PhoneField id="h" label="Hand-off phone number" value={s.handoff} onChange={put('handoff')} tz={me.tz} required={false} disabled={!canManage} autoComplete="tel" hint="Patients are given this number when Solara hands a chat to your team."/>
      <div className="f"><label><input type="checkbox" checked={!!s.autoConfirm} onChange={e=>setS({...s,autoConfirm:e.target.checked})} disabled={!canManage}/> Confirm website bookings automatically</label>
        <small className="route">Off: website bookings arrive as requests on the Bookings page and the patient is told once your team confirms. On: open times are booked straight away.</small></div>
      <p className="err" role="alert">{err}</p>
      {canManage&&<button className="btn">Save settings</button>}
    </form>
    <section className="card st" style={{maxWidth:520,marginTop:16}}>
      <h3>Services</h3>
      <p className="route">Customers pick from this list in booking forms. Change it anytime.</p>
      {svc.map(x=><div key={x.id} className="closed-row"><span>{x.name}</span>{canManage&&<button type="button" className="btn ghost sm" onClick={()=>db.del('services',x.id)}>Remove</button>}</div>)}
      {canManage&&<form className="acts" onSubmit={addSvc} style={{marginTop:10}}>
        <input value={nm} onChange={e=>setNm(e.target.value.replace(/[^\p{L}\p{N} &/+.,'’()-]/gu,'').replace(/^\s+/,''))} maxLength={60} placeholder="New service" aria-label="New service"/>
        <button className="btn sm">Add</button>
      </form>}
    </section>
    {canManage&&me.org&&<section className="card st" style={{maxWidth:520,marginTop:16}}>
      <h3>Website chat</h3>
      <p className="route">Paste this one line before <code>&lt;/body&gt;</code> on your website. It adds a chat button in the corner; patients can ask questions and request appointments.</p>
      <textarea readOnly rows={2} aria-label="Website chat code" value={scriptCode} onFocus={e=>e.target.select()}/>
      <div className="acts" style={{marginTop:8}}>
        <button type="button" className="btn sm" onClick={()=>{navigator.clipboard?.writeText(scriptCode);toast('Copied')}}>Copy code</button>
        <a className="btn ghost sm" href={`/widget?org=${me.org}`} target="_blank" rel="noopener">Preview chat</a>
      </div>
      <details style={{marginTop:10}}><summary>Show the chat inside a page instead</summary>
        <textarea readOnly rows={3} aria-label="Inline chat code" value={embedCode} onFocus={e=>e.target.select()}/>
        <button type="button" className="btn ghost sm" onClick={()=>{navigator.clipboard?.writeText(embedCode);toast('Copied')}}>Copy inline code</button>
      </details>
    </section>}
  </>);
}
