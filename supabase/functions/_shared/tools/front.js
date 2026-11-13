/* Front-desk and setup tools, defined once in the registry format. These replace the old src/lib/frontTools.js and src/lib/setupTools.js.
   They read and write the live tables (doctors, bookings, kb, closures) through db.legacy, so the booking engine is unchanged.
   Side effects for the chat (handoff, form, booked) go to c.out. */
import {ToolError} from './errors.js';
import {cleanText,parseWeekdays,parseTimeRange,todayIn} from './normalise.js';
import {normalizePhone,PHONE_HINT,countryForTimeZone} from './phone.js';
import {assignDoctor,slotsFor,dateOf} from './schedule.js';
import {cleanForm,REASONS} from '../agent.js';
import {hasRole} from './registry.js';

const DATE={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$',description:'YYYY-MM-DD'};
const WHEN={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',description:'YYYY-MM-DDTHH:MM, the clinic\'s local time'};
const OBJ={type:'object'};
const digits=s=>String(s||'').replace(/\D/g,'');
const pad=n=>String(n).padStart(2,'0');

/* The clinic's wall-clock "now". The caller may pass its own (the browser's local time); otherwise the organisation's time zone is used. */
export function nowLocal(c){
  if(c.localNow)return c.localNow;
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:c.timeZone??'UTC',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(c.now??new Date());
  const g=t=>f.find(p=>p.type===t).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}

const base={version:1,minRole:'staff',writes:false,idempotent:'not_applicable',errors:['INVALID_ARGUMENT','PERMISSION_DENIED','UNAVAILABLE'],
  normalise:async raw=>({...raw})};
const def=d=>({...base,...d,canonical:d.canonical??d.input,errors:d.errors??base.errors});

/* Confirmed schedule exceptions (leave, unavailable, clinic closures) recorded through Solara's information model.
   Tentative or pending ones never block bookings: only confirmed information changes what patients are offered. */
const MIN=t=>{const [h,m]=t.split(':').map(Number);return h*60+m};
const covers=(e,when)=>e.start_min==null||e.end_min==null||(MIN(when.slice(11))>=e.start_min&&MIN(when.slice(11))<e.end_min);
export const blockedFor=(d,when,ex)=>ex.some(e=>e.on_date===dateOf(when)&&covers(e,when)&&
  ((e.kind==='closure'&&!e.doctor_id)||((e.kind==='leave'||e.kind==='unavailable'||e.kind==='closure')&&e.doctor_id===d.id)));
const freeDoctors=(doctors,when,ex)=>doctors.filter(d=>!blockedFor(d,when,ex));

const loadAll=async(c,db)=>{
  const L=db.legacy, from=nowLocal(c).slice(0,10);
  const [doctors,bookings,services,closures,ex]=await Promise.all([L.list(c.orgId,'doctors'),L.list(c.orgId,'bookings'),L.list(c.orgId,'services'),L.list(c.orgId,'closures'),
    db.confirmedExceptions?db.confirmedExceptions(c.orgId,from):Promise.resolve([])]);
  // A clinic-wide closure for the whole day closes the clinic, exactly like a closed day set on the Bookings page.
  const closed=[...new Set([...closures.map(x=>x.date),...ex.filter(e=>e.kind==='closure'&&!e.doctor_id&&e.start_min==null).map(e=>e.on_date)])];
  return{doctors,bookings,services:services.map(s=>s.name),closed,ex};
};
const openSlots=(doctors,bookings,day,service,now,limit,ex=[])=>{
  const out=[];
  for(const d of doctors.filter(x=>!service||x.services.includes(service)))
    for(const t of slotsFor(d,day)){
      if(t<now||blockedFor(d,t,ex))continue;
      if(bookings.some(b=>b.status!=='cancelled'&&b.doctor_id===d.id&&b.when===t))continue;
      out.push({time:t.slice(11),doctor:d.name});
    }
  return out.sort((x,y)=>x.time.localeCompare(y.time)).slice(0,limit);
};

/* Booking input checks, shared by staff bookings (book_appointment) and website requests (request_appointment). */
async function bookingNormalise(raw,c){
    const phone=normalizePhone(raw.phone,countryForTimeZone(c?.timeZone));
    if(!phone)throw new ToolError('INVALID_ARGUMENT','The phone number is not a valid US (+1) or Indian (+91) number.',{field:'phone',nextStep:'Ask the customer to re-enter it.'});
    return{name:cleanText(raw.name,{max:120}),phone,service:cleanText(raw.service,{max:80}),when:raw.when,...(raw.idempotency_key?{idempotency_key:raw.idempotency_key}:{})};
}
async function bookingPreconditions(a,c,db){
    if(!a.name)throw new ToolError('MISSING_INFORMATION','Name is required.',{field:'name'});
    if(a.when<nowLocal(c))throw new ToolError('PRECONDITION_FAILED','That time has already passed.',{field:'when',nextStep:'Ask for a future time.'});
    const {services,closed}=await loadAll(c,db);
    if(closed.includes(dateOf(a.when)))throw new ToolError('PRECONDITION_FAILED','The business is closed that day.',{field:'when',nextStep:'Ask for another date.'});
    if(services.length&&!services.includes(a.service))throw new ToolError('INVALID_ARGUMENT',`That service is not offered.`,{field:'service',alternatives:services,nextStep:'Pick one of the services offered.'});
}

/* The slot was taken between the check and the write (the database's unique slot index caught it). */
const slotTaken=(doctors,bookings,a,c,ex=[])=>new ToolError('RESOURCE_CONFLICT','That time is taken or outside working hours.',{field:'when',retryable:false,
  alternatives:openSlots(doctors,bookings,dateOf(a.when),a.service,nowLocal(c),6,ex),nextStep:'Offer the alternatives.'});

export const getTime=def({name:'get_time',public:true,patientData:'none',
  description:'Current local date and time of the business. Call before resolving words like "today" or "tomorrow".',
  input:{type:'object',additionalProperties:false,properties:{}},
  output:{type:'object',required:['now'],properties:{now:{type:'string'}}},
  run:async(a,c)=>({now:nowLocal(c).replace('T',' ')})});

export const searchAnswers=def({name:'search_answers',public:true,patientData:'none',
  description:'Find saved answers about the business (hours, prices, insurance, policies, parking). Use before answering any business question.',
  input:{type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string',minLength:1,maxLength:300,description:'the customer\'s question in a few words'}}},
  output:{type:'object',required:['matches'],properties:{matches:{type:'array'},note:{type:'string'}}},
  run:async(a,c,db)=>{
    // Saved answers, plus clinic information staff have CONFIRMED (never tentative or pending items).
    const [kb,facts]=await Promise.all([db.legacy.list(c.orgId,'kb'),db.confirmedFacts?db.confirmedFacts(c.orgId):Promise.resolve([])]);
    const words=String(a.query).toLowerCase().split(/\W+/).filter(w=>w.length>2);
    const rows=[...kb.map(k=>({topic:k.title,answer:k.body,text:`${k.title} ${k.keywords} ${k.body}`})),
      ...facts.map(f=>({topic:f.entity_name?`${f.entity_name}: ${f.key}`:f.key,answer:f.value,text:`${f.category} ${f.entity_name??''} ${f.key} ${f.value}`,source:'clinic information'}))];
    const score=r=>words.filter(w=>r.text.toLowerCase().includes(w)).length;
    const matches=rows.map(r=>({r,s:score(r)})).filter(x=>x.s>0).sort((x,y)=>y.s-x.s).slice(0,6).map(({r})=>({topic:r.topic,answer:r.answer,...(r.source?{source:r.source}:{})}));
    return matches.length?{matches}:{matches:[],note:'no saved answer matches; say the team will follow up or request_handoff'};
  }});

export const listDoctors=def({name:'list_doctors',public:true,patientData:'none',
  description:'List doctors or staff with their working days, hours and services.',
  input:{type:'object',additionalProperties:false,properties:{}},
  output:{type:'object',required:['doctors'],properties:{doctors:{type:'array'}}},
  run:async(a,c,db)=>({doctors:(await db.legacy.list(c.orgId,'doctors')).map(d=>({name:d.name,specialty:d.specialty,days:d.days,hours:`${d.start}-${d.end}`,services:d.services}))})});

export const checkAvailability=def({name:'check_availability',public:true,patientData:'none',
  description:'Open appointment times on a date, optionally for one service.',
  input:{type:'object',additionalProperties:false,required:['date'],properties:{date:DATE,service:{type:'string',maxLength:80}}},
  output:{type:'object',required:['date','slots'],properties:{date:{type:'string'},slots:{type:'array'},note:{type:'string'}}},
  run:async(a,c,db)=>{
    const {doctors,bookings,closed,ex}=await loadAll(c,db);
    if(closed.includes(a.date))return{date:a.date,slots:[],note:'the business is closed that day'};
    const slots=openSlots(doctors,bookings,a.date,a.service,nowLocal(c),16,ex);
    return slots.length?{date:a.date,slots}:{date:a.date,slots:[],note:'no open times that day; try another date'};
  }});

export const bookAppointment=def({name:'book_appointment',patientData:'contact',writes:true,idempotent:'required',autoKey:true,
  description:'Book an appointment. Needs name, phone, service and an exact start time. The system picks the doctor.',
  input:{type:'object',additionalProperties:false,required:['name','phone','service','when'],properties:{
    name:{type:'string',minLength:1,maxLength:120},phone:{type:'string',minLength:3,maxLength:40},service:{type:'string',minLength:1,maxLength:80},when:WHEN,
    idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  output:{type:'object',required:['doctor','when'],properties:{doctor:{type:'string'},when:{type:'string'},booking_id:{type:'string'}}},
  errors:['INVALID_ARGUMENT','PRECONDITION_FAILED','RESOURCE_CONFLICT','PERMISSION_DENIED','UNAVAILABLE'],
  normalise:bookingNormalise,
  preconditions:bookingPreconditions,
  run:async(a,c,db)=>{
    const {doctors,bookings,ex}=await loadAll(c,db);
    const doc=assignDoctor(freeDoctors(doctors,a.when,ex),bookings,a.when,a.service);
    if(!doc)throw slotTaken(doctors,bookings,a,c,ex);
    const row=await db.legacy.addBooking(c.orgId,{name:a.name,phone:a.phone,service:a.service,when:a.when,doctor_id:doc.id,doctor:doc.name,status:'booked',source:'assistant'});
    await db.logAudit(c.orgId,'booking',`${a.name} with ${doc.name} at ${a.when.replace('T',' ')}`);
    if(c.out)c.out.booked=true;
    return{doctor:doc.name,when:a.when.replace('T',' '),booking_id:String(row?.id??'')};
  }});

/* Website visitors ask for an appointment; the clinic's team confirms it (or the clinic turns on auto-confirm).
   The requested slot is held straight away, so two visitors can never be given the same doctor and time. */
export const requestAppointment=def({name:'request_appointment',public:true,patientData:'contact',writes:true,idempotent:'required',autoKey:true,
  description:'Request an appointment for the person in this chat. Needs their name, phone, service and an exact start time from check_availability. The clinic team confirms it; never tell the person it is confirmed unless the result status is "booked".',
  input:{type:'object',additionalProperties:false,required:['name','phone','service','when'],properties:{
    name:{type:'string',minLength:1,maxLength:120},phone:{type:'string',minLength:3,maxLength:40},service:{type:'string',minLength:1,maxLength:80},when:WHEN,
    idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  output:{type:'object',required:['status','doctor','when'],properties:{status:{type:'string',enum:['requested','booked']},doctor:{type:'string'},when:{type:'string'},booking_id:{type:'string'}}},
  errors:['INVALID_ARGUMENT','MISSING_INFORMATION','PRECONDITION_FAILED','RESOURCE_CONFLICT','PERMISSION_DENIED','UNAVAILABLE'],
  normalise:bookingNormalise,
  preconditions:bookingPreconditions,
  run:async(a,c,db)=>{
    const {doctors,bookings,ex}=await loadAll(c,db);
    const doc=assignDoctor(freeDoctors(doctors,a.when,ex),bookings,a.when,a.service);
    if(!doc)throw slotTaken(doctors,bookings,a,c,ex);
    const status=(await db.bookingPolicy?.(c.orgId))?.autoConfirm?'booked':'requested';
    let row;
    try{row=await db.legacy.addBooking(c.orgId,{name:a.name,phone:a.phone,service:a.service,when:a.when,doctor_id:doc.id,doctor:doc.name,status,source:'website',conversation_id:c.conversationId??null})}
    catch(e){if(e?.code==='RESOURCE_CONFLICT')throw slotTaken(doctors,[...bookings,{status:'booked',doctor_id:doc.id,when:a.when}],a,c,ex);throw e}
    await db.logAudit(c.orgId,status==='booked'?'booking':'booking.requested',`${a.name} with ${doc.name} at ${a.when.replace('T',' ')} (website)`);
    if(c.out){c.out.booked=status==='booked';c.out.requested=status==='requested'}
    return{status,doctor:doc.name,when:a.when.replace('T',' '),booking_id:String(row?.id??'')};
  }});

export const findBookings=def({name:'find_bookings',patientData:'contact',
  description:'Upcoming bookings for a phone number.',
  input:{type:'object',additionalProperties:false,required:['phone'],properties:{phone:{type:'string',minLength:3,maxLength:40}}},
  output:{type:'object',required:['bookings'],properties:{bookings:{type:'array'}}},
  run:async(a,c,db)=>{
    const p=digits(normalizePhone(a.phone,countryForTimeZone(c.timeZone))||a.phone), now=nowLocal(c);
    return{bookings:(await db.legacy.list(c.orgId,'bookings')).filter(b=>b.status!=='cancelled'&&digits(b.phone)===p&&b.when>=now)
      .map(b=>({when:b.when.replace('T',' '),doctor:b.doctor,service:b.service}))};
  }});

export const cancelBooking=def({name:'cancel_booking',patientData:'contact',writes:true,idempotent:'required',autoKey:true,
  description:'Cancel a booking by phone number and start time.',
  input:{type:'object',additionalProperties:false,required:['phone','when'],properties:{phone:{type:'string',minLength:3,maxLength:40},when:WHEN,idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  output:{type:'object',required:['cancelled'],properties:{cancelled:{type:'boolean'}}},
  errors:['INVALID_ARGUMENT','ENTITY_NOT_FOUND','PERMISSION_DENIED','UNAVAILABLE'],
  run:async(a,c,db)=>{
    const p=digits(normalizePhone(a.phone,countryForTimeZone(c.timeZone))||a.phone);
    const hit=(await db.legacy.list(c.orgId,'bookings')).find(b=>b.status!=='cancelled'&&digits(b.phone)===p&&b.when===a.when);
    if(!hit)throw new ToolError('ENTITY_NOT_FOUND','No booking with that phone and time.',{field:'when',retryable:false});
    await db.legacy.setBookingStatus(c.orgId,hit.id,'cancelled');
    await db.logAudit(c.orgId,'cancellation',`${hit.name} at ${hit.when.replace('T',' ')}`);
    return{cancelled:true};
  }});

export const showForm=def({name:'show_form',public:true,patientData:'none',
  description:'Show the customer a short form to fill in when you need several details at once.',
  input:{type:'object',additionalProperties:false,required:['title','fields'],properties:{title:{type:'string',maxLength:80},submit:{type:'string',maxLength:30},
    fields:{type:'array',minItems:1,maxItems:6,items:{type:'object',additionalProperties:false,required:['name','label'],properties:{name:{type:'string',maxLength:32},label:{type:'string',maxLength:80},
      type:{type:'string',enum:['text','tel','email','date','datetime-local','select','textarea']},required:{type:'boolean'},options:{type:'array',items:{type:'string'}}}}}}},
  output:{type:'object',required:['shown'],properties:{shown:{type:'boolean'}}},
  run:async(a,c,db)=>{
    const {services}=await loadAll(c,db);
    const fields=a.fields.map(f=>/service/i.test(`${f.name} ${f.label}`)&&services.length?{...f,type:'select',options:services}:f);
    const form=cleanForm({title:a.title,submit:a.submit,fields});
    if(!form)throw new ToolError('INVALID_ARGUMENT','A form needs at least one valid field.',{field:'fields',retryable:false});
    c.out.form=form;return{shown:true};
  }});

export const doctorBusyTimes=def({name:'doctor_busy_times',patientData:'none',
  description:'Who is busy and when on a date: each doctor\'s booked times and open times.',
  input:{type:'object',additionalProperties:false,required:['date'],properties:{date:DATE}},
  output:{type:'object',required:['date'],properties:{date:{type:'string'},doctors:{type:'array'},note:{type:'string'}}},
  run:async(a,c,db)=>{
    const {doctors,bookings,closed,ex}=await loadAll(c,db);
    if(closed.includes(a.date))return{date:a.date,note:'the business is closed that day'};
    const now=nowLocal(c), taken=d=>bookings.filter(b=>b.status!=='cancelled'&&b.doctor_id===d.id);
    return{date:a.date,doctors:doctors.map(d=>({doctor:d.name,working:`${d.start}-${d.end}`,
      busy:taken(d).filter(b=>dateOf(b.when)===a.date).map(b=>b.when.slice(11)),
      open:slotsFor(d,a.date).filter(t=>t>=now&&!blockedFor(d,t,ex)&&!taken(d).some(b=>b.when===t)).map(t=>t.slice(11))}))};
  }});

export const requestHandoff=def({name:'request_handoff',public:true,patientData:'none',
  description:'Pass this chat to a human team member. Use when unsure, the customer is upset, asks for a person, or raises a health concern.',
  input:{type:'object',additionalProperties:false,required:['reason'],properties:{reason:{type:'string',enum:REASONS.filter(r=>r!=='error')}}},
  output:{type:'object',required:['handoff'],properties:{handoff:{type:'boolean'}}},
  run:async(a,c)=>{c.out.handoff=true;c.out.reason=REASONS.includes(a.reason)?a.reason:'other';return{handoff:true}}});

/* ---------- Patient self-service (website) ----------
   Only after the visitor proves they own a phone number with a texted code. The server sets c.verifiedPhone from its own
   verification record; nothing the visitor or the model sends can set it. Only bookings on that number can be seen or changed.
   These tools are hidden from the model: the patient drives them from the "Manage my appointment" panel. */
const UUID={type:'string',pattern:'^[0-9a-f-]{36}$'};
const needVerified=c=>{if(!c.verifiedPhone)throw new ToolError('PERMISSION_DENIED','Please verify your phone number first.',{retryable:false})};
const mine=async(c,db,id)=>{
  const now=nowLocal(c),p=digits(c.verifiedPhone);
  const all=(await db.legacy.list(c.orgId,'bookings')).filter(b=>b.status!=='cancelled'&&digits(b.phone)===p&&b.when>=now);
  if(id===undefined)return all;
  const hit=all.find(b=>b.id===id);
  if(!hit)throw new ToolError('ENTITY_NOT_FOUND','That appointment was not found on your number.',{retryable:false});
  return hit;
};

export const myAppointments=def({name:'my_appointments',public:true,hidden:true,patientData:'contact',
  description:'Upcoming appointments for the verified phone number of this chat.',
  input:{type:'object',additionalProperties:false,properties:{}},
  output:{type:'object',required:['appointments'],properties:{appointments:{type:'array'}}},
  authorize:(a,c)=>needVerified(c),
  run:async(a,c,db)=>({appointments:(await mine(c,db)).map(b=>({id:b.id,when:b.when,service:b.service,doctor:b.doctor,status:b.status}))})});

export const cancelMyAppointment=def({name:'cancel_my_appointment',public:true,hidden:true,patientData:'contact',writes:true,idempotent:'required',autoKey:true,
  description:'Cancel one upcoming appointment on the verified phone number of this chat.',
  input:{type:'object',additionalProperties:false,required:['booking_id'],properties:{booking_id:UUID,idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  output:{type:'object',required:['cancelled','when'],properties:{cancelled:{type:'boolean'},when:{type:'string'},service:{type:'string'}}},
  errors:['ENTITY_NOT_FOUND','PERMISSION_DENIED','UNAVAILABLE'],
  authorize:(a,c)=>needVerified(c),
  run:async(a,c,db)=>{
    const b=await mine(c,db,a.booking_id);
    await db.legacy.setBookingStatus(c.orgId,b.id,'cancelled');
    await db.logAudit(c.orgId,'patient.cancelled',`${b.name} cancelled ${b.service} at ${b.when.replace('T',' ')} (website, verified)`);
    if(c.out)c.out.cancelled=b;
    return{cancelled:true,when:b.when.replace('T',' '),service:b.service};
  }});

export const rescheduleMyAppointment=def({name:'reschedule_my_appointment',public:true,hidden:true,patientData:'contact',writes:true,idempotent:'required',autoKey:true,
  description:'Move one upcoming appointment on the verified phone number to a new open time.',
  input:{type:'object',additionalProperties:false,required:['booking_id','when'],properties:{booking_id:UUID,when:WHEN,idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  output:{type:'object',required:['status','doctor','when'],properties:{status:{type:'string',enum:['requested','booked']},doctor:{type:'string'},when:{type:'string'}}},
  errors:['ENTITY_NOT_FOUND','PRECONDITION_FAILED','RESOURCE_CONFLICT','PERMISSION_DENIED','UNAVAILABLE'],
  authorize:(a,c)=>needVerified(c),
  run:async(a,c,db)=>{
    const b=await mine(c,db,a.booking_id);
    if(a.when===b.when)throw new ToolError('PRECONDITION_FAILED','That is already the time of this appointment.',{field:'when',retryable:false});
    await bookingPreconditions({name:b.name,service:b.service,when:a.when},c,db);
    const {doctors,bookings,ex}=await loadAll(c,db);
    const others=bookings.filter(x=>x.id!==b.id), req={service:b.service,when:a.when};
    const doc=assignDoctor(freeDoctors(doctors,a.when,ex),others,a.when,b.service,b.doctor_id);
    if(!doc)throw slotTaken(doctors,others,req,c,ex);
    const status=(await db.bookingPolicy?.(c.orgId))?.autoConfirm?'booked':'requested';
    try{await db.legacy.updateBooking(c.orgId,b.id,{when:a.when,doctor_id:doc.id,doctor:doc.name,status})}
    catch(e){if(e?.code==='RESOURCE_CONFLICT')throw slotTaken(doctors,[...others,{status:'booked',doctor_id:doc.id,when:a.when}],req,c,ex);throw e}
    await db.logAudit(c.orgId,'patient.rescheduled',`${b.name}: ${b.when.replace('T',' ')} → ${a.when.replace('T',' ')} with ${doc.name} (website, verified)`);
    return{status,doctor:doc.name,when:a.when.replace('T',' ')};
  }});

/* ---------- More setup tools for the staff assistant ---------- */
export const updateDoctor=def({name:'update_doctor',minRole:'admin',patientData:'none',writes:true,idempotent:'required',autoKey:true,
  description:'Change an existing doctor\'s specialty, working days, hours or services. Only the fields given change. Use this instead of adding the doctor again.',
  input:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:120},specialty:{type:'string',maxLength:120},
    days:{type:'string',maxLength:80,description:'e.g. "Mon-Fri"'},hours:{type:'string',maxLength:40,description:'e.g. "8am-4pm"'},services:{type:'string',maxLength:300,description:'comma-separated; replaces the list'},
    idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  output:{type:'object',required:['updated','changed'],properties:{updated:{type:'string'},changed:{type:'array'}}},
  errors:['INVALID_ARGUMENT','ENTITY_NOT_FOUND','PERMISSION_DENIED','UNAVAILABLE'],authorize:(a,c)=>{if(!hasRole(c.role,'admin'))throw new ToolError('PERMISSION_DENIED','Only an owner or admin can change clinic setup.',{retryable:false})},
  normalise:async raw=>{
    const out={name:cleanText(raw.name,{max:120})};
    if(raw.specialty!==undefined)out.specialty=cleanText(raw.specialty,{max:120});
    if(raw.days)out.days=parseWeekdays(raw.days);
    if(raw.hours){const {start,end}=parseTimeRange(raw.hours);out.start=start;out.end=end}
    if(raw.services!==undefined){const l=String(raw.services).split(',').map(x=>cleanText(x,{max:60})).filter(Boolean);if(l.length)out.services=l}
    if(raw.idempotency_key)out.idempotency_key=raw.idempotency_key;
    return out;
  },
  canonical:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1},specialty:{type:'string'},days:{type:'array',items:{type:'integer'}},
    start:{type:'string'},end:{type:'string'},services:{type:'array',items:{type:'string'}},idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  run:async(a,c,db)=>{
    const hit=(await db.legacy.list(c.orgId,'doctors')).find(d=>same(d.name,a.name));
    if(!hit)throw new ToolError('ENTITY_NOT_FOUND','No doctor with that name.',{field:'name',retryable:false,nextStep:'Use add_doctor to add them.'});
    const {name,idempotency_key,...patch}=a;
    const changed=Object.keys(patch);
    if(!changed.length)throw new ToolError('INVALID_ARGUMENT','Nothing to change was given.',{retryable:false});
    await db.legacy.updateDoctor(c.orgId,hit.id,patch);
    return{updated:hit.name,changed};
  }});

export const addService=def({name:'add_service',minRole:'admin',patientData:'none',writes:true,idempotent:'required',autoKey:true,
  description:'Add a service patients can book, e.g. "Whitening". Skips one that already exists.',
  input:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:60},idempotency_key:{type:'string',minLength:8,maxLength:128}}},
  output:{type:'object',required:['service','added'],properties:{service:{type:'string'},added:{type:'boolean'}}},
  errors:['INVALID_ARGUMENT','PERMISSION_DENIED','UNAVAILABLE'],authorize:(a,c)=>{if(!hasRole(c.role,'admin'))throw new ToolError('PERMISSION_DENIED','Only an owner or admin can change clinic setup.',{retryable:false})},
  run:async(a,c,db)=>{
    const n=cleanText(a.name,{max:60});
    if((await db.legacy.list(c.orgId,'services')).some(x=>same(x.name,n)))return{service:n,added:false};
    await db.legacy.addService(c.orgId,n);return{service:n,added:true};
  }});

export const frontTools=[getTime,searchAnswers,listDoctors,checkAvailability,bookAppointment,findBookings,cancelBooking,showForm,doctorBusyTimes,requestHandoff];
/* Website visitors: business answers, open times, a booking request and a hand-off. Never another patient's bookings. */
export const publicOnlyTools=[requestAppointment,myAppointments,cancelMyAppointment,rescheduleMyAppointment];

/* The booking form shown whenever someone asks to book. The website renders it as a date and open-times picker. */
const DEFAULT_SERVICES=['Cleaning','Exam','Consultation'];
export function bookingForm(services){
  return cleanForm({title:'Book your appointment',submit:'Request appointment',fields:[
    {name:'name',label:'Full name',type:'text',required:true},
    {name:'phone',label:`Phone (${PHONE_HINT})`,type:'tel',required:true},
    {name:'service',label:'Service',type:'select',required:true,options:services.length?services:DEFAULT_SERVICES},
    {name:'when',label:'Preferred date and time',type:'datetime-local',required:true}]});
}
const BOOK_INTENT=/\b(book|booking|appointment|appt|schedule|reserve|slot|visit)\b/i;
const NOT_BOOKING=/\b(re-?schedul\w*|cancel\w*|move my|change my)\b/i;
/* True when the latest message asks to change or cancel an existing appointment. */
export function wantsManage(messages){
  const last=[...messages].reverse().find(m=>m.role==='user')?.content||'';
  return NOT_BOOKING.test(last)&&/\b(appointment|appt|booking|visit)\b|\b(re-?schedul\w*|cancel\w*)\b/i.test(last);
}
/* True when the latest customer message asks to book, and is not a reschedule, a cancellation or a submitted form. */
export function wantsBooking(messages){
  const last=[...messages].reverse().find(m=>m.role==='user')?.content||'';
  if(last.startsWith('Form submitted:'))return false;
  return BOOK_INTENT.test(last)&&!NOT_BOOKING.test(last);
}

/* ---- Setup tools (owners and admins). Doctors and answers are the clinic's live configuration. ---- */
const same=(a,b)=>String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();
const AKEY={type:'string',minLength:8,maxLength:128};
const adminOnly=(a,c)=>{if(!hasRole(c.role,'admin'))throw new ToolError('PERMISSION_DENIED','Only an owner or admin can change clinic setup.',{retryable:false})};

export const addDoctor=def({name:'add_doctor',minRole:'admin',patientData:'none',writes:true,idempotent:'required',autoKey:true,
  description:'Add a doctor or staff member with working days and hours. Call once per person. Hours need am or pm.',
  input:{type:'object',additionalProperties:false,required:['name','days','hours'],properties:{name:{type:'string',minLength:1,maxLength:120},specialty:{type:'string',maxLength:120},
    days:{type:'string',maxLength:80,description:'e.g. "Mon-Fri", "Mon, Wed, Fri" or "Daily"'},hours:{type:'string',maxLength:40,description:'e.g. "8am-4pm" or "09:00-17:00"'},
    services:{type:'string',maxLength:300,description:'comma-separated, e.g. "Cleaning, Exam"'},idempotency_key:AKEY}},
  canonical:{type:'object',additionalProperties:false,required:['name','days','start','end','services'],properties:{name:{type:'string',minLength:1},specialty:{type:'string'},
    days:{type:'array',items:{type:'integer'}},start:{type:'string'},end:{type:'string'},services:{type:'array',items:{type:'string'}},idempotency_key:AKEY}},
  output:{type:'object',required:['name'],properties:{name:{type:'string'}}},
  errors:['INVALID_ARGUMENT','MISSING_INFORMATION','RESOURCE_CONFLICT','PERMISSION_DENIED','UNAVAILABLE'],
  normalise:async raw=>{
    const {start,end}=parseTimeRange(raw.hours), services=String(raw.services||'').split(',').map(s=>cleanText(s,{max:60})).filter(Boolean);
    return{name:cleanText(raw.name,{max:120}),specialty:cleanText(raw.specialty??'',{max:120}),days:parseWeekdays(raw.days),start,end,
      services:services.length?services:['Cleaning','Exam','Consultation'],...(raw.idempotency_key?{idempotency_key:raw.idempotency_key}:{})};
  },
  authorize:adminOnly,
  preconditions:async(a,c,db)=>{if((await db.legacy.list(c.orgId,'doctors')).some(d=>same(d.name,a.name)))throw new ToolError('RESOURCE_CONFLICT','That doctor is already saved.',{field:'name',retryable:false,nextStep:'Use update_doctor to change their details.'})},
  run:async(a,c,db)=>{await db.legacy.addDoctor(c.orgId,{name:a.name,specialty:a.specialty,days:a.days,start:a.start,end:a.end,slot:30,services:a.services});return{name:a.name}}});

/* Never deletes. Asks the database for a single-use confirmation bound to this user, clinic and doctor; the token goes to the
   signed-in person's screen as a confirmation card (c.out), never to the model. Only their click on Confirm deletes. */
export const removeDoctor=def({name:'remove_doctor',minRole:'admin',patientData:'none',writes:false,
  description:'Ask to remove a doctor by name. This does NOT delete anything: it shows the signed-in owner or admin a confirmation card, and only their click on Confirm removes the doctor. Never say the doctor was removed.',
  input:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:120}}},
  output:{type:'object',required:['awaiting_confirmation','doctor'],properties:{awaiting_confirmation:{type:'boolean'},doctor:{type:'string'},upcoming_bookings:{type:'integer'}}},
  errors:['ENTITY_NOT_FOUND','PERMISSION_DENIED','UNAVAILABLE'],authorize:adminOnly,
  run:async(a,c,db)=>{
    if(!c.out?.confirmations)throw new ToolError('PERMISSION_DENIED','Removing a doctor needs a person to confirm it in the app.',{retryable:false});
    const hit=(await db.legacy.list(c.orgId,'doctors')).find(d=>same(d.name,a.name));
    if(!hit)throw new ToolError('ENTITY_NOT_FOUND','No doctor with that name.',{field:'name',retryable:false});
    const r=await db.legacy.requestDoctorDeletion(c.orgId,hit.id);
    if(!c.out.confirmations.some(x=>x.doctor_id===r.doctor_id))c.out.confirmations.push({action:'delete_doctor',...r});
    return{awaiting_confirmation:true,doctor:r.doctor,upcoming_bookings:r.upcoming_bookings};
  }});

export const saveAnswer=def({name:'save_answer',minRole:'admin',patientData:'none',writes:true,idempotent:'required',autoKey:true,
  description:'Save or update an answer the front desk can give. Use only facts the user gave you.',
  input:{type:'object',additionalProperties:false,required:['topic','answer'],properties:{topic:{type:'string',minLength:1,maxLength:200},answer:{type:'string',minLength:1,maxLength:2000},
    triggers:{type:'string',maxLength:200,description:'3-6 words a customer would type'},idempotency_key:AKEY}},
  output:{type:'object',required:['topic','updated'],properties:{topic:{type:'string'},updated:{type:'boolean'}}},
  errors:['INVALID_ARGUMENT','PERMISSION_DENIED','UNAVAILABLE'],authorize:adminOnly,
  run:async(a,c,db)=>{
    const row={title:cleanText(a.topic,{max:200}),body:cleanText(a.answer,{max:2000}),keywords:cleanText(a.triggers||a.topic,{max:200})};
    return{topic:row.title,updated:await db.legacy.upsertAnswer(c.orgId,row)};
  }});

export const removeAnswer=def({name:'remove_answer',minRole:'admin',patientData:'none',writes:true,idempotent:'required',autoKey:true,
  description:'Delete a saved answer by topic.',
  input:{type:'object',additionalProperties:false,required:['topic'],properties:{topic:{type:'string',minLength:1,maxLength:200},idempotency_key:AKEY}},
  output:{type:'object',required:['removed'],properties:{removed:{type:'string'}}},
  errors:['ENTITY_NOT_FOUND','PERMISSION_DENIED','UNAVAILABLE'],authorize:adminOnly,
  run:async(a,c,db)=>{
    const hit=(await db.legacy.list(c.orgId,'kb')).find(k=>same(k.title,a.topic));
    if(!hit)throw new ToolError('ENTITY_NOT_FOUND','No answer with that topic.',{field:'topic',retryable:false});
    await db.legacy.deleteAnswer(c.orgId,hit.id);return{removed:hit.title};
  }});

export const listSetup=def({name:'list_setup',minRole:'staff',patientData:'none',
  description:'Show the doctors and answers already saved. Call before adding, to avoid duplicates.',
  input:{type:'object',additionalProperties:false,properties:{}},
  output:{type:'object',required:['doctors','answers'],properties:{doctors:{type:'array'},answers:{type:'array'}}},
  run:async(a,c,db)=>{
    const [docs,kb]=await Promise.all([db.legacy.list(c.orgId,'doctors'),db.legacy.list(c.orgId,'kb')]);
    return{doctors:docs.map(d=>({name:d.name,days:d.days,hours:`${d.start}-${d.end}`,services:d.services})),answers:kb.map(k=>k.title)};
  }});

export const setupTools=[addDoctor,updateDoctor,removeDoctor,addService,saveAnswer,removeAnswer,listSetup];
export {todayIn};
