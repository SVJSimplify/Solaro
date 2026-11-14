import {useCallback,useEffect,useState} from 'react';
import {useAuth,useTable} from './hooks';
import {clinicNow,openSlots} from './avail';
import {isWhenField,serviceOf,whenLabel} from './whenField';
import {formSubmission} from '../../supabase/functions/_shared/agent.js';
import DateTimePicker from './DateTimePicker';
import {normalizePhone,isValidPhone} from './phone';
import '../forms.css';
import {PhoneField,phoneProblem} from './fields';

/* Input rules derived from what the field is, so Solara's forms reject bad characters and overlong values. */
const hint=f=>(f.name+' '+f.label).toLowerCase();
const isPhone=f=>f.type==='tel'||/phone|mobile|\btel\b/.test(hint(f));
const isEmail=f=>f.type==='email'||/e-?mail/.test(hint(f));
const isName=f=>f.type==='text'&&/\bname\b/.test(hint(f));
const isCount=f=>f.type==='text'&&/\b(age|quantity|qty|party size|guests)\b/.test(hint(f));
function rulesFor(f){
  if(isPhone(f))return{phone:true,type:'tel',inputMode:'tel',maxLength:20,clean:s=>s.replace(/[^0-9+()\s.-]/g,'')};
  if(isEmail(f))return{type:'email',maxLength:254,clean:s=>s.replace(/\s/g,'')};
  if(isName(f))return{type:'text',maxLength:80,clean:s=>s.replace(/[^\p{L}\s'.-]/gu,'')};
  if(isCount(f))return{type:'text',inputMode:'numeric',maxLength:3,clean:s=>s.replace(/\D/g,'')};
  if(f.type==='textarea')return{maxLength:1000,clean:s=>s};
  return{type:'text',maxLength:200,clean:s=>s};
}

/* A form the assistant asked for. Locked once submitted; the answers go back to the model as a customer message. */
/* The clinic's open times for a date (doctor hours, closures, leave and existing bookings), as unique "HH:MM".
   Display only: the booking tools re-check every request on the server. */
function useOpenTimes(service){
  const {user}=useAuth(),[docs]=useTable('doctors'),[rows]=useTable('bookings'),[closed]=useTable('closures'),[leave]=useTable('leave');
  return useCallback(date=>{
    if(!docs.length)return[];
    const now=clinicNow(user?.tz);
    return[...new Set(openSlots(docs,date,rows,leave,closed,{service:service||undefined,now}).map(s=>s.when.slice(11)))];
  },[docs,rows,closed,leave,service,user?.tz]);
}

export default function FormCard({form,done,onSubmit}){
  const [v,setV]=useState({}),[bad,setBad]=useState('');
  const openTimes=useOpenTimes(serviceOf(form,v));
  const whenF=form.fields.find(isWhenField);
  // A time that is no longer open (service changed, or the schedule refreshed) is cleared rather than submitted.
  useEffect(()=>{
    if(!whenF)return;
    const w=v[whenF.name]||'',t=w.slice(11);
    if(!done&&t&&!openTimes(w.slice(0,10)).includes(t))setV(p=>({...p,[whenF.name]:w.slice(0,11)}));
  },[openTimes,v,whenF,done]);
  const set=(name,val)=>setV(p=>({...p,[name]:val}));
  const submit=e=>{
    e.preventDefault();
    if(done)return;
    const badPhone=form.fields.find(f=>rulesFor(f).phone&&(phoneProblem(v[f.name])||!isValidPhone(v[f.name])));
    const noTime=whenF&&(whenF.required||v[whenF.name])&&!/T\d\d:\d\d$/.test(v[whenF.name]||'')?whenF:null;
    setBad(badPhone?badPhone.name:noTime?noTime.name:'');
    if(badPhone||noTime)return;
    const out={...v};
    if(whenF)form.fields.forEach(f=>{if(f!==whenF&&isWhenField(f))out[f.name]=v[whenF.name]});
    form.fields.forEach(f=>{if(rulesFor(f).phone)out[f.name]=normalizePhone(v[f.name])});
    onSubmit(form,formSubmission(form,out));
  };
  return(
    <form className={'fc'+(done?' done':'')} onSubmit={submit} aria-label={form.title}>
      <h4>{form.title}</h4>
      {form.fields.map(f=>{
        const id=`${form.id}-${f.name}`;
        const R=rulesFor(f);
        const common={id,name:f.name,required:f.required||!!R.phone,disabled:done,value:v[f.name]??'',onChange:e=>set(f.name,R.clean(e.target.value))};
        if(f!==whenF&&isWhenField(f))return null;   // a second date/time field is covered by the one clock
        if(f===whenF)return(
          <div key={f.name} className="fc-pick"><span className="flabel">{whenLabel(form,f)}{f.required&&' *'}</span>
            <DateTimePicker mode="datetime" value={v[f.name]??''} onChange={val=>set(f.name,val)} label={whenLabel(form,f)} openTimes={openTimes}/>
            {bad===f.name&&<small className="err">Please choose a day and an open time.</small>}</div>);
        if(f.type==='date'||f.type==='datetime-local')return(
          <div key={f.name} className="fc-pick"><span className="flabel">{f.label}{f.required&&' *'}</span>
            <DateTimePicker mode={f.type==='date'?'date':'datetime'} value={v[f.name]??''} onChange={val=>set(f.name,val)} label={f.label}/></div>);
        if(R.phone)return<PhoneField key={f.name} id={id} label={f.label} value={v[f.name]??''} onChange={val=>set(f.name,val)} disabled={done} show={bad===f.name} autoComplete="tel"/>;
        return(
          <label key={f.name} htmlFor={id}>{f.label}{(f.required||R.phone)&&' *'}
            {f.type==='select'
              ?<select {...common}><option value="">Choose…</option>{f.options.map(o=><option key={o}>{o}</option>)}</select>
              :f.type==='textarea'?<textarea rows={2} {...common} maxLength={R.maxLength}/>
              :<input {...common} type={R.type||f.type} inputMode={R.inputMode} maxLength={R.maxLength}/>}
            {bad===f.name&&<small className="err">Enter a valid US or Indian number, e.g. +1 555 234 5678 or +91 98765 43210</small>}
          </label>);
      })}
      {!done&&<button className="btn sm">{form.submit}</button>}
    </form>);
}
