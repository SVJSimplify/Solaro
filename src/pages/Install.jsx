import {useEffect,useMemo,useState} from 'react';
import {db} from '../lib/db';
import {useAuth,useToast} from '../lib/hooks';

/* Put the chat on the clinic's website: customise the button, copy one line, follow the steps for their
   website builder, then see it confirmed live (embed.js reports each site it loads on). */
const PLATFORMS={
  html:{name:'Any website / HTML',steps:['Open the HTML of every page (or your shared footer/template).','Paste the code just before </body>.','Save and publish.']},
  wordpress:{name:'WordPress',steps:['Install the free "WPCode" (Insert Headers and Footers) plugin.','Go to Code Snippets → Header & Footer.','Paste the code into "Footer" and click Save.']},
  wix:{name:'Wix',steps:['Open Settings → Custom code (under Advanced).','Click "+ Add Custom Code" and paste the code.','Choose "All pages", place it in "Body - end", and click Apply.']},
  squarespace:{name:'Squarespace',steps:['Open Settings → Advanced → Code Injection.','Paste the code into "Footer".','Click Save.']},
  shopify:{name:'Shopify',steps:['Open Online Store → Themes → … → Edit code.','Open layout/theme.liquid.','Paste the code just before </body> and click Save.']},
  gtm:{name:'Google Tag Manager',steps:['Create a new tag of type "Custom HTML".','Paste the code and set the trigger to "All Pages".','Save, then Submit/Publish the container.']},
};
const ago=t=>{const m=Math.round((Date.now()-Date.parse(t))/6e4);return m<2?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`};

export default function Install(){
  const {user:me}=useAuth(),toast=useToast();
  const [label,setLabel]=useState('Chat with us'),[color,setColor]=useState('#C9413A'),[side,setSide]=useState('right');
  const [pf,setPf]=useState('html'),[sites,setSites]=useState(undefined),[checking,setChecking]=useState(false);
  const code=useMemo(()=>{
    const a=[`src="${location.origin}/embed.js"`,`data-org="${me.org}"`];
    const l=label.trim().replace(/["<>&]/g,'');
    if(l&&l!=='Chat with us')a.push(`data-label="${l}"`);
    if(color.toLowerCase()!=='#c9413a')a.push(`data-color="${color}"`);
    if(side==='left')a.push('data-position="left"');
    return `<script ${a.join(' ')} async></script>`;
  },[label,color,side,me.org]);
  const check=async()=>{setChecking(true);try{setSites(await db.widgetInstalls())}finally{setChecking(false)}};
  useEffect(()=>{check()},[]);// eslint-disable-line react-hooks/exhaustive-deps
  const copy=()=>{navigator.clipboard?.writeText(code);toast('Code copied')};

  if(!['owner','admin'].includes(me.role))return<><header><h1>Website chat</h1></header><p className="route">Ask an owner or admin to add the chat to your website.</p></>;
  return(<>
    <header><h1>Website chat</h1><p className="route">Add Solara to your website in about two minutes. Patients can ask questions and request appointments from any page.</p></header>
    <div className="inst">
      <section className="card st">
        <h3><span className="inst-n">1</span>Make it yours</h3>
        <div className="f"><label htmlFor="il">Button text</label><input id="il" value={label} maxLength={30} onChange={e=>setLabel(e.target.value)}/></div>
        <div className="inst-row">
          <div className="f"><label htmlFor="ic">Button colour</label><input id="ic" type="color" value={color} onChange={e=>setColor(e.target.value)}/></div>
          <div className="f"><label htmlFor="ip">Position</label><select id="ip" value={side} onChange={e=>setSide(e.target.value)}><option value="right">Bottom right</option><option value="left">Bottom left</option></select></div>
        </div>
        <div className="inst-prev" aria-hidden="true"><span className="inst-btn" style={{background:color,[side]:16}}>💬 {label.trim()||'Chat with us'}</span></div>
        <a className="btn ghost sm" href={`/widget?org=${me.org}`} target="_blank" rel="noopener">Open the chat to try it</a>
      </section>

      <section className="card st">
        <h3><span className="inst-n">2</span>Copy your code</h3>
        <textarea readOnly rows={3} aria-label="Website chat code" value={code} onFocus={e=>e.target.select()}/>
        <button type="button" className="btn" onClick={copy}>Copy code</button>
        <p className="route">One line. It loads after your page, so it won't slow your site down.</p>
      </section>

      <section className="card st">
        <h3><span className="inst-n">3</span>Paste it into your website</h3>
        <div className="inst-tabs" role="tablist">{Object.entries(PLATFORMS).map(([k,v])=>
          <button key={k} type="button" role="tab" aria-selected={pf===k} className={'inst-tab'+(pf===k?' on':'')} onClick={()=>setPf(k)}>{v.name}</button>)}</div>
        <ol className="inst-steps">{PLATFORMS[pf].steps.map(s=><li key={s}>{s}</li>)}</ol>
        <p className="route">Someone else runs your website? <button type="button" className="linkbtn" onClick={()=>{navigator.clipboard?.writeText(`Hi! Please add this line just before </body> on every page of our website:\n\n${code}\n\nThanks!`);toast('Message copied, ready to send')}}>Copy a message for them</button></p>
      </section>

      <section className="card st">
        <h3><span className="inst-n">4</span>Check it's live</h3>
        <p className="route">Open your website once after publishing, then check here.</p>
        {sites===null&&<p className="route">Install checking isn't switched on yet for your account. The chat still works once the code is on your site.</p>}
        {sites?.length===0&&<p className="inst-wait">Not seen on any website yet.</p>}
        {sites?.length>0&&<ul className="inst-sites">{sites.map(s=><li key={s.origin}><span className="inst-dot"/><b>{s.origin.replace(/^https?:\/\//,'')}</b><small>last seen {ago(s.last_seen)}</small></li>)}</ul>}
        <button type="button" className="btn ghost sm" onClick={check} disabled={checking}>{checking?'Checking…':'Check again'}</button>
      </section>
    </div>
  </>);
}
