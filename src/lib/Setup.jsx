/* Getting-started checklist on Today. Every item is read from the clinic's real data, so it ticks itself off.
   Shown to owners and admins until everything is done; it can be hidden, and comes back if a step is undone. */
import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {db} from './db';
import {useAuth} from './hooks';
import {Icon} from './ui';

const KEY=org=>'solara.setupHidden.'+org;

export default function Setup(){
  const {user}=useAuth(),[items,setItems]=useState(null);
  const [hidden,setHidden]=useState(()=>{try{return localStorage.getItem(KEY(user.org))}catch{return null}});
  useEffect(()=>{if(['owner','admin'].includes(user.role))db.setup().then(setItems).catch(()=>setItems(null))},[user.org,user.role]);
  if(!items?.length)return null;
  const done=items.filter(i=>i.done).length,todo=items.length-done;
  const sig=items.map(i=>i.done?1:0).join('');
  if(!todo||hidden===sig)return null;
  const hide=()=>{try{localStorage.setItem(KEY(user.org),sig)}catch{}setHidden(sig)};
  return(<section className="card st setup" aria-label="Getting started">
    <div className="setup-head">
      <div><h3>Finish setting up Solara</h3><p className="route">{done} of {items.length} done. Each step makes the front desk more useful for your patients.</p></div>
      <button type="button" className="btn ghost sm" onClick={hide}>Hide</button>
    </div>
    <div className="setup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done}><i style={{width:(100*done/items.length)+'%'}}/></div>
    <ul className="setup-list">{items.map(i=><li key={i.key} className={i.done?'done':''}>
      <span className="setup-tick" aria-hidden="true">{i.done&&<Icon n="check" size={14}/>}</span>
      {i.done?<span>{i.label}</span>:<Link to={i.href}>{i.label}</Link>}
      <span className="sr">{i.done?' (done)':' (to do)'}</span>
    </li>)}</ul>
  </section>);
}
