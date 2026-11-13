import {useMemo,useState} from 'react';
import {useTable} from '../lib/hooks';
import {computeInsights,formatWait} from '../lib/insights';
import {REASON} from '../lib/reasons';

const pct=x=>x==null?'–':Math.round(x*100)+'%';
const RANGES=[[7,'7 days'],[30,'30 days'],[90,'90 days']];

function Tile({label,value,sub}){
  return<div className="card st tile"><small>{label}</small><b>{value}</b>{sub&&<span>{sub}</span>}</div>;
}

/* What Solara did for the clinic, in numbers a pilot can show: chats handled, after-hours cover,
   website requests and how fast the team decided them, why chats needed a person, and patient self-service. */
export default function Insights(){
  const [convos]=useTable('convos'),[alerts]=useTable('alerts'),[bookings]=useTable('bookings'),[audit]=useTable('audit');
  const [days,setDays]=useState(30);
  const m=useMemo(()=>computeInsights({convos,alerts,bookings,audit},{days}),[convos,alerts,bookings,audit,days]);
  const top=Math.max(1,...m.reasons.map(r=>r.n));
  return(<>
    <header><h1>Insights</h1>
      <div className="seg" role="group" aria-label="Time range">{RANGES.map(([d,l])=><button key={d} type="button" className={'btn sm'+(d===days?'':' ghost')} aria-pressed={d===days} onClick={()=>setDays(d)}>{l}</button>)}</div>
    </header>
    <p className="route" style={{marginTop:-8}}>Last {m.days} days. Counts come from your own chats, alerts, bookings and activity.</p>

    <div className="tiles">
      <Tile label="Chats" value={m.chats} sub={`${m.replies} replies from Solara`}/>
      <Tile label="Handled by Solara" value={pct(m.automationRate)} sub={`${m.handledBySolara} without a person · ${m.handedOff} handed off`}/>
      <Tile label="After-hours chats" value={m.afterHours} sub="evenings, early mornings and weekends"/>
      <Tile label="Website requests" value={m.requests.total} sub={`${m.requests.confirmed} confirmed · ${m.requests.declined} declined · ${m.requests.pending} waiting${m.requests.autoBooked?` · ${m.requests.autoBooked} auto-booked`:''}`}/>
      <Tile label="Typical time to confirm" value={formatWait(m.requests.medianMinutesToDecide)} sub="median, request to staff decision"/>
      <Tile label="Patient self-service" value={m.selfService.cancelled+m.selfService.rescheduled} sub={`${m.selfService.rescheduled} rescheduled · ${m.selfService.cancelled} cancelled`}/>
    </div>

    <section className="card st" style={{marginTop:16}} aria-labelledby="hr-h">
      <h3 id="hr-h">Why chats needed a person</h3>
      {!m.reasons.length&&<p className="route">No hand-offs in this period.</p>}
      {m.reasons.length>0&&<table className="bars">
        <thead className="sr"><tr><th>Reason</th><th>Chats</th></tr></thead>
        <tbody>{m.reasons.map(r=><tr key={r.reason} title={`${REASON[r.reason]||r.reason}: ${r.n}`}>
          <th scope="row">{REASON[r.reason]||r.reason}</th>
          <td><span className="bar" style={{width:`${(r.n/top)*100}%`}}/><span className="val">{r.n}</span></td>
        </tr>)}</tbody>
      </table>}
    </section>
  </>);
}
