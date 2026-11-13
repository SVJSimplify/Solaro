import {useState,useEffect,useRef} from 'react';
import {callModel} from '../../supabase/functions/_shared/agent.js';
import {devProviders} from './llm';
import {parseSetup} from './importer';
import {readSetupFile} from './readFile';
import {AI_PROMPT,stripFence} from './aiPrompt';
import '../forms.css';

/* Separate widget: paste or upload any messy document, Solara formats it and imports it. */
export default function SolaraFormat({onImport,onClose,toast}){
  const [text,setText]=useState(''),[busy,setBusy]=useState(false);
  const boxRef=useRef(null);
  /* Opens right under the button that launched it, so the user sees it immediately. */
  useEffect(()=>{boxRef.current?.scrollIntoView({behavior:'smooth',block:'nearest'})},[]);
  const [p]=devProviders();
  const readFile=async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{setText(await readSetupFile(f))}catch(err){toast('Could not read that file: '+err.message)}};
  const run=async()=>{
    if(!p)return toast('AI features need Solara connected to its server first');
    if(!text.trim())return toast('Paste or upload a document first');
    setBusy(true);
    try{
      const formatted=stripFence(await callModel({...p,maxTokens:4000,jsonMode:false},AI_PROMPT,[{role:'user',content:text.slice(0,30000)}]));
      await onImport(parseSetup(formatted));
    }catch(e){toast('Format failed: '+e.message)}
    finally{setBusy(false)}
  };
  return(
    <div ref={boxRef} className="solara-inline" style={{marginTop:12,scrollMarginTop:24}}>
      <div className="modal" role="region" aria-label="Set up with Solara">
        <h3>Let Solara set this up for you</h3>
        <ol className="steps">
          <li>Paste your clinic information, or upload a file.</li>
          <li>Click <b>Set up for me</b>.</li>
          <li>Solara adds your doctors and answers. Nothing to format.</li>
        </ol>
        <textarea rows="10" value={text} onChange={e=>setText(e.target.value)} placeholder="Paste your messy document here…" aria-label="Document text" disabled={busy}/>
        <div className="acts">
          <input type="file" accept=".txt,.csv,.tsv,.xlsx,.xls,.pdf" onChange={readFile} disabled={busy} aria-label="Upload document"/>
          <button className="btn sm" type="button" onClick={run} disabled={busy||!text.trim()}>{busy?'Setting up…':'Set up for me'}</button>
          <button className="btn ghost sm" type="button" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </div>
    </div>
  );
}
