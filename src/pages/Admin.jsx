/* Platform admin: each clinic's plan, daily AI limit, model, website chat switch and model key. Keys are write-only. */
import {useEffect,useState} from 'react';
import {adminApi} from '../lib/supabasedb';
import {useToast} from '../lib/hooks';

function ClinicRow({c,plans,reload}){
  const toast=useToast();
  const [plan,setPlan]=useState(c.plan),[override,setOverride]=useState(c.daily_limit_override??''),[model,setModel]=useState(c.model),[widget,setWidget]=useState(c.widget_enabled),[key,setKey]=useState(''),[err,setErr]=useState('');
  const save=async()=>{
    setErr('');
    try{
      const ov=String(override).trim()===''?null:Number(override);
      if(ov!==null&&(!Number.isInteger(ov)||ov<1))return setErr('Daily limit must be a whole number above 0, or blank for the plan default.');
      await adminApi.setClinic(c.id,plan,ov,model.trim(),widget);
      toast('Saved'); reload();
    }catch(e){setErr(e.message)}
  };
  const saveKey=async()=>{
    setErr('');
    try{await adminApi.setKey(c.id,key);setKey('');toast('Model key saved'); reload()}
    catch(e){setErr(e.message)}
  };
  return(
    <div className="card st" style={{marginBottom:12}}>
      <h3 style={{marginBottom:6}}>{c.name}</h3>
      <p className="route" style={{margin:'0 0 12px'}}>Today: {c.used_today} of {c.daily_limit} AI replies used · Key: {c.key_hint?`•••• ${c.key_hint}`:'not set'}</p>
      <div className="grid2">
        <div className="f"><label htmlFor={'p'+c.id}>Plan</label>
          <select id={'p'+c.id} value={plan} onChange={e=>setPlan(e.target.value)}>{plans.map(p=><option key={p.name} value={p.name}>{p.label} ({p.daily_ai_limit}/day)</option>)}</select></div>
        <div className="f"><label htmlFor={'o'+c.id}>Daily limit override</label>
          <input id={'o'+c.id} inputMode="numeric" value={override} maxLength={6} placeholder="Plan default" onChange={e=>setOverride(e.target.value.replace(/\D/g,''))}/></div>
        <div className="f"><label htmlFor={'m'+c.id}>Model name</label>
          <input id={'m'+c.id} value={model} maxLength={60} spellCheck={false} placeholder="Server default" onChange={e=>setModel(e.target.value.replace(/[^A-Za-z0-9._:/-]/g,''))}/></div>
        <div className="f"><label htmlFor={'w'+c.id}>Website chat</label>
          <select id={'w'+c.id} value={widget?'on':'off'} onChange={e=>setWidget(e.target.value==='on')}><option value="on">On</option><option value="off">Off</option></select></div>
      </div>
      <div className="acts"><button type="button" className="btn sm" onClick={save}>Save clinic</button></div>
      <div className="f" style={{marginTop:14}}>
        <label htmlFor={'k'+c.id}>Model API key (replace)</label>
        <div className="acts"><input id={'k'+c.id} type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder="Paste a new key"/>
          <button type="button" className="btn ghost sm" disabled={key.trim().length<8} onClick={saveKey}>Save key</button></div>
      </div>
      {err&&<p className="err" role="alert">{err}</p>}
    </div>
  );
}

export default function Admin(){
  const [rows,setRows]=useState(null),[plans,setPlans]=useState([]),[err,setErr]=useState('');
  const load=async()=>{try{setRows(await adminApi.clinics())}catch(e){setErr(e.message)}};
  useEffect(()=>{if(!adminApi)return;load();adminApi.plans().then(setPlans).catch(()=>{})},[]);
  if(!adminApi)return<><header><h1>Admin</h1></header><p className="route">Admin needs the live backend.</p></>;
  return(<>
    <header><h1>Clinics</h1></header>
    <p className="route">Each clinic has its own model key and daily limit. Keys are write-only: Solara shows only the last four characters.</p>
    {err&&<p className="err" role="alert">{err}</p>}
    {rows&&!rows.length&&<div className="empty">No clinics yet.</div>}
    {rows?.map(c=><ClinicRow key={c.id} c={c} plans={plans} reload={load}/>)}
  </>);
}
