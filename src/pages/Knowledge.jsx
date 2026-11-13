import {useState,useMemo} from 'react';
import {db} from '../lib/db';import {useAuth,useTable,useToast} from '../lib/hooks';import {wait,RM,ImportPreview} from '../lib/ui';
import {parseSetup,EXAMPLE,diffImport} from '../lib/importer';
import {readSetupFile} from '../lib/readFile';
import SolaraFormat from '../lib/SolaraFormat';
import {addStarterAnswers} from '../lib/starterAnswers';
const blank={title:'',body:'',keywords:''};

export default function Knowledge(){
  const {user}=useAuth(),toast=useToast(),[kb]=useTable('kb'),[docs]=useTable('doctors'),[f,setF]=useState(blank),[rm,setRm]=useState(null);
  const [text,setText]=useState(''),[last,setLast]=useState(null),plan=useMemo(()=>parseSetup(text),[text]);
  const [fmt,setFmt]=useState(false),[preview,setPreview]=useState(null);
  const canManage=['owner','admin'].includes(user.role);
  /* Import is previewed first. Existing doctors and answers are kept unless the user ticks "replace"; nothing is deleted.
     The write is one server transaction, so a failed import changes nothing. */
  const importPlan=p=>setPreview(diffImport(p,docs,kb));
  const applyImport=async(p,replace)=>{
    try{
      const r=await db.importSetup(user.id,p,replace);
      setLast({...p,errors:plan.errors});setText('');setPreview(null);
      toast(`Added ${r.doctors_added} doctors, ${r.answers_added} answers${replace?`; updated ${r.doctors_updated+r.answers_updated}`:''}`);
    }catch(e){toast('Import failed, nothing was changed: '+e.message)}
  };
  const runImport=()=>importPlan(plan);
  const readFile=async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;try{setText(await readSetupFile(file))}catch(err){toast('Could not read that file: '+err.message)}};
  const set=k=>e=>setF({...f,[k]:e.target.value});
  const add=async e=>{e.preventDefault();await db.add('kb',user.id,{title:f.title.trim(),body:f.body.trim(),keywords:f.keywords.trim()});setF(blank);toast('Saved')};
  const del=async id=>{setRm(id);await wait(RM?0:300);await db.del('kb',id);setRm(null)};
  return(<>
    <header><h1>Knowledge</h1></header>
    <p style={{color:'var(--mu)',marginTop:-8}}>Solara answers from these entries. Anything it can’t match goes to your team.</p>
    {!canManage&&<p className="route">Only owners and admins can change these answers.</p>}
    {canManage&&<section className="card st quick">
      <h3>Quick setup</h3>
      <p className="route">Paste your schedule, or upload a file: .txt, .csv, Excel (.xlsx), Google Sheets (File → Download → .xlsx or .csv), or PDF. Lines with problems are listed, not skipped silently.</p>
      <textarea rows="7" value={text} onChange={e=>setText(e.target.value)} placeholder={EXAMPLE} aria-label="Quick setup text"/>
      <div className="acts">
        <input type="file" accept=".txt,.csv,.tsv,.xlsx,.xls,.pdf" onChange={readFile} aria-label="Upload schedule file"/>
        <button className="btn ghost sm" type="button" onClick={()=>setText(EXAMPLE)}>Use example</button>
        <button className="btn ghost sm" type="button" onClick={()=>setFmt(true)}>Set up with Solara</button>
        <button className="btn ghost sm" type="button" onClick={async()=>{const n=await addStarterAnswers(db,user.id,kb);toast(n?`Added ${n} starter answers`:'Starter answers already added')}}>Add starter answers</button>
        <button className="btn sm" type="button" disabled={!plan.doctors.length&&!plan.answers.length} onClick={runImport}>Import {plan.doctors.length} doctors · {plan.answers.length} answers</button>
      </div>
      {fmt&&<SolaraFormat toast={toast} onClose={()=>setFmt(false)} onImport={async p=>{importPlan(p);setFmt(false)}}/>}
      {preview&&<ImportPreview diff={preview} onApply={applyImport} onCancel={()=>setPreview(null)}/>}
      {last&&!text&&<p className="route">Last import: {last.doctors.length} doctors, {last.answers.length} answers{last.errors.length?`, ${last.errors.length} lines skipped`:''}.</p>}
      {!!plan.notes.length&&<ul className="notes">{plan.notes.map((n,i)=><li key={i}>Filled in: {n.why}</li>)}</ul>}
      {!!plan.errors.length&&<ul className="errs">{plan.errors.map(e=><li key={e.line}>Line {e.line}: {e.why} — <code>{e.text}</code></li>)}</ul>}
    </section>}
    <div className="grid2">
      <div>
        {kb.map((x,i)=>(
          <div key={x.id} className={'kb st'+(rm===x.id?' rm':'')} style={{'--i':Math.min(i,14)}}>
            <div><b>{x.title}</b>{x.starter&&<span className="pill"> sample, check it</span>}<br/>{x.body}<br/><small>Triggers: {x.keywords}</small></div>
            {canManage&&<button className="btn ghost sm" aria-label={'Delete '+x.title} onClick={()=>del(x.id)}>Delete</button>}
          </div>))}
        {!kb.length&&<div className="empty">Add your first answer.</div>}
      </div>
      {canManage&&<form className="card st" style={{'--i':1}} onSubmit={add}><h3 style={{marginBottom:12}}>Add an answer</h3>
        <div className="f"><label htmlFor="kt">Topic</label><input id="kt" required value={f.title} onChange={set('title')}/></div>
        <div className="f"><label htmlFor="kb">Answer</label><textarea id="kb" rows="4" required value={f.body} onChange={set('body')}/></div>
        <div className="f"><label htmlFor="kk">Trigger words (space separated)</label><input id="kk" required placeholder="parking directions address" value={f.keywords} onChange={set('keywords')}/></div>
        <button className="btn">Save answer</button>
      </form>}
    </div>
  </>);
}
