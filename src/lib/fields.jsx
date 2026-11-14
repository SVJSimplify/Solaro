/* Form fields with rules. A field only accepts characters that make sense for what it is, enforces its length while you type,
   and explains what is wrong once you leave it (or after a submit attempt). Forms call problem()/phoneProblem() before saving,
   so the same rule decides both the message and whether the form goes through. */
import {useState} from 'react';
import {countryForTimeZone} from './phone';

const EMAIL=/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const tidy=s=>s.replace(/\s{2,}/g,' ').replace(/^\s+/,'');
export const KIND={
  person:{max:80,min:2,clean:s=>tidy(s.replace(/[^\p{L}\p{M} .'’-]/gu,'')),attrs:{autoCapitalize:'words',spellCheck:false}},
  business:{max:80,min:2,clean:s=>tidy(s.replace(/[<>{}[\]\\|^~`]/g,''))},
  email:{max:254,clean:s=>s.replace(/\s/g,''),test:v=>EMAIL.test(v),bad:'Enter an email address like name@clinic.com.',attrs:{type:'email',inputMode:'email',autoCapitalize:'none',spellCheck:false}},
  password:{max:72,exact:true,attrs:{type:'password'}},
  line:{max:160,clean:s=>tidy(s.replace(/[\r\n\t]/g,' '))},
  service:{max:60,min:2,clean:s=>tidy(s.replace(/[^\p{L}\p{N} &/+.,'’()-]/gu,''))},
  words:{max:200,min:2,clean:s=>tidy(s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,''))},
  text:{max:2000,min:2},
  number:{max:6,clean:s=>s.replace(/\D/g,''),attrs:{inputMode:'numeric'}},
  model:{max:60,clean:s=>s.replace(/[^A-Za-z0-9._:/-]/g,''),attrs:{spellCheck:false,autoCapitalize:'none'}},
};
/* '' when the value is fine, otherwise the sentence to show. */
export function problem(kind,value,{required=true,label='This field',min}={}){
  const k=KIND[kind],v=k.exact?String(value||''):String(value||'').trim(),lo=min??k.min;
  if(!v)return required?`${label} is required.`:'';
  if(lo&&v.length<lo)return `${label} needs at least ${lo} characters.`;
  if(v.length>k.max)return `${label} can be at most ${k.max} characters.`;
  if(k.test&&!k.test(v))return k.bad;
  return '';
}
export function Field({id,label,kind='line',value,onChange,required=true,min,hint,rows,count,show,...rest}){
  const [seen,setSeen]=useState(false),k=KIND[kind],err=(seen||show)?problem(kind,value,{required,label,min}):'';
  const p={id,value:value??'',maxLength:k.max,required,'aria-invalid':err?true:undefined,'aria-describedby':id+'-m',onBlur:()=>setSeen(true),
    onChange:e=>onChange(k.clean?k.clean(e.target.value):e.target.value),...k.attrs,...rest};
  return(<div className={'f'+(err?' bad':'')}>
    <label htmlFor={id}>{label}{!required&&<i> (optional)</i>}</label>
    {rows?<textarea rows={rows} {...p}/>:<input {...p}/>}
    <small id={id+'-m'} className={err?'ferr':'fhint'} role={err?'alert':undefined}><span>{err||hint||''}</span>{count&&<span>{String(value||'').length}/{k.max}</span>}</small>
  </div>);
}

/* ---------- Phone: US (+1) or India (+91), chosen with a toggle. The value handed back is always dial code + digits. ---------- */
const C={
  US:{dial:'+1',name:'US',ok:d=>/^[2-9]\d{2}[2-9]\d{6}$/.test(d),ph:'(415) 555-0132',bad:'Enter a 10-digit US number, area code first.',
    fmt:d=>d.length>6?`(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`:d.length>3?`(${d.slice(0,3)}) ${d.slice(3)}`:d},
  IN:{dial:'+91',name:'India',ok:d=>/^[6-9]\d{9}$/.test(d),ph:'98765 43210',bad:'Enter a 10-digit Indian mobile number starting with 6, 7, 8 or 9.',
    fmt:d=>d.length>5?`${d.slice(0,5)} ${d.slice(5)}`:d},
};
export const phoneParts=(v,fallback='US')=>{
  const s=String(v||'').replace(/[^\d+]/g,'');
  if(s.startsWith('+91'))return{c:'IN',d:s.slice(3,13)};
  if(s.startsWith('+1'))return{c:'US',d:s.slice(2,12)};
  return{c:fallback,d:s.replace(/\D/g,'').slice(-10)};
};
export function phoneProblem(v,{required=true,label='Phone number',fallback}={}){
  const {c,d}=phoneParts(v,fallback);
  if(!d)return required?`${label} is required.`:'';
  return C[c].ok(d)?'':C[c].bad;
}
export function PhoneField({id,label='Phone',value,onChange,tz,required=true,hint,show,disabled,autoComplete='off'}){
  const [pref,setPref]=useState(()=>phoneParts(value,countryForTimeZone(tz)).c),[seen,setSeen]=useState(false);
  const {c,d}=String(value||'').startsWith('+')?phoneParts(value,pref):{c:pref,d:phoneParts(value,pref).d};
  const emit=(cc,dd)=>onChange(dd?C[cc].dial+dd:'');
  const type=e=>{
    let raw=e.target.value.replace(/\D/g,''),cc=c;
    // A pasted number may carry its country code or a trunk zero.
    if(raw.length===12&&raw.startsWith('91')){cc='IN';raw=raw.slice(2)}
    else if(raw.length===11&&raw[0]==='1'){cc='US';raw=raw.slice(1)}
    else if(raw.length===11&&raw[0]==='0'){raw=raw.slice(1)}
    if(cc!==c)setPref(cc);
    emit(cc,raw.slice(0,10));
  };
  const err=(seen||show)?(!d?(required?`${label} is required.`:''):C[c].ok(d)?'':C[c].bad):'';
  return(<div className={'f'+(err?' bad':'')}>
    <label htmlFor={id}>{label}{!required&&<i> (optional)</i>}</label>
    <div className="phone">
      <div className="seg" role="group" aria-label="Country">{Object.entries(C).map(([k,x])=><button key={k} type="button" className="btn sm" aria-pressed={k===c} disabled={disabled} onClick={()=>{setPref(k);emit(k,d)}}>{x.name} {x.dial}</button>)}</div>
      <input id={id} type="tel" inputMode="numeric" autoComplete={autoComplete} value={C[c].fmt(d)} onChange={type} onBlur={()=>setSeen(true)} placeholder={C[c].ph} maxLength={14}
        required={required} disabled={disabled} aria-invalid={err?true:undefined} aria-describedby={id+'-m'}/>
    </div>
    <small id={id+'-m'} className={err?'ferr':'fhint'} role={err?'alert':undefined}><span>{err||hint||''}</span></small>
  </div>);
}
