import {useState} from 'react';
import '../forms.css';

/* Shows the customer's number with one-tap call and copy, so staff can dial it from the phone. */
export default function CallPanel({phone,onClose}){
  const [copied,setCopied]=useState(false);
  const digits=phone.replace(/[^\d+]/g,'');
  const copy=async()=>{try{await navigator.clipboard.writeText(digits);setCopied(true);setTimeout(()=>setCopied(false),1500)}catch(e){}};
  return(
    <div className="callp" role="dialog" aria-label="Customer phone number">
      <div className="callp-num">{phone}</div>
      <div className="callp-acts">
        <a className="btn sm" href={'tel:'+digits}>Call</a>
        <button className="btn sm ghost" onClick={copy}>{copied?'Copied':'Copy number'}</button>
        {onClose&&<button className="btn sm ghost" onClick={onClose}>Close</button>}
      </div>
    </div>
  );
}
