import {OwnAppEmbed,SolaraAppQr} from '../lib/AppChannels';
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
// "www.clinic.com/contact" → "https://www.clinic.com"
const toOrigin=v=>{const t=v.trim();if(!t)return'';try{return new URL(/^https?:\/\//i.test(t)?t:'https://'+t).origin.toLowerCase()}catch{return null}};
const ago=t=>{const m=Math.round((Date.now()-Date.parse(t))/6e4);return m<2?'just now':m<60?`${m} min ago`:m<1440?`${Math.round(m/60)} h ago`:`${Math.round(m/1440)} d ago`};

export default function Install(){
  const {user:me}=useAuth(),toast=useToast();
  const [label,setLabel]=useState('Chat with us'),[color,setColor]=useState('#D96F54'),[side,setSide]=useState('right');
  const [wkey,setWkey]=useState(null),[pf,setPf]=useState('html'),[sites,setSites]=useState(undefined),[checking,setChecking]=useState(false);
  const [origins,setOrigins]=useState(null),[site,setSite]=useState(''),[saving,setSaving]=useState(false),[sri,setSri]=useState(null);
  const code=useMemo(()=>{
    // Pinned, integrity-checked script when the build published one; the legacy path otherwise (local development).
    const a=sri?[`src="${location.origin}${sri.src}"`,`integrity="${sri.integrity}"`,'crossorigin="anonymous"',`data-key="${wkey}"`]
      :[`src="${location.origin}/embed.js"`,`data-key="${wkey}"`];
    const l=label.trim().replace(/["<>&]/g,'');
    if(l&&l!=='Chat with us')a.push(`data-label="${l}"`);
    if(color.toLowerCase()!=='#d96f54')a.push(`data-color="${color}"`);
    if(side==='left')a.push('data-position="left"');
    return `<script ${a.join(' ')} async></script>`;
  },[label,color,side,wkey,sri]);
  const check=async()=>{setChecking(true);try{setSites(await db.widgetInstalls())}finally{setChecking(false)}};
  useEffect(()=>{check();setWkey(null);db.widgetKey().then(setWkey).catch(()=>toast('Could not load your website key'));
    setOrigins(null);db.widgetOrigins().then(setOrigins).catch(()=>setOrigins([]))},[me.org]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{fetch('/embed/manifest.json').then(r=>r.ok?r.json():null).then(m=>m?.src&&m?.integrity&&setSri(m)).catch(()=>{})},[]);
  const saveOrigins=async list=>{setSaving(true);try{setOrigins(await db.setWidgetOrigins(me.id,list));check();return true}catch(e){toast(e.message);return false}finally{setSaving(false)}};
  const addSite=async e=>{e.preventDefault();const o=toOrigin(site);
    if(!o)return toast('Enter a website address like www.yourclinic.com');
    if(origins?.includes(o))return setSite('');
    if(await saveOrigins([...(origins||[]),o])){setSite('');toast('Allowed: '+o.replace(/^https?:\/\//,''))}};
  const rotate=async()=>{if(!confirm('Make a new key? The chat stops working on any website still using the old code until you paste the new one.'))return;
    try{setWkey(await db.widgetKeyRotate());toast('New key made. Paste the new code on your website.')}catch(e){toast(e.message)}};
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
        <a className="btn ghost sm" href={`/widget?key=${wkey}`} target="_blank" rel="noopener">Open the chat to try it</a>
      </section>

      <section className="card st">
        <h3><span className="inst-n">2</span>Copy your code</h3>
        <textarea readOnly rows={3} aria-label="Website chat code" value={wkey?code:'Loading your code…'} onFocus={e=>e.target.select()}/>
        <button type="button" className="btn" onClick={copy} disabled={!wkey}>Copy code</button>
        <p className="route">One line. It loads after your page, so it won't slow your site down. The key in it is unique to {me.biz||'your clinic'}: every chat and booking from your website lands in this dashboard.</p>
        <p className="route">Key leaked or copied somewhere it shouldn't be? <button type="button" className="linkbtn" onClick={rotate} disabled={!wkey}>Make a new key</button></p>
      </section>

      <section className="card st">
        <h3><span className="inst-n">3</span>Paste it into your website</h3>
        <div className="inst-tabs" role="tablist">{Object.entries(PLATFORMS).map(([k,v])=>
          <button key={k} type="button" role="tab" aria-selected={pf===k} className={'inst-tab'+(pf===k?' on':'')} onClick={()=>setPf(k)}>{v.name}</button>)}</div>
        <ol className="inst-steps">{PLATFORMS[pf].steps.map(s=><li key={s}>{s}</li>)}</ol>
        <p className="route">Someone else runs your website? <button type="button" className="linkbtn" onClick={()=>{navigator.clipboard?.writeText(`Hi! Please add this line just before </body> on every page of our website:\n\n${code}\n\nThanks!`);toast('Message copied, ready to send')}}>Copy a message for them</button></p>
      </section>

      <section className="card st">
        <h3><span className="inst-n">4</span>Allow your website</h3>
        <p className="route">The chat only opens on websites listed here, so nobody can put your clinic's chat on their own site.</p>
        {origins===null?<p className="route">Loading…</p>:origins.length===0
          ?<p className="inst-wait">No websites allowed yet. Add yours below, or the chat button won't open on it.</p>
          :<ul className="inst-sites">{origins.map(o=><li key={o}><span className="inst-dot"/><b>{o.replace(/^https?:\/\//,'')}</b>
            <button type="button" className="row-del" style={{position:'static',opacity:1}} aria-label={'Stop allowing '+o} title="Stop allowing this website" disabled={saving}
              onClick={()=>confirm(`Stop showing the chat on ${o}?`)&&saveOrigins(origins.filter(x=>x!==o))}>×</button></li>)}</ul>}
        <form className="inst-row" onSubmit={addSite} style={{alignItems:'flex-end'}}>
          <div className="f" style={{flex:1}}><label htmlFor="iw">Website address</label><input id="iw" value={site} onChange={e=>setSite(e.target.value)} placeholder="www.yourclinic.com" inputMode="url" autoComplete="url"/></div>
          <div className="f"><button className="btn" disabled={saving||!site.trim()}>{saving?'Saving…':'Allow'}</button></div>
        </form>
        <p className="route">Add each address people visit, e.g. both yourclinic.com and www.yourclinic.com.</p>
      </section>

      <section className="card st">
        <h3><span className="inst-n">5</span>Check it's live</h3>
        <p className="route">Open your website once after publishing, then check here.</p>
        {sites===null&&<p className="route">Install checking isn't switched on yet for your account. The chat still works once the code is on your site.</p>}
        {sites?.length===0&&<p className="inst-wait">Not seen on any website yet.</p>}
        {sites?.length>0&&<ul className="inst-sites">{sites.map(s=><li key={s.origin}><span className="inst-dot"/><b>{s.origin.replace(/^https?:\/\//,'')}</b><small>last seen {ago(s.last_seen)}</small>
          {['owner','admin'].includes(me.role)&&<button type="button" className="row-del" style={{position:'static',opacity:1}} aria-label={'Remove '+s.origin} title="Remove from this list"
            onClick={async()=>{try{await db.removeInstall(me.id,s.origin);setSites(x=>x.filter(y=>y.origin!==s.origin))}catch(e){toast(e.message)}}}>×</button>}</li>)}</ul>}
        <button type="button" className="btn ghost sm" onClick={check} disabled={checking}>{checking?'Checking…':'Check again'}</button>
      </section>

      {wkey&&<SolaraAppQr wkey={wkey} clinic={me.biz}/>}
      {wkey&&<OwnAppEmbed wkey={wkey}/>}
    </div>
  </>);
}
