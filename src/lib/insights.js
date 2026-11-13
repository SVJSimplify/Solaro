/* Pilot metrics, computed from the clinic's own records (works on the live backend and the local demo).
   Pure: give it the lists and a time window, get numbers back. */
const DAY=864e5;
const t=v=>typeof v==='number'?v:Date.parse(v);
const median=xs=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2};

export function computeInsights({convos=[],alerts=[],bookings=[],audit=[]},{days=30,now=Date.now()}={}){
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
      confirmed:web.filter(b=>b.status==='booked'&&b.requested_at).length,
      autoBooked:web.filter(b=>b.status==='booked'&&!b.requested_at).length,
      declined:web.filter(b=>b.status==='cancelled'&&b.decided_at).length,   // declined by staff, or withdrawn by the patient before a decision
      pending:web.filter(b=>b.status==='requested').length,
      medianMinutesToDecide:median(waits),
    },
    bookingsAll:bookings.filter(b=>inWin(b.created)&&b.status!=='cancelled').length,
    selfService:{cancelled:count('patient.cancelled'),rescheduled:count('patient.rescheduled')},
  };
}

/* "12 min", "3.5 h", "2 days". */
export const formatWait=m=>m==null?'–':m<60?`${Math.round(m)} min`:m<48*60?`${(m/60).toFixed(m<600?1:0)} h`:`${Math.round(m/1440)} days`;
