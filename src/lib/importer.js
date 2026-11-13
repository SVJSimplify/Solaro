/* Quick setup parser. Reads doctors and answers from messy plain text (pasted, or converted from
   CSV / Excel / Google Sheets / PDF). Column order and headers are detected, not required.
   Anything it has to guess is reported in `notes`; anything it can't use is reported in `errors`.

   Accepted shapes, all optional:
     [doctors] / [answers] section markers
     A header row (Name, Days, Hours, Services / Topic, Answer, Triggers), any order
     Cells separated by "|" (or a single line, which is read by content) */
import {DAYS} from './schedule';

const DAY_IDX=Object.fromEntries(DAYS.map((d,i)=>[d.slice(0,3).toLowerCase(),i]));
const DAY_WORD='(?:mon|tue|wed|thu|fri|sat|sun|daily|everyday)[a-z]*';
const DAY_RE=new RegExp(`\\b${DAY_WORD}(?:\\s*(?:-|–|to|,|&|and)\\s*${DAY_WORD})*`,'i');
const TIME_RE=/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|to)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/i;
const SERVICE_WORDS=/\b(clean|exam|consult|emergen|x-?ray|filling|extract|whiten|checkup|check-up|root|crown|implant|braces|hygien|scal|ortho|surgery)/i;

/* ---------- days & hours ---------- */
export function parseDays(s){
  const t=String(s).trim().toLowerCase().replace(/\s+to\s+/g,'-').replace(/–/g,'-').replace(/\s+and\s+|\s*&\s*/g,',');
  if(/^(daily|everyday|every day|7 days?)$/.test(t))return[0,1,2,3,4,5,6];
  const out=new Set();
  for(const part of t.split(',').map(p=>p.trim()).filter(Boolean)){
    const m=part.match(/^([a-z]{3,9})\s*-\s*([a-z]{3,9})$/);
    if(m){
      const a=DAY_IDX[m[1].slice(0,3)],b=DAY_IDX[m[2].slice(0,3)];
      if(a===undefined||b===undefined)return null;
      for(let i=a;i!==(b+1)%7;i=(i+1)%7)out.add(i);
    }else{
      const d=DAY_IDX[part.slice(0,3)];
      if(d===undefined||!/^[a-z]{3,9}$/.test(part))return null;
      out.add(d);
    }
  }
  return out.size?[...out].sort():null;
}

const clock=s=>{
  const m=String(s).trim().toLowerCase().replace(/\./g,':').replace(/:(?=[ap]m)/,'').replace(/\s+/g,'').match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if(!m)return null;
  let h=+m[1];const mi=+(m[2]||0);
  if(m[3]==='pm'&&h<12)h+=12;
  if(m[3]==='am'&&h===12)h=0;
  if(h>23||mi>59)return null;
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
};
export function parseHours(s){
  const t=String(s).replace(/\s*(?:–|—|-|\bto\b)\s*/gi,'-');
  const [a,b]=t.split('-');
  if(b===undefined)return null;
  const start=clock(a),end=clock(b);
  return start&&end&&start<end?{start,end}:null;
}

/* ---------- header detection ---------- */
const ROLE_WORDS={
  name:/^(name|doctor|dr|staff|provider|dentist|employee)$/i,
  specialty:/^(specialty|speciality|dept|department|role|title|field)$/i,
  days:/^(days?|working days|available days|day)$/i,
  hours:/^(hours?|times?|shift|schedule|working hours|availability)$/i,
  services:/^(services?|treatments?|offers?|procedures?)$/i,
  topic:/^(topic|question|subject|title|q|faq)$/i,
  answer:/^(answer|response|info|information|details|body|a|reply)$/i,
  triggers:/^(triggers?|keywords?|tags?|search terms?)$/i,
};
const roleOf=c=>Object.keys(ROLE_WORDS).find(r=>ROLE_WORDS[r].test(String(c).trim()))??null;
const isHeader=cells=>cells.filter(c=>roleOf(c)).length>=2;
const headerMap=cells=>cells.map(c=>roleOf(c));

/* ---------- row readers ---------- */
const SCHEDULE_TEXT=/\d|\b(mon|tue|wed|thu|fri|sat|sun|daily|everyday)/i;
/* Name part of a cell: everything before the first day, time or service word. */
const namePart=x=>{
  const hits=[x.search(DAY_RE),x.search(TIME_RE),x.search(SERVICE_WORDS)].filter(v=>v>0);
  return(hits.length?x.slice(0,Math.min(...hits)):x).replace(/[,;:\s]+$/,'').trim();
};
/* Services: the words after the hours (or the whole cell), split on commas, "and", slashes. */
const SERVICE_TOKEN=/\b(?:clean|exam|consult|emergen|x-?ray|filling|extract|whiten|checkup|check-up|root|crown|implant|braces|hygien|scal|ortho|surgery)\w*/gi;
const servicePart=x=>{
  const t=x.replace(TIME_RE,' ').replace(DAY_RE,' ');
  const seps=/,|\/|;|\band\b|\+/i;
  if(seps.test(t))return t.split(/,|\/|;|\band\b|\+/i).map(v=>v.match(SERVICE_TOKEN)?.[0]??'').filter(Boolean).map(v=>v.trim());
  return[...new Set(t.match(SERVICE_TOKEN)??[])];
};

/* A header only steers the columns when it lines up with the row; otherwise the row is read by content. */
const aligned=(roles,cells)=>roles&&roles.length===cells.length?roles:null;

function readDoctor(cells,rolesIn,notes,line){
  const roles=aligned(rolesIn,cells);
  const at=role=>roles?cells[roles.indexOf(role)]??'':'';
  const cand=cells.filter(Boolean);
  // days and hours: trust the header column if it parses, otherwise search every cell
  let days=parseDays(at('days'))??null,hours=parseHours(at('hours'))??null;
  if(!days)for(const c of cand){const m=c.match(DAY_RE);if(m&&(days=parseDays(m[0])))break}
  if(!hours)for(const c of cand){const m=c.match(TIME_RE);if(m&&(hours=parseHours(m[0])))break}
  // name: header column, else a "Dr ..." cell, else the first cell that isn't a schedule
  let name=namePart(at('name'))||'';
  if(!name)name=cand.map(namePart).find(v=>/^dr\b/i.test(v))??cand.map(namePart).find(v=>v&&!SCHEDULE_TEXT.test(v))??'';
  // services: header column, else any service words in the row
  let services=at('services')?servicePart(at('services')):[];
  if(!services.length)for(const c of cand){services=servicePart(c);if(services.length)break}
  // specialty: header column, else the first plain-text cell that is not the name or schedule
  let specialty=at('specialty').trim();
  if(!specialty||specialty===name)specialty=cand.find(c=>c!==name&&!namePart(c).match(/^dr\b/i)&&!DAY_RE.test(c)&&!TIME_RE.test(c)&&!SERVICE_WORDS.test(c))??'';
  specialty=specialty.replace(/\s+/g,' ').trim();
  if(!days){days=[1,2,3,4,5];notes.push({line,why:`${name||'Doctor'}: no working days found, set to Mon–Fri`})}
  if(!hours){hours={start:'09:00',end:'17:00'};notes.push({line,why:`${name||'Doctor'}: no hours found, set to 9am–5pm`})}
  return{name:name.replace(/\s+/g,' ').trim(),specialty,days,start:hours.start,end:hours.end,slot:30,
    services:services.length?services:['Cleaning','Exam','Consultation']};
}

function readAnswer(cells,rolesIn,notes,line){
  const roles=aligned(rolesIn,cells);
  const at=role=>roles?cells[roles.indexOf(role)]??'':'';
  let topic=at('topic').trim(),body=at('answer').trim(),trig=at('triggers').trim();
  const rest=cells.filter((_,i)=>!roles||!roles[i]).filter(Boolean);
  // a single cell: "Topic: answer", or a plain sentence (first words become the topic)
  if(!topic&&!body&&rest.length===1){
    const m=rest[0].match(/^([^:]{2,60}):\s*(.+)$/);
    if(m){topic=m[1].trim();body=m[2].trim()}
    else{const w=rest[0].split(/\s+/);topic=w.slice(0,3).join(' ');body=rest[0];notes.push({line,why:`"${topic}…": no topic given, used the first words`})}
  }
  if(!topic&&rest.length>1)topic=rest.reduce((a,b)=>a.length<=b.length?a:b).trim();
  if(!body)body=rest.filter(c=>c!==topic).sort((a,b)=>b.length-a.length)[0]?.trim()??'';
  if(!topic||!body)return null;
  if(!trig){trig=topic.toLowerCase();notes.push({line,why:`"${topic}": no trigger words, used the topic`})}
  return{title:topic,body,keywords:trig};
}

/* Cells split on "|", then tab, then commas (only when there are several, so prose stays whole). */
const splitCells=line=>{
  let cells=line.includes('|')?line.split('|'):line.includes('\t')?line.split('\t'):((line.match(/,/g)||[]).length>=2?line.split(','):[line]);
  cells=cells.map(c=>c.trim());
  while(cells.length&&cells.at(-1)==='')cells.pop();
  return cells;
};

/* ---------- main ---------- */
export function parseSetup(text){
  const doctors=[],answers=[],errors=[],notes=[];
  let section=null,roles=null,kind=null;
  text.split(/\r?\n/).forEach((raw,i)=>{
    const line=raw.trim(),n=i+1;
    if(!line||line.startsWith('#'))return;
    const marker=line.match(/^\[(doctors|answers)\]$/i);
    if(marker){section=marker[1].toLowerCase();roles=null;kind=null;return}
    const cells=splitCells(line);
    while(cells.length&&cells.at(-1)==='')cells.pop();
    if(isHeader(cells)){
      roles=headerMap(cells);
      kind=roles.includes('days')||roles.includes('hours')||roles.includes('services')||roles.includes('specialty')?'doctors':
           roles.includes('topic')||roles.includes('answer')?'answers':null;
      return;
    }
    const k=section??kind;
    try{
      if(k==='doctors'){doctors.push(readDoctor(cells,roles,notes,n));return}
      if(k==='answers'){const a=readAnswer(cells,roles,notes,n);if(a)answers.push(a);else errors.push({line:n,text:line,why:'needs a topic and an answer'});return}
      // no section or header: decide by content
      const looksDoctor=cells.some(c=>DAY_RE.test(c)&&parseDays(c.match(DAY_RE)[0]))||cells.some(c=>TIME_RE.test(c))||cells.some(c=>SERVICE_WORDS.test(c)&&c.includes(','));
      if(looksDoctor){doctors.push(readDoctor(cells,null,notes,n));return}
      const a=readAnswer(cells,null,notes,n);
      if(a)answers.push(a);else errors.push({line:n,text:line,why:'could not tell what this line is'});
    }catch(e){errors.push({line:n,text:line,why:'could not read this line'})}
  });
  return{doctors,answers,errors,notes};
}

export const EXAMPLE=`[doctors]
Dr. Anita Rao | General dentistry | Mon-Fri | 8am-4pm | Cleaning, Exam, Consultation
[answers]
Hours | Mon–Fri 8am–6pm, Saturday 9am–2pm. Closed Sunday. | hours open close
Pricing | A routine cleaning is $120 without insurance. | price cost fee`;

/* Import preview: what an import would add, and which rows match an existing doctor or answer (by name / topic).
   Existing records are kept unless the user explicitly chooses to update them. Imports never delete. */
export function diffImport(plan,doctors=[],kb=[]){
  const key=v=>String(v||'').trim().toLowerCase();
  const dn=new Set(doctors.map(d=>key(d.name))),kn=new Set(kb.map(k=>key(k.title)));
  const seenD=new Set(),seenK=new Set();
  const newDoctors=[],dupDoctors=[],newAnswers=[],dupAnswers=[];
  for(const d of plan.doctors){if(seenD.has(key(d.name)))continue;seenD.add(key(d.name));(dn.has(key(d.name))?dupDoctors:newDoctors).push(d)}
  for(const a of plan.answers){if(seenK.has(key(a.title)))continue;seenK.add(key(a.title));(kn.has(key(a.title))?dupAnswers:newAnswers).push(a)}
  return{newDoctors,dupDoctors,newAnswers,dupAnswers,plan:{...plan,doctors:[...newDoctors,...dupDoctors],answers:[...newAnswers,...dupAnswers]}};
}
