import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {db} from '../lib/db';
import {useAuth} from '../lib/hooks';
import {formatWait} from '../lib/insights';
import {nice} from '../lib/avail';
import {REASON} from '../lib/reasons';

const pct=x=>x==null?'–':Math.round(x*100)+'%';
const RANGES=[[7,'7 days'],[30,'30 days'],[90,'90 days']];
const SOURCE={staff:'Front desk',assistant:'Staff assistant',website:'Website chat'};

const Tile=({label,value,sub})=><div className="card st tile"><small>{label}</small><b>{value}</b>{sub&&<span>{sub}</span>}</div>;
function Bars({title,rows,empty,name=x=>x}){
  const top=Math.max(1,...rows.map(r=>r.n));
  return(<section className="card st"><h3>{title}</h3>
    {!rows.length?<p className="route">{empty}</p>:<table className="bars">
      <thead className="sr"><tr><th>{title}</th><th>Count</th></tr></thead>
      <tbody>{rows.map(r=><tr key={r.label} title={`${name(r.label)}: ${r.n}`}><th scope="row">{name(r.label)}</th><td><span className="bar" style={{width:`${(r.n/top)*100}%`}}/><span className="val">{r.n}</span></td></tr>)}</tbody>
    </table>}
  </section>);
}

/* The numbers are counted on the server over the whole period, in the clinic's time zone, and refresh when the clinic's data changes. */
function useInsights(days){
  const {user}=useAuth(),[m,setM]=useState(null),[err,setErr]=useState('');
  useEffect(()=>{
    let live=true,timer;
    const load=()=>db.insights(user.id,days).then(x=>{if(live){setM(x);setErr('')}}).catch(e=>live&&setErr(e.message));
    const on=()=>{clearTimeout(timer);timer=setTimeout(load,1000)};
    load();addEventListener('solara',on);
    return()=>{live=false;clearTimeout(timer);removeEventListener('solara',on)};
  },[user.id,user.org,days]);
  return[m,err];
}

export default function Insights(){
  const [days,setDays]=useState(30),[m,err]=useInsights(days);
  const head=<header><h1>Insights</h1>
    <div className="seg" role="group" aria-label="Time range">{RANGES.map(([d,l])=><button key={d} type="button" className={'btn sm'+(d===days?'':' ghost')} aria-pressed={d===days} onClick={()=>setDays(d)}>{l}</button>)}</div>
  </header>;
  if(err)return<>{head}<div className="card st"><p className="warn" role="alert">Insights could not load: {err}</p></div></>;
  if(!m)return<>{head}<p className="route">Loading…</p></>;
  const a=m.appointments,peak=Math.max(1,...m.byDay.map(d=>d.n+d.cancelled));
  return(<>
    {head}
    <p className="route" style={{marginTop:-8}}>{nice(String(m.from))} to {nice(String(m.to))}, clinic time. Counted from every appointment, chat and message in the period.</p>

    <h2 className="sec">Appointments</h2>
    <div className="tiles">
      <Tile label="Appointments in the period" value={a.scheduled} sub={`${a.completed} completed · ${a.noShow} no-show · ${a.cancelled} cancelled`}/>
      <Tile label="No-show rate" value={pct(a.noShowRate)} sub={a.completed+a.noShow?`of ${a.completed+a.noShow} visits with an outcome`:'no visits marked yet'}/>
      <Tile label="Cancellation rate" value={pct(a.cancelRate)} sub="of everything scheduled in the period"/>
      <Tile label="Coming up" value={a.upcoming} sub="next 7 days, requested or confirmed"/>
      <Tile label="New bookings made" value={a.created} sub="entered in the period, any date"/>
    </div>
    {a.unmarked>0&&<p className="route"><Link to="/bookings">{a.unmarked} past appointment{a.unmarked>1?'s':''} still need{a.unmarked>1?'':'s'} an outcome.</Link> Until they are marked completed or no-show, the rates above leave them out.</p>}

    <section className="card st" style={{marginTop:16}}><h3>Appointments per day</h3>
      {!a.scheduled&&!a.cancelled?<p className="route">No appointments in this period.</p>
        :<><div className="cols" role="img" aria-label={`Appointments per day, busiest day ${peak}`}>{m.byDay.map(d=><div key={d.date} className="col" title={`${nice(String(d.date))}: ${d.n} appointment${d.n===1?'':'s'}${d.cancelled?`, ${d.cancelled} cancelled`:''}`}>
            <span className="x" style={{height:`${(d.cancelled/peak)*100}%`}}/><span className="n" style={{height:`${(d.n/peak)*100}%`}}/></div>)}</div>
          <div className="cols-axis"><span>{nice(String(m.from))}</span><span><i className="key n"/> kept <i className="key x"/> cancelled · busiest day {peak}</span><span>{nice(String(m.to))}</span></div></>}
    </section>
    <div className="grid2" style={{marginTop:16}}>
      <Bars title="By doctor" rows={m.byDoctor} empty="No appointments in this period."/>
      <Bars title="By service" rows={m.byService} empty="No appointments in this period."/>
      <Bars title="Booked through" rows={m.bySource} empty="No appointments in this period." name={x=>SOURCE[x]||x}/>
    </div>

    <h2 className="sec">Front desk</h2>
    <div className="tiles">
      <Tile label="Chats" value={m.chats} sub={`${m.replies} replies from Solara`}/>
      <Tile label="Handled by Solara" value={pct(m.automationRate)} sub={`${m.handledBySolara} without a person · ${m.handedOff} handed off`}/>
      <Tile label="After-hours chats" value={m.afterHours} sub="evenings, early mornings and weekends"/>
      <Tile label="Website requests" value={m.requests.total} sub={`${m.requests.confirmed} confirmed · ${m.requests.declined} declined · ${m.requests.pending} waiting${m.requests.autoBooked?` · ${m.requests.autoBooked} auto-booked`:''}`}/>
      <Tile label="Typical time to confirm" value={formatWait(m.requests.medianMinutesToDecide)} sub="median, request to staff decision"/>
      <Tile label="Patient self-service" value={m.selfService.cancelled+m.selfService.rescheduled} sub={`${m.selfService.rescheduled} rescheduled · ${m.selfService.cancelled} cancelled`}/>
      <Tile label="Texts to patients" value={m.messages.sent} sub={`sent · ${m.messages.waiting} waiting · ${m.messages.failed} not sent`}/>
    </div>
    <div style={{marginTop:16}}><Bars title="Why chats needed a person" rows={m.reasons.map(r=>({label:r.reason,n:r.n}))} empty="No hand-offs in this period." name={x=>REASON[x]||x}/></div>
  </>);
}
