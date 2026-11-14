import {useState} from 'react';
import '../forms.css';
import TimeClock,{label12} from './TimeClock';

/* Themed calendar + time picker, replacing the browser's native popup.
   mode="date" value/onChange use YYYY-MM-DD; mode="datetime" use YYYY-MM-DDTHH:MM.
   openTimes(date) -> ["HH:MM"] (optional): the clinic's real open times. When given, days with none are disabled,
   the time is chosen on a clock that only allows those times, and a date with no time yet is "YYYY-MM-DDT". */
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEK=['Su','Mo','Tu','We','Th','Fr','Sa'];
const pad=n=>String(n).padStart(2,'0');
const ymd=(y,m,d)=>`${y}-${pad(m+1)}-${pad(d)}`;
const todayYmd=()=>{const d=new Date();return ymd(d.getFullYear(),d.getMonth(),d.getDate())};
const nowHM=()=>{const d=new Date();return `${pad(d.getHours())}:${pad(d.getMinutes())}`};
const TIMES=(()=>{const out=[];for(let m=8*60;m<=17*60+30;m+=30)out.push(`${pad(Math.floor(m/60))}:${pad(m%60)}`);return out})();

export default function DateTimePicker({mode='date',value,onChange,label,openTimes}){
  const timed=mode==='datetime'&&typeof openTimes==='function';
  const datePart=value?.slice(0,10)||'';
  const timePart=value?.slice(11,16)||'';
  const seed=datePart?new Date(datePart+'T00:00'):new Date();
  const [view,setView]=useState({y:seed.getFullYear(),m:seed.getMonth()});
  const first=new Date(view.y,view.m,1).getDay();
  const days=new Date(view.y,view.m+1,0).getDate();
  const today=todayYmd();
  const shift=k=>{const d=new Date(view.y,view.m+k,1);setView({y:d.getFullYear(),m:d.getMonth()})};
  const pickDate=d=>{
    const next=ymd(view.y,view.m,d);
    if(timed){const t=openTimes(next);onChange(`${next}T${t.includes(timePart)?timePart:''}`);return}
    onChange(mode==='datetime'?`${next}T${timePart||'09:00'}`:next);
  };
  const pickTime=t=>onChange(`${datePart}T${t}`);
  const cells=[...Array(first).fill(null),...Array.from({length:days},(_,i)=>i+1)];

  return(
    <div className="dtp" role="group" aria-label={label}>
      <div className="dtp-head">
        <button type="button" className="dtp-nav" onClick={()=>shift(-1)} aria-label="Previous month">‹</button>
        <b>{MONTHS[view.m]} {view.y}</b>
        <button type="button" className="dtp-nav" onClick={()=>shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="dtp-grid">
        {WEEK.map(w=><span key={w} className="dtp-wk">{w}</span>)}
        {cells.map((d,i)=>{
          if(!d)return<span key={'e'+i}/>;
          const ymdV=ymd(view.y,view.m,d),past=ymdV<today,sel=ymdV===datePart,shut=timed&&!past&&!openTimes(ymdV).length;
          return<button key={ymdV} type="button" disabled={past||shut} title={shut?'No open times':undefined}
            className={'dtp-day'+(sel?' sel':'')+(ymdV===today?' today':'')}
            onClick={()=>pickDate(d)} aria-pressed={sel}>{d}</button>;
        })}
      </div>
      {timed&&<>
        <div className="dtp-times-label">Time</div>
        {datePart?<TimeClock slots={openTimes(datePart)} value={timePart} label={`${label||'Time'} on ${datePart}`} onChange={t=>onChange(`${datePart}T${t}`)}/>
          :<p className="tc-empty">Choose a day to see open times.</p>}
      </>}
      {mode==='datetime'&&!timed&&<>
        <div className="dtp-times-label">Time</div>
        <div className="dtp-times">
          {TIMES.map(t=>{
            const past=datePart===today&&t<nowHM();
            return<button key={t} type="button" disabled={past||!datePart}
              className={'dtp-time'+(t===timePart?' sel':'')} onClick={()=>pickTime(t)}>{t}</button>;
          })}
        </div>
      </>}
      <div className="dtp-foot">
        <span>{value?(mode==='datetime'?(timePart?`${datePart} ${timed?label12(timePart):timePart}`:`${datePart} · pick a time`):datePart):'Nothing selected'}</span>
        <button type="button" className="dtp-nav" onClick={()=>onChange('')}>Clear</button>
      </div>
    </div>
  );
}
