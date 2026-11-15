/* Platform admin: every clinic in one list. Each clinic has its own plan, daily AI limit, AI provider, model and key.
   Keys are write-only (only the last four characters are shown). A clinic on its own provider must have its own key:
   the server's key is never sent to a clinic's provider. */
import {useEffect,useMemo,useState} from 'react';
import {adminApi} from '../lib/supabasedb';
import {useToast} from '../lib/hooks';
import {Icon} from '../lib/ui';

// OpenAI-compatible API addresses. "Custom" takes any https address.
const PROVIDERS=[
  {id:'',label:'Server default',url:''},
  {id:'openai',label:'OpenAI',url:'https://api.openai.com/v1'},
  {id:'anthropic',label:'Anthropic',url:'https://api.anthropic.com/v1'},
  {id:'google',label:'Google Gemini',url:'https://generativelanguage.googleapis.com/v1beta/openai'},
  {id:'groq',label:'Groq',url:'https://api.groq.com/openai/v1'},
  {id:'openrouter',label:'OpenRouter',url:'https://openrouter.ai/api/v1'},
  {id:'mistral',label:'Mistral',url:'https://api.mistral.ai/v1'},
  {id:'custom',label:'Custom…',url:null},
];
const providerOf=url=>!url?PROVIDERS[0]:PROVIDERS.find(p=>p.url&&p.url===url)??PROVIDERS.at(-1);
const host=url=>{try{return new URL(url).host}catch{return url}};

/* What's wrong with a clinic's AI setup, if anything. */
const problemOf=c=>c.model_endpoint&&!c.key_hint?'Needs its own key':c.model_endpoint&&!c.model?'Needs a model':'';

function Editor({c,plans,onSaved,onClose}){
  const toast=useToast();
  const [plan,setPlan]=useState(c.plan),[override,setOverride]=useState(c.daily_limit_override??''),[widget,setWidget]=useState(c.widget_enabled);
  const [prov,setProv]=useState(providerOf(c.model_endpoint).id),[url,setUrl]=useState(c.model_endpoint??''),[model,setModel]=useState(c.model??'');
  const [key,setKey]=useState(''),[busy,setBusy]=useState(''),[err,setErr]=useState('');
  const own=prov!=='';
  const pick=id=>{const p=PROVIDERS.find(x=>x.id===id);setProv(id);setUrl(p.url??'');if(!id)setModel('')};
  const run=async(what,fn,msg)=>{setErr('');setBusy(what);try{await fn();toast(msg);onSaved()}catch(e){setErr(e.message)}finally{setBusy('')}};

  const savePlan=()=>{const ov=String(override).trim()===''?null:Number(override);
    if(ov!==null&&(!Number.isInteger(ov)||ov<1))return setErr('Daily limit must be a whole number above 0, or blank for the plan default.');
    run('plan',()=>adminApi.setClinic(c.id,plan,ov,null,widget),'Plan saved')};
  const saveProvider=()=>{
    if(own&&!/^https:\/\//i.test(url.trim()))return setErr('Enter the provider’s https:// API address.');
    if(own&&!model.trim())return setErr('Enter the model name for this provider.');
    run('prov',()=>adminApi.setProvider(c.id,own?url.trim():'',model.trim()),'AI provider saved')};
  const saveKey=()=>run('key',async()=>{await adminApi.setKey(c.id,key);setKey('')},'Key saved');
  const clearKey=()=>confirm(`Remove ${c.name}’s own key?${c.model_endpoint?' Its AI stops working until a new key is added.':' It will use the server key.'}`)
    &&run('clear',()=>adminApi.clearKey(c.id),'Key removed');

  return(
    <div className="adm-edit" role="region" aria-label={'Edit '+c.name}>
      <section>
        <h4>Plan and limits</h4>
        <div className="f"><label htmlFor={'p'+c.id}>Plan</label>
          <select id={'p'+c.id} value={plan} onChange={e=>setPlan(e.target.value)}>{plans.map(p=><option key={p.name} value={p.name}>{p.label} · {p.daily_ai_limit}/day</option>)}</select></div>
        <div className="f"><label htmlFor={'o'+c.id}>Daily AI limit override</label>
          <input id={'o'+c.id} inputMode="numeric" value={override} maxLength={6} placeholder="Plan default" onChange={e=>setOverride(e.target.value.replace(/\D/g,''))}/></div>
        <div className="f"><label htmlFor={'w'+c.id}>Website chat</label>
          <select id={'w'+c.id} value={widget?'on':'off'} onChange={e=>setWidget(e.target.value==='on')}><option value="on">On</option><option value="off">Off</option></select></div>
        <button type="button" className="btn sm" onClick={savePlan} disabled={!!busy}>{busy==='plan'?'Saving…':'Save plan'}</button>
      </section>

      <section>
        <h4>AI provider and model</h4>
        <div className="f"><label htmlFor={'v'+c.id}>Provider</label>
          <select id={'v'+c.id} value={prov} onChange={e=>pick(e.target.value)}>{PROVIDERS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
        {own&&<div className="f"><label htmlFor={'u'+c.id}>API address</label>
          <input id={'u'+c.id} value={url} onChange={e=>setUrl(e.target.value)} readOnly={prov!=='custom'} spellCheck={false} placeholder="https://api.example.com/v1"/></div>}
        <div className="f"><label htmlFor={'m'+c.id}>Model</label>
          <input id={'m'+c.id} value={model} maxLength={80} spellCheck={false} placeholder={own?'Exact model name from the provider':'Server default'} onChange={e=>setModel(e.target.value.replace(/[^A-Za-z0-9._:/-]/g,''))}/></div>
        <p className="adm-note">{own?'This clinic uses its own provider and must have its own key. The server key is never sent here.':'Uses the server’s provider. The clinic’s own key is used if it has one, otherwise the server key.'}</p>
        <button type="button" className="btn sm" onClick={saveProvider} disabled={!!busy}>{busy==='prov'?'Saving…':'Save provider'}</button>
      </section>

      <section>
        <h4>API key</h4>
        <p className="adm-note">{c.key_hint?<>Current key ends <b>{c.key_hint}</b>.</>:c.model_endpoint?<b className="adm-warn">No key yet: this clinic’s AI won’t answer.</b>:'No own key: uses the server key.'}</p>
        <div className="f"><label htmlFor={'k'+c.id}>{c.key_hint?'Replace key':'Add key'}</label>
          <input id={'k'+c.id} type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder="Paste the key"/></div>
        <div className="acts">
          <button type="button" className="btn sm" disabled={!!busy||key.trim().length<8} onClick={saveKey}>{busy==='key'?'Saving…':'Save key'}</button>
          {c.key_hint&&<button type="button" className="btn ghost sm" disabled={!!busy} onClick={clearKey}>Remove key</button>}
        </div>
      </section>

      {err&&<p className="err adm-err" role="alert">{err}</p>}
      <div className="adm-close"><button type="button" className="btn ghost sm" onClick={onClose}>Done</button></div>
    </div>);
}

export default function Admin(){
  const [rows,setRows]=useState(null),[plans,setPlans]=useState([]),[err,setErr]=useState(''),[open,setOpen]=useState(null),[q,setQ]=useState('');
  const load=async()=>{try{setRows(await adminApi.clinics())}catch(e){setErr(e.message)}};
  useEffect(()=>{if(!adminApi)return;load();adminApi.plans().then(setPlans).catch(()=>{})},[]);
  const shown=useMemo(()=>{const t=q.trim().toLowerCase();return(rows??[]).filter(c=>!t||c.name.toLowerCase().includes(t)||(c.owner_email||'').toLowerCase().includes(t))},[rows,q]);
  const label=n=>plans.find(p=>p.name===n)?.label??n;
  if(!adminApi)return<><header><h1>Admin</h1></header><p className="route">Admin needs the live backend.</p></>;
  return(<>
    <header><h1>Clinics</h1><p className="route">Each clinic has its own plan, AI provider, model and key. Click a clinic to change it.</p></header>
    <div className="toolbar"><label className="search"><Icon n="search" size={18}/><input type="search" placeholder="Search clinic or owner email" aria-label="Search clinics" value={q} onChange={e=>setQ(e.target.value)}/></label></div>
    {err&&<p className="err" role="alert">{err}</p>}
    {rows&&!shown.length&&<div className="empty">{rows.length?'No clinics match.':'No clinics yet.'}</div>}
    {rows===null&&!err&&<p className="route">Loading…</p>}
    {shown.length>0&&<div className="card adm-list">
      <table>
        <thead><tr><th>Clinic</th><th>Plan</th><th>AI today</th><th>Provider · model</th><th>Key</th><th>Chat</th><th aria-label="Edit"/></tr></thead>
        <tbody>{shown.map(c=>{const isOpen=open===c.id,pct=Math.min(100,Math.round(100*c.used_today/Math.max(1,c.daily_limit))),bad=problemOf(c);return[
          <tr key={c.id} className={'adm-row'+(isOpen?' on':'')} onClick={()=>setOpen(isOpen?null:c.id)}>
            <td><b>{c.name}</b><small>{c.owner_email||'No owner'}</small></td>
            <td>{label(c.plan)}{c.daily_limit_override?<small>custom {c.daily_limit}/day</small>:null}</td>
            <td><span className="adm-use">{c.used_today} / {c.daily_limit}</span><span className="adm-bar" aria-hidden="true"><i style={{width:pct+'%'}} className={pct>=90?'hi':''}/></span></td>
            <td>{c.model_endpoint?host(c.model_endpoint):'Server default'}<small>{c.model||'default model'}</small>{bad&&<span className="chip adm-bad">{bad}</span>}</td>
            <td>{c.key_hint?<code>•••• {c.key_hint}</code>:<small>{c.model_endpoint?'Missing':'Server key'}</small>}</td>
            <td>{c.widget_enabled?'On':'Off'}</td>
            <td><button type="button" className="btn ghost sm" aria-expanded={isOpen} onClick={e=>{e.stopPropagation();setOpen(isOpen?null:c.id)}}>{isOpen?'Close':'Edit'}</button></td>
          </tr>,
          isOpen&&<tr key={c.id+'-e'} className="adm-erow"><td colSpan={7}><Editor c={c} plans={plans} onSaved={load} onClose={()=>setOpen(null)}/></td></tr>]})}</tbody>
      </table>
    </div>}
  </>);
}
