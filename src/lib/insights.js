/* Pilot metrics, computed from the clinic's own records (works on the live backend and the local demo).
   Pure: give it the lists and a time window, get numbers back. */
const DAY=864e5;
const t=v=>typeof v==='number'?v:Date.parse(v);
const median=xs=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2};

const KEPT=new Set(['booked','completed','no_show']);
const ymd=ms=>{const d=new Date(ms),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`};
const tally=(rows,key)=>Object.entries(rows.reduce((m,r)=>{const k=key(r);m[k]=(m[k]||0)+1;return m},{})).map(([label,n])=>({label,n})).sort((a,b)=>b.n-a.n);

/* Appointments by their own date (not by when they were entered), the same numbers the server's insights_summary returns. */
function appointmentStats(bookings,outbox,{days,now,since}){
  const from=ymd(now-(days-1)*DAY),to=ymd(now),nowL=ymd(now)+'T'+new Date(now).toTimeString().slice(0,5),week=ymd(now+7*DAY);
  const dated=bookings.filter(b=>b.when);
  const inP=dated.filter(b=>b.when.slice(0,10)>=from&&b.when.slice(0,10)<=to),live=inP.filter(b=>b.status!=='cancelled');
  const n=s=>inP.filter(b=>b.status===s).length,done=n('completed'),miss=n('no_show'),gone=n('cancelled');
  const byDay=[];for(let i=days-1;i>=0;i--){const d=ymd(now-i*DAY);byDay.push({date:d,n:live.filter(b=>b.when.slice(0,10)===d).length,cancelled:inP.filter(b=>b.status==='cancelled'&&b.when.slice(0,10)===d).length})}
  const sent=outbox.filter(o=>t(o.at)>=since);
  return{from,to,
    appointments:{scheduled:live.length,completed:done,noShow:miss,cancelled:gone,unmarked:inP.filter(b=>b.status==='booked'&&b.when<nowL).length,
      noShowRate:done+miss?miss/(done+miss):null,cancelRate:inP.length?gone/inP.length:null,
      created:bookings.filter(b=>t(b.created)>=since).length,upcoming:dated.filter(b=>(b.status==='booked'||b.status==='requested')&&b.when>=nowL&&b.when.slice(0,10)<=week).length},
    byDay,byDoctor:tally(live,b=>b.doctor||'Unassigned'),byService:tally(live,b=>b.service||'Not set'),bySource:tally(live,b=>b.source||'staff'),
    messages:{waiting:sent.filter(o=>o.status==='queued'||o.status==='processing').length,sent:sent.filter(o=>o.status==='sent').length,failed:sent.filter(o=>o.status==='failed').length}};
}

export function computeInsights({convos=[],alerts=[],bookings=[],audit=[],outbox=[]},{days=30,now=Date.now()}={}){
  const since=now-days*DAY,inWin=v=>{const x=t(v);return x>=since&&x<=now};
  const chats=convos.filter(c=>inWin(c.created));
  const handedOff=chats.filter(c=>c.status==='handoff'||c.alerted).length;
  // After hours: before 8am, from 6pm, or a weekend, in this browser's local time.
  const afterHours=chats.filter(c=>{const d=new Date(t(c.created)),h=d.getHours(),w=d.getDay();return w===0||w===6||h<8||h>=18}).length;
  const replies=chats.reduce((n,c)=>n+(c.messages||[]).filter(m=>m.r==='bot').length,0);

  const reasons={};
  for(const a of alerts.filter(a=>inWin(a.created)))reasons[a.reason||'other']=(reasons[a.reason||'other']||0)+1;

  const web=bookings.filter(b=>b.source==='website'&&inWin(b.requested_at||b.created));
  const decided=web.filter(b=>b.requested_at&&b.decided_at);
  const waits=decided.map(b=>(t(b.decided_at)-t(b.requested_at))/6e4).filter(x=>x>=0);
  const acts=audit.filter(a=>inWin(a.at));
  const count=action=>acts.filter(a=>a.action===action).length;

  return{
    days,
    chats:chats.length,
    handledBySolara:chats.length-handedOff,
    handedOff,
    automationRate:chats.length?(chats.length-handedOff)/chats.length:null,
    afterHours,
    replies,
    reasons:Object.entries(reasons).map(([reason,n])=>({reason,n})).sort((a,b)=>b.n-a.n),
    requests:{
      total:web.length,
      confirmed:web.filter(b=>KEPT.has(b.status)&&b.requested_at).length,
      autoBooked:web.filter(b=>KEPT.has(b.status)&&!b.requested_at).length,
      declined:web.filter(b=>b.status==='cancelled'&&b.decided_at).length,   // declined by staff, or withdrawn by the patient before a decision
      pending:web.filter(b=>b.status==='requested').length,
      medianMinutesToDecide:median(waits),
    },
    bookingsAll:bookings.filter(b=>inWin(b.created)&&b.status!=='cancelled').length,
    ...appointmentStats(bookings,outbox,{days,now,since}),
    selfService:{cancelled:count('patient.cancelled'),rescheduled:count('patient.rescheduled')},
  };
}

/* "12 min", "3.5 h", "2 days". */
export const formatWait=m=>m==null?'–':m<60?`${Math.round(m)} min`:m<48*60?`${(m/60).toFixed(m<600?1:0)} h`:`${Math.round(m/1440)} days`;
