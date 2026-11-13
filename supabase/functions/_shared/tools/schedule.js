/* Doctor schedules and routing for local bookings. Pure functions; storage lives in localdb. */
export const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DUR=30;
const MIN=t=>{const[h,m]=t.split(':').map(Number);return h*60+m};
const pad=n=>String(n).padStart(2,'0');

export const DEFAULT_SERVICES=['Cleaning','Exam','Consultation'];
export const DEFAULT_DOCTORS=[
  {name:'Dr. Anita Rao',specialty:'General dentistry',services:['Cleaning','Exam','Consultation'],days:[1,2,3,4,5],start:'08:00',end:'16:00',slot:30},
  {name:'Dr. Imran Sheikh',specialty:'Restorative',services:['Consultation','Exam'],days:[1,3,5,6],start:'10:00',end:'18:00',slot:30},
  {name:'Dr. Meera Nair',specialty:'Hygiene & cleaning',services:['Cleaning','Exam'],days:[2,4,6],start:'09:00',end:'17:00',slot:30}
];

/* "YYYY-MM-DDTHH:MM" (local business time) -> date part, weekday, minutes since midnight. */
export const dateOf=when=>when.slice(0,10);
const parts=when=>{const[d,t]=when.split('T');const[y,mo,da]=d.split('-').map(Number);return{day:new Date(Date.UTC(y,mo-1,da)).getUTCDay(),min:MIN(t)}};

/* Start times a doctor works on a date, every doctor.slot minutes within working hours. */
export const slotsFor=(doc,date)=>{
  if(!doc.days.includes(parts(date+'T00:00').day))return[];
  const out=[];
  for(let m=MIN(doc.start);m+DUR<=MIN(doc.end);m+=doc.slot)out.push(`${date}T${pad(Math.floor(m/60))}:${pad(m%60)}`);
  return out;
};

export const activeOn=(bookings,date)=>bookings.filter(b=>b.status!=='cancelled'&&dateOf(b.when)===date);

/* Routes a slot to a doctor who works that time, has no booking there, and offers the service.
   Prefers the requested doctor if free, otherwise the least-loaded free doctor for that day. Returns null when nobody is free. */
export const assignDoctor=(doctors,bookings,when,service,preferId)=>{
  const date=dateOf(when),p=parts(when);
  const free=doctors.filter(d=>{
    if(!d.days.includes(p.day)||p.min<MIN(d.start)||p.min+DUR>MIN(d.end)||(p.min-MIN(d.start))%d.slot!==0)return false;
    return !bookings.some(b=>b.status!=='cancelled'&&b.doctor_id===d.id&&b.when===when);
  });
  if(preferId){const pref=free.find(d=>d.id===preferId);if(pref)return pref}
  const load=d=>activeOn(bookings,date).filter(b=>b.doctor_id===d.id).length;
  // A named service only goes to a doctor who offers it; never fall back to someone who doesn't.
  const pool=service?free.filter(d=>d.services.includes(service)):free;
  return[...pool].sort((a,b)=>load(a)-load(b))[0]??null;
};
