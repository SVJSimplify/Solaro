import {useEffect,useRef,useState} from 'react';
import DateTimePicker from './DateTimePicker';
import {Icon} from './ui';

/* A compact date control: a button that shows the chosen day and opens the calendar in a popover. */
export default function DateButton({value,onChange,label,title='Pick a day'}){
  const [on,setOn]=useState(false),ref=useRef(null);
  useEffect(()=>{
    if(!on)return;
    const out=e=>{if(!ref.current?.contains(e.target))setOn(false)},key=e=>{if(e.key==='Escape'){e.stopPropagation();setOn(false)}};
    document.addEventListener('mousedown',out);document.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('mousedown',out);document.removeEventListener('keydown',key,true)};
  },[on]);
  return(<span className="datebtn" ref={ref}>
    <button type="button" className="btn ghost sm" aria-haspopup="dialog" aria-expanded={on} onClick={()=>setOn(!on)}><Icon n="cal" size={16}/>{label}</button>
    {on&&<div className="popover" role="dialog" aria-label={title}><DateTimePicker mode="date" value={value} onChange={v=>{if(v){onChange(v);setOn(false)}}} label={title}/></div>}
  </span>);
}
