import {useEffect,useMemo,useRef,useState} from 'react';
import '../timeclock.css';

/* Clock-face time picker limited to the clinic's real open times.
   slots: ["HH:MM", ...] already filtered by doctor schedules, closures, leave and existing bookings.
   value/onChange use "HH:MM" (24h). Only a listed slot can ever be chosen. */
const pad=n=>String(n).padStart(2,'0');
const toMin=t=>{const [h,m]=t.split(':').map(Number);return h*60+m};
export const label12=t=>{const [h,m]=t.split(':').map(Number);return `${h%12||12}:${pad(m)} ${h<12?'AM':'PM'}`};
const SIZE=232,C=SIZE/2,R_NUM=96,R_DOT=74;
const polar=(min12,r)=>{const a=(min12/720)*2*Math.PI-Math.PI/2;return[C+r*Math.cos(a),C+r*Math.sin(a)]};

export default function TimeClock({slots,value,onChange,label='Time',disabled=false}){
  const sorted=useMemo(()=>[...new Set(slots||[])].sort((a,b)=>toMin(a)-toMin(b)),[slots]);
  const has=h=>sorted.some(t=>(toMin(t)<720)===(h==='AM'));
  // Every interval mark between the first and last open time (30 min unless open times are finer), so taken or
  // unavailable times still show as hollow marks. Only open times can be chosen.
  const grid=useMemo(()=>{
    if(!sorted.length)return[];
    const mins=sorted.map(toMin),diffs=mins.slice(1).map((m,i)=>m-mins[i]).filter(d=>d>0);
    const stepM=Math.max(15,Math.min(30,...diffs));
    const out=[];for(let m=mins[0];m<=mins.at(-1);m+=stepM)out.push(`${pad(Math.floor(m/60))}:${pad(m%60)}`);
    return[...new Set([...out,...sorted])].sort((a,b)=>toMin(a)-toMin(b));
  },[sorted]);
  const [half,setHalf]=useState(()=>value?(toMin(value)<720?'AM':'PM'):(has('AM')?'AM':'PM'));
  const shown=has(half)?half:(has('AM')?'AM':'PM');
  const inHalf=sorted.filter(t=>(toMin(t)<720)===(shown==='AM'));
  const svg=useRef(null),drag=useRef(false);
  const sel=sorted.includes(value)?value:'';
  // Keep AM/PM on the half of the chosen time when the time changes from outside (day change, stepping, reset).
  useEffect(()=>{if(sel)setHalf(toMin(sel)<720?'AM':'PM')},[sel]);
  const idx=sorted.indexOf(sel);

  const choose=t=>{if(!t||disabled)return;setHalf(toMin(t)<720?'AM':'PM');onChange(t)};
  const step=k=>{if(!sorted.length)return;choose(sorted[idx<0?(k>0?0:sorted.length-1):Math.min(sorted.length-1,Math.max(0,idx+k))])};

  // Pointer position on the dial snaps to the nearest open slot in the visible half.
  const pick=e=>{
    if(!inHalf.length||!svg.current)return;
    const b=svg.current.getBoundingClientRect(),x=(e.clientX-b.left)/b.width*SIZE-C,y=(e.clientY-b.top)/b.height*SIZE-C;
    let ang=Math.atan2(y,x)+Math.PI/2;if(ang<0)ang+=2*Math.PI;
    const m=ang/(2*Math.PI)*720,dist=t=>{const d=Math.abs(toMin(t)%720-m);return Math.min(d,720-d)};
    choose(inHalf.reduce((a,t)=>dist(t)<dist(a)?t:a));
  };
  const onKey=e=>{
    const k={ArrowRight:1,ArrowUp:1,ArrowLeft:-1,ArrowDown:-1,PageUp:4,PageDown:-4}[e.key];
    if(k){e.preventDefault();step(k)}
    else if(e.key==='Home'){e.preventDefault();choose(sorted[0])}
    else if(e.key==='End'){e.preventDefault();choose(sorted.at(-1))}
  };

  if(!sorted.length)return<p className="tc-empty" role="status">No open times on this day. Please choose another day.</p>;

  const hand=sel&&(toMin(sel)<720)===(shown==='AM')?polar(toMin(sel)%720,R_DOT):null;
  return(
    <div className={'tc'+(disabled?' tc-off':'')}>
      <div className="tc-top">
        <button type="button" className="tc-step" onClick={()=>step(-1)} disabled={disabled||idx===0} aria-label="Earlier open time">‹</button>
        <output className="tc-read" aria-live="polite">{sel?label12(sel):'Pick a time'}</output>
        <button type="button" className="tc-step" onClick={()=>step(1)} disabled={disabled||idx===sorted.length-1} aria-label="Later open time">›</button>
      </div>
      <div className="tc-half" role="group" aria-label="Morning or afternoon">
        {['AM','PM'].map(h=><button key={h} type="button" aria-pressed={shown===h} disabled={disabled||!has(h)} onClick={()=>setHalf(h)}>{h}</button>)}
      </div>
      <svg ref={svg} className="tc-dial" viewBox={`0 0 ${SIZE} ${SIZE}`} role="slider" tabIndex={disabled?-1:0}
        aria-label={label} aria-valuemin={0} aria-valuemax={sorted.length-1} aria-valuenow={Math.max(0,idx)}
        aria-valuetext={sel?`${label12(sel)}, ${idx+1} of ${sorted.length} open times`:`No time chosen. ${sorted.length} open times; use arrow keys`}
        onKeyDown={onKey}
        onPointerDown={e=>{if(disabled)return;e.preventDefault();e.currentTarget.focus({preventScroll:true});drag.current=true;e.currentTarget.setPointerCapture?.(e.pointerId);pick(e)}}
        onPointerMove={e=>drag.current&&pick(e)}
        onPointerUp={()=>{drag.current=false}} onPointerCancel={()=>{drag.current=false}}>
        <circle cx={C} cy={C} r={C-4} className="tc-face"/>
        {Array.from({length:12},(_,i)=>{const [x,y]=polar(((i||12)%12)*60,R_NUM);return<text key={i} x={x} y={y} className="tc-num" textAnchor="middle" dominantBaseline="central">{i||12}</text>})}
        {hand&&<line x1={C} y1={C} x2={hand[0]} y2={hand[1]} className="tc-hand"/>}
        {grid.filter(t=>(toMin(t)<720)===(shown==='AM')).map(t=>{const [x,y]=polar(toMin(t)%720,R_DOT),open=sorted.includes(t),on=t===sel;
          return<circle key={t} cx={x} cy={y} r={on?11:open?5.5:4} className={'tc-slot'+(on?' on':open?'':' shut')}><title>{label12(t)+(open?'':' · not available')}</title></circle>})}
        <circle cx={C} cy={C} r={4} className="tc-pin"/>
      </svg>
      <p className="tc-hint">{inHalf.length} open {shown==='AM'?'morning':'afternoon'} time{inHalf.length===1?'':'s'}{grid.length>sorted.length?' · hollow = taken or unavailable':''}</p>
    </div>);
}
