import {useEffect,useState} from 'react';

/* Reveals a new reply word by word so it arrives smoothly instead of popping in. Old messages render whole. */
export function Reveal({text,animate}){
  const words=String(text??'').split(/(\s+)/),[n,setN]=useState(animate?0:words.length);
  useEffect(()=>{
    if(!animate){setN(words.length);return}
    let i=0;const step=Math.max(1,Math.ceil(words.length/60));
    const t=setInterval(()=>{i+=step;setN(Math.min(i,words.length));if(i>=words.length)clearInterval(t)},28);
    return()=>clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[text,animate]);
  return n>=words.length?text:<>{words.slice(0,n).join('')}<span className="caret" aria-hidden="true"/></>;
}
