/* Input normalisation: messy but interpretable input becomes one canonical form before strict validation.
   Anything that cannot be interpreted safely is rejected with an actionable error. Nothing is guessed for consequential values. */
import {ToolError} from './errors.js';

export function cleanText(s,{max=500}={}){
  if(typeof s!=='string')return '';
  return s.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}

const WEEKDAYS={sunday:0,sun:0,monday:1,mon:1,tuesday:2,tue:2,tues:2,wednesday:3,wed:3,thursday:4,thu:4,thur:4,thurs:4,friday:5,fri:5,saturday:6,sat:6};
const MONTHS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

const dayMs=s=>{const [y,m,d]=s.split('-').map(Number);return Date.UTC(y,m-1,d)};
const fromMs=ms=>new Date(ms).toISOString().slice(0,10);
const weekdayOf=s=>new Date(dayMs(s)).getUTCDay();
export const addDays=(s,n)=>fromMs(dayMs(s)+n*864e5);
const realDate=(y,m,d)=>{const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d};

/* Today's date in an organisation's time zone, as YYYY-MM-DD. */
export function todayIn(timeZone='UTC',now=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}

/* Resolves a natural-language or ISO date against "today" in the organisation's time zone.
   "tomorrow" and ISO dates are unambiguous. "next Tuesday" is strictly after today. A bare weekday means the next one on or after today. */
export function resolveDate(input,today){
  const raw=cleanText(input,{max:40}).toLowerCase().replace(/[,.]/g,'');
  const fail=()=>new ToolError('INVALID_ARGUMENT',`I could not read the date "${cleanText(input,{max:40})}".`,{
    field:'date',nextStep:'Give the date as YYYY-MM-DD, MM/DD/YYYY, "today", "tomorrow", or a weekday name.'});
  if(!raw)throw new ToolError('MISSING_INFORMATION','A date is required.',{field:'date',nextStep:'Give the date you mean.'});
  if(DATE_RE.test(raw)){
    const [y,m,d]=raw.split('-').map(Number);
    if(!realDate(y,m,d))throw fail();
    return {date:raw,resolvedFrom:'iso'};
  }
  const us=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(us){
    const [, m,d,y]=us.map(Number);
    if(!realDate(y,m,d))throw fail();
    return {date:`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,resolvedFrom:'us_date'};
  }
  if(raw==='today')return {date:today,resolvedFrom:'today'};
  if(raw==='tomorrow')return {date:addDays(today,1),resolvedFrom:'tomorrow'};
  if(raw==='day after tomorrow')return {date:addDays(today,2),resolvedFrom:'day after tomorrow'};
  const rel=raw.match(/^in (\d{1,3}) (day|days|week|weeks)$/);
  if(rel)return {date:addDays(today,Number(rel[1])*(rel[2].startsWith('week')?7:1)),resolvedFrom:'relative'};
  const md=raw.match(/^(?:(\d{1,2}) ([a-z]{3,9})|([a-z]{3,9}) (\d{1,2}))(?: (\d{4}))?$/);
  if(md){
    const mon=MONTHS[(md[2]??md[3]).slice(0,3)], day=Number(md[1]??md[4]);
    if(mon!==undefined&&(md[2]??md[3]).length>=3){
      let y=md[5]?Number(md[5]):Number(today.slice(0,4));
      if(!realDate(y,mon+1,day))throw fail();
      let d=`${y}-${String(mon+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      if(!md[5]&&d<today){y++;if(!realDate(y,mon+1,day))throw fail();d=`${y}-${String(mon+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`}
      return {date:d,resolvedFrom:'month_day'};
    }
  }
  const m=raw.match(/^(this|next)?\s*([a-z]+)$/);
  if(m&&WEEKDAYS[m[2]]!==undefined){
    const target=WEEKDAYS[m[2]], now=weekdayOf(today);
    let delta=(target-now+7)%7;
    if(m[1]==='next'&&delta===0)delta=7;
    return {date:addDays(today,delta),resolvedFrom:m[1]?`${m[1]} ${m[2]}`:m[2]};
  }
  throw fail();
}

/* Resolves a time such as "9:30", "9:30 pm", "9am" into 24-hour HH:MM. A bare hour without am/pm is refused as ambiguous. */
export function resolveTime(input){
  const raw=cleanText(input,{max:20}).toLowerCase().replace(/\s+/g,'');
  const m=raw.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/);
  const bad=()=>new ToolError('INVALID_ARGUMENT',`I could not read the time "${cleanText(input,{max:20})}".`,{field:'time',nextStep:'Give the time like 09:30 or 9:30 AM.'});
  if(!m)throw bad();
  let h=Number(m[1]);const mi=m[2]===undefined?0:Number(m[2]);
  const ap=m[3]?m[3].replace(/\./g,''):null;
  if(!ap&&m[2]===undefined)throw new ToolError('INVALID_ARGUMENT',`"${raw}" could be morning or evening.`,{field:'time',nextStep:'Add AM or PM, or give minutes, e.g. 09:00.'});
  if(ap){if(h<1||h>12)throw bad();h=h%12+(ap==='pm'?12:0)}
  if(h>23||mi>59)throw bad();
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
}

/* Names: lower-case, no titles (Dr., Doctor), no punctuation. "Dr. Sharma" and "dr  sharma" are the same. */
export function normalizeName(s){
  let t=cleanText(s,{max:120}).toLowerCase().replace(/[.,]/g,' ').replace(/\s+/g,' ').trim();
  while(/^(dr|doctor)\s+/.test(t))t=t.replace(/^(dr|doctor)\s+/,'');
  return t;
}

export function levenshtein(a,b){
  if(a===b)return 0;
  let prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const cur=[i];
    for(let j=1;j<=b.length;j++)cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev=cur;
  }
  return prev[b.length];
}

/* Matches a spoken name to one candidate. Exact matches win. A near match is accepted only when it is the single best candidate.
   Several plausible candidates are never resolved silently: the caller gets AMBIGUOUS_ENTITY with the options. */
export function matchEntity(query,candidates,{label='doctor'}={}){
  const q=normalizeName(query);
  if(!q)throw new ToolError('MISSING_INFORMATION',`Which ${label}?`,{field:label,nextStep:`Give the ${label}'s name.`});
  const items=candidates.map(c=>{const n=normalizeName(c.name);return {c,n,tokens:n.split(' ')}});
  // A name matches when it equals the whole name, or every word the speaker used appears in the name.
  const qTokens=q.split(' ');
  const exact=items.filter(x=>x.n===q||qTokens.every(t=>x.tokens.includes(t)));
  if(exact.length===1)return {entity:exact[0].c,confidence:'exact'};
  if(exact.length>1)throw new ToolError('AMBIGUOUS_ENTITY',`More than one ${label} matches "${query}".`,{
    field:label,alternatives:exact.map(x=>x.c.name),nextStep:`Ask which ${label} they mean.`});
  const limit=q.length>=6?2:1;
  const scored=items.map(x=>({x,d:Math.min(levenshtein(q,x.n),...x.tokens.map(t=>levenshtein(q,t)))})).filter(s=>s.d<=limit).sort((a,b)=>a.d-b.d);
  if(scored.length===1)return {entity:scored[0].x.c,confidence:'near',spelledAs:scored[0].x.c.name};
  if(scored.length>1)throw new ToolError('AMBIGUOUS_ENTITY',`"${query}" could be more than one ${label}.`,{
    field:label,alternatives:scored.map(s=>s.x.c.name),nextStep:`Ask which ${label} they mean.`});
  throw new ToolError('ENTITY_NOT_FOUND',`No ${label} called "${query}".`,{
    field:label,alternatives:candidates.map(c=>c.name),nextStep:`Check the ${label} name, or pick one of the alternatives.`});
}

/* Free text: trimmed and bounded. Empty optional text becomes an empty string. */
export const optionalText=(s,max)=>cleanText(s,{max});

/* "Mon-Fri", "Mon, Wed and Friday", "weekdays", "weekends", "daily" -> sorted weekday numbers (0 = Sunday). */
export function parseWeekdays(input){
  const raw=cleanText(input,{max:80}).toLowerCase().replace(/[.]/g,'');
  const bad=()=>new ToolError('INVALID_ARGUMENT',`I could not read the days "${cleanText(input,{max:80})}".`,{field:'weekdays',nextStep:'Give days like "Mon, Wed, Fri" or "Mon-Fri".'});
  if(!raw)throw new ToolError('MISSING_INFORMATION','Which days?',{field:'weekdays'});
  if(/^(daily|every ?day|all days|7 days)$/.test(raw))return [0,1,2,3,4,5,6];
  if(/^(weekdays?|mon(day)? ?(to|-|through) ?fri(day)?)$/.test(raw))return [1,2,3,4,5];
  if(/^weekends?$/.test(raw))return [0,6];
  const out=new Set();
  for(const part of raw.split(/\s*(?:,|&|\band\b|\+)\s*/).filter(Boolean)){
    const r=part.match(/^([a-z]+)\s*(?:-|–|to|through|thru)\s*([a-z]+)$/);
    if(r){
      const a=WEEKDAYS[r[1]],b=WEEKDAYS[r[2]];
      if(a===undefined||b===undefined)throw bad();
      for(let d=a;;d=(d+1)%7){out.add(d);if(d===b)break}
    }else{
      const d=WEEKDAYS[part.replace(/s$/,'')]??WEEKDAYS[part];
      if(d===undefined)throw bad();
      out.add(d);
    }
  }
  if(!out.size)throw bad();
  return [...out].sort((a,b)=>a-b);
}

export const toMinutes=hm=>{const [h,m]=hm.split(':').map(Number);return h*60+m};

/* "9am-5pm", "09:00 to 17:00" -> {start,end} as HH:MM. A bare "9-5" is ambiguous and is refused so someone can say which. */
export function parseTimeRange(input){
  const raw=cleanText(input,{max:40}).toLowerCase();
  const parts=raw.split(/\s*(?:-|–|—|\bto\b|until|till)\s*/);
  if(parts.length!==2||!parts[0]||!parts[1])throw new ToolError('INVALID_ARGUMENT',`I could not read the hours "${cleanText(input,{max:40})}".`,{field:'hours',nextStep:'Give hours like "9am-5pm" or "09:00-17:00".'});
  const start=resolveTime(parts[0]),end=resolveTime(parts[1]);
  if(toMinutes(end)<=toMinutes(start))throw new ToolError('INVALID_ARGUMENT','The end time must be after the start time.',{field:'hours',nextStep:'Check the times, e.g. 9am-5pm.'});
  return {start,end};
}

/* Patient information never goes into business memory. Mirrors contains_patient_info() in the database. */
export function containsPatientInfo(text){
  const t=String(text??'').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'');   // ids are not phone numbers
  return /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t)
    ||/\d(?:[\s().-]?\d){7,}/.test(t.replace(/\d{4}-\d{2}-\d{2}/g,''))
    ||/\b(diagnos\w*|prescri\w*|medical record|mrn|test results?|lab results?|date of birth|dob)\b/i.test(t)
    ||/\bpatient\s+(named|called|id|number)\b/i.test(t);
}

/* Words that mean "not sure yet". A confirmed status is never accepted on a quote that hedges. */
export const isHedged=t=>/\b(might|maybe|perhaps|probably|possibly|not sure|unsure|may be|may not|could be|tentative|likely|i think|not confirmed|to be confirmed|tbc|if all goes)\b/i.test(String(t??''));

/* A source quote must be words the person really wrote. */
export const quoteIsFrom=(quote,message)=>{
  const n=s=>cleanText(s,{max:5000}).toLowerCase();
  return n(quote).length>0&&n(message).includes(n(quote));
};
