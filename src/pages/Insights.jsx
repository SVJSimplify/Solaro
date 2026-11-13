import {useEffect,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {db} from '../lib/db';
import {useAuth} from '../lib/hooks';
import {formatWait} from '../lib/insights';
import {nice} from '../lib/avail';
import {REASON} from '../lib/reasons';
import {Empty} from '../lib/ui';

const pct=x=>x==null?'–':Math.round(x*100)+'%';
const RANGES=[[7,'7 days'],[30,'30 days'],[90,'90 days']];
const SOURCE={staff:'Front desk',assistant:'Staff assistant',website:'Website chat'};
const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;

const Tile=({label,value,sub,to})=>{const C=to?Link:'div';return<C to={to} className="card tile"><small>{label}</small><b>{value}</b>{sub&&<span>{sub}</span>}</C>};

/* Ranked horizontal bars. With onPick each row is a button that opens the matching appointments. */
function Bars({title,rows,empty,name=x=>x,onPick,hint}){
  const top=Math.max(1,...rows.map(r=>r.n));
  return(<section className="card"><div className="card-h"><h3>{title}</h3>{onPick&&rows.length>0&&<small>{hint||'Select a row to see the appointments'}</small>}</div>
    {!rows.length?<p className="route">{empty}</p>:<ul className="hbars">{rows.map(r=>{
      const body=<><span className="hb-l">{name(r.label)}</span><span className="hb-t"><i style={{width:`${(r.n/top)*100}%`}}/></span><span className="hb-v">{r.n}</span></>;
      return<li key={r.label}>{onPick?<button onClick={()=>onPick(r.label)}>{body}</button>:<div>{body}</div>}</li>})}</ul>}
  </section>);
}

/* Appointments per day. One series, so no legend: the title names it. Hover or focus a column for the figures, select it to open that day. */
function DayChart({days,onPick}){
  const [h,setH]=useState(null),[table,setTable]=useState(false);
  const peak=Math.max(1,...days.map(d=>d.n)),half=peak>1?Math.round(peak/2):null,d=h==null?null:days[h];
  return(<section className="card">
    <div className="card-h"><h3>Appointments per day</h3><button className="lk" onClick={()=>setTable(!table)} aria-pressed={table}>{table?'Show chart':'Show as table'}</button></div>
    {table?<div className="tblwrap"><table className="tbl"><thead><tr><th>Day</th><th>Appointments</th><th>Cancelled</th></tr></thead>
        <tbody>{days.filter(x=>x.n||x.cancelled).map(x=><tr key={x.date} tabIndex={0} onClick={()=>onPick(String(x.date))} onKeyDown={e=>e.key==='Enter'&&onPick(String(x.date))}><td>{nice(String(x.date))}</td><td>{x.n}</td><td>{x.cancelled}</td></tr>)}</tbody></table></div>
      :<div className="chart">
        <div className="plot" onMouseLeave={()=>setH(null)}>
          <span className="gl" style={{bottom:'100%'}}><em>{peak}</em></span>{half&&<span className="gl" style={{bottom:`${half/peak*100}%`}}><em>{half}</em></span>}<span className="gl base"><em>0</em></span>
          <div className={'colsb'+(days.length>45?' dense':'')}>{days.map((x,i)=><button key={x.date} className={'colb'+(h===i?' on':'')} onMouseEnter={()=>setH(i)} onFocus={()=>setH(i)} onBlur={()=>setH(null)} onClick={()=>onPick(String(x.date))}
            aria-label={`${nice(String(x.date))}: ${plural(x.n,'appointment')}${x.cancelled?`, ${x.cancelled} cancelled`:''}. Open this day.`}><i style={{height:`${x.n/peak*100}%`}}/></button>)}</div>
          {d&&<div className="tip" role="status" style={{left:`${Math.min(88,Math.max(12,(h+.5)/days.length*100))}%`}}><b>{nice(String(d.date))}</b><span>{plural(d.n,'appointment')}</span>{d.cancelled>0&&<span>{d.cancelled} cancelled</span>}<small>Select to open the day</small></div>}
        </div>
        <div className="xaxis"><span>{nice(String(days[0].date))}</span><span>{nice(String(days[days.length-1].date))}</span></div>
      </div>}
  </section>);
}

/* How the period's appointments ended, as parts of one whole. Each part is labelled with its name and count, never by colour alone. */
function Outcomes({a,onPick}){
  const parts=[['completed','Completed',a.completed],['no_show','No-show',a.noShow],['booked','Needs an outcome',a.unmarked],['ahead','Still to come',Math.max(0,a.scheduled-a.completed-a.noShow-a.unmarked)],['cancelled','Cancelled',a.cancelled]].filter(p=>p[2]>0);
  const total=parts.reduce((n,p)=>n+p[2],0);
  return(<section className="card"><div className="card-h"><h3>How appointments ended</h3><small>{plural(total,'appointment')} in the period</small></div>
    {!total?<p className="route">No appointments in this period.</p>:<>
      <div className="segbar" role="img" aria-label={parts.map(p=>`${p[1]} ${p[2]}`).join(', ')}>{parts.map(([k,,n])=><i key={k} className={k} style={{flexGrow:n}}/>)}</div>
      <ul className="seglist">{parts.map(([k,l,n])=><li key={k}><button onClick={()=>onPick(k)} disabled={k==='ahead'}><i className={'sw '+k}/><span>{l}</span><b>{n}</b><small>{Math.round(n/total*100)}%</small></button></li>)}</ul>
    </>}
  </section>);
}

/* Counted on the server over the whole period, in the clinic's time zone; refreshes when the clinic's data changes. */
function useInsights(days){
  const {user}=useAuth(),[m,setM]=useState(null),[err,setErr]=useState('');
  useEffect(()=>{
    let live=true,timer;
    const load=()=>db.insights(user.id,days).then(x=>{if(live){setM(x);setErr('')}}).catch(e=>live&&setErr(e.message));
    const on=()=>{clearTimeout(timer);timer=setTimeout(load,1000)};
    load();addEventListener('solara',on);
    return()=>{live=false;clearTimeout(timer);removeEventListener('solara',on)};
  },[user.id,user.org,days]);
  return[m,err,()=>{setErr('');db.insights(user.id,days).then(setM).catch(e=>setErr(e.message))}];
}

export default function Insights(){
  const [days,setDays]=useState(30),[m,err,retry]=useInsights(days),nav=useNavigate();
  const head=<header><div><h1>Insights</h1>{m&&<p>{nice(String(m.from))} to {nice(String(m.to))}, clinic time. Counted from every appointment, chat and message in the period.</p>}</div>
    <div className="seg" role="group" aria-label="Time range">{RANGES.map(([d,l])=><button key={d} type="button" className="btn sm" aria-pressed={d===days} onClick={()=>setDays(d)}>{l}</button>)}</div>
  </header>;
  if(err)return<>{head}<div className="card"><Empty icon="alert" title="Insights could not load">{err}</Empty><p style={{textAlign:'center'}}><button className="btn sm" onClick={retry}>Try again</button></p></div></>;
  if(!m)return<>{head}<div className="tiles">{[0,1,2,3].map(i=><div key={i} className="card tile skel"/>)}</div><div className="card skel" style={{height:240}}/></>;
  const a=m.appointments,list=q=>nav('/bookings?view=list&range=all&status=all&'+q);
  return(<>
    {head}
    <h2 className="sec">Appointments</h2>
    <div className="tiles">
      <Tile label="Appointments in the period" value={a.scheduled} sub={`${a.completed} completed · ${a.noShow} no-show`}/>
      <Tile label="No-show rate" value={pct(a.noShowRate)} sub={a.completed+a.noShow?`of ${plural(a.completed+a.noShow,'visit')} with an outcome`:'no visits marked yet'}/>
      <Tile label="Cancellation rate" value={pct(a.cancelRate)} sub={`${a.cancelled} cancelled`}/>
      <Tile label="Coming up" value={a.upcoming} sub="next 7 days" to="/bookings?view=week"/>
      <Tile label="New bookings made" value={a.created} sub="entered in the period"/>
    </div>
    <DayChart days={m.byDay} onPick={d=>nav(`/bookings?view=day&date=${d}`)}/>
    <div className="grid2">
      <Outcomes a={a} onPick={k=>nav(`/bookings?view=list&range=${k==='booked'?'past':'all'}&status=${k}`)}/>
      <Bars title="By doctor" rows={m.byDoctor} empty="No appointments in this period." onPick={l=>list('dn='+encodeURIComponent(l))}/>
      <Bars title="By service" rows={m.byService} empty="No appointments in this period." onPick={l=>list('service='+encodeURIComponent(l))}/>
      <Bars title="Booked through" rows={m.bySource} empty="No appointments in this period." name={x=>SOURCE[x]||x}/>
    </div>

    <h2 className="sec">Front desk</h2>
    <div className="tiles">
      <Tile label="Chats" value={m.chats} sub={`${m.replies} replies from Solara`} to="/inbox"/>
      <Tile label="Handled by Solara" value={pct(m.automationRate)} sub={`${m.handledBySolara} without a person · ${m.handedOff} handed off`}/>
      <Tile label="After-hours chats" value={m.afterHours} sub="evenings, early mornings, weekends"/>
      <Tile label="Website requests" value={m.requests.total} sub={`${m.requests.confirmed} confirmed · ${m.requests.declined} declined · ${m.requests.pending} waiting${m.requests.autoBooked?` · ${m.requests.autoBooked} auto-booked`:''}`}/>
      <Tile label="Typical time to confirm" value={formatWait(m.requests.medianMinutesToDecide)} sub="median, request to decision"/>
      <Tile label="Changed by patients" value={m.selfService.cancelled+m.selfService.rescheduled} sub={`${m.selfService.rescheduled} rescheduled · ${m.selfService.cancelled} cancelled`}/>
      <Tile label="Texts to patients" value={m.messages.sent} sub={`sent · ${m.messages.waiting} waiting · ${m.messages.failed} not sent`} to="/activity"/>
    </div>
    <Bars title="Why chats needed a person" rows={m.reasons.map(r=>({label:r.reason,n:r.n}))} empty="No hand-offs in this period." name={x=>REASON[x]||x}/>
  </>);
}
