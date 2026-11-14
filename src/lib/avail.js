/* Slot states for the dashboard, in the clinic's own time. Display only: the database re-checks every booking
   (validate_booking) with the same rules, so a stale screen can never place an appointment. */
import {slotsFor,dateOf} from './schedule.js';
const pad=n=>String(n).padStart(2,'0');
const MIN=w=>{const [h,m]=w.slice(11).split(':').map(Number);return h*60+m};

/* The clinic's wall clock as "YYYY-MM-DDTHH:MM" (the browser's own zone when the clinic has none, as in the local demo). */
export function clinicNow(tz,at=new Date()){
  let f;
  try{f=new Intl.DateTimeFormat('en-CA',{timeZone:tz||undefined,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at)}
  catch{return clinicNow(undefined,at)}
  const g=t=>f.find(p=>p.type===t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
export const addDays=(date,n)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
export const nice=w=>{const [y,mo,d]=w.slice(0,10).split('-').map(Number),[h,m]=(w.slice(11)||'00:00').split(':').map(Number);
  return new Date(y,mo-1,d,h,m).toLocaleString([],{weekday:'short',month:'short',day:'numeric',...(w.length>10?{hour:'numeric',minute:'2-digit'}:{})})};
export const clock=w=>{const [h,m]=w.slice(11).split(':').map(Number);return new Date(2000,0,1,h,m).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})};

export const STATUS={requested:'Requested',booked:'Confirmed',completed:'Completed',no_show:'No-show',cancelled:'Cancelled'};
export const held=b=>b.status!=='cancelled';                       // still occupies its slot
export const open=b=>b.status==='requested'||b.status==='booked';  // still ahead of the clinic

/* Confirmed leave or closure covering this doctor at this time. Tentative entries are never loaded, so they never block. */
export const awayAt=(doc,when,leave)=>leave.find(e=>e.date===dateOf(when)&&(e.start==null||(MIN(when)>=e.start&&MIN(when)<e.end))&&(e.kind==='closure'?!e.doctor_id:e.doctor_id===doc.id));
export const closedOn=(date,closures,leave)=>closures.some(c=>c.date===date)||leave.some(e=>e.kind==='closure'&&!e.doctor_id&&e.start==null&&e.date===date);

/* Bookable start times on a date: [{when,doctor}], earliest first. skipId lets an appointment move within its own doctor's day. */
export function openSlots(docs,date,bookings,leave,closures,{service,doctorId,now,skipId}={}){
  if(closedOn(date,closures,leave))return[];
  const taken=new Set(bookings.filter(b=>held(b)&&b.id!==skipId).map(b=>b.doctor_id+'|'+b.when)),out=[];
  for(const d of docs){
    if(doctorId&&d.id!==doctorId)continue;
    if(service&&!d.services.includes(service))continue;
    for(const w of slotsFor(d,date))if(!(now&&w<now)&&!taken.has(d.id+'|'+w)&&!awayAt(d,w,leave))out.push({when:w,doctor:d});
  }
  return out.sort((a,b)=>a.when.localeCompare(b.when)||a.doctor.name.localeCompare(b.doctor.name));
}

/* Why an upcoming appointment can no longer happen as booked (schedule changed after it was made), or null. */
export function conflictOf(b,docs,closures,leave){
  if(!open(b))return null;
  if(closedOn(dateOf(b.when),closures,leave))return 'The clinic is closed that day';
  const d=docs.find(x=>x.id===b.doctor_id);
  if(!d)return 'No doctor assigned';
  const away=awayAt(d,b.when,leave);
  if(away)return `${d.name} is away${away.note?` (${away.note})`:''}`;
  if(!slotsFor(d,dateOf(b.when)).includes(b.when))return `Outside ${d.name}'s working hours`;
  return null;
}
