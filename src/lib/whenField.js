/* A form field that asks when the patient wants to come in. The assistant sometimes builds these as plain text
   ("Preferred time"), so they are recognised by type, name or label and always get the open-times clock.
   Birthdays and similar personal dates are excluded. */
const WHEN=/\b(time|date|day|when|slot|appointment|schedule|availability)\b|preferred/i;
const NOT=/birth|dob|\bage\b|insurance|expir|policy|last visit|since/i;
export const isWhenField=f=>{
  if(!f||f.type==='select'||f.type==='textarea')return false;
  const t=`${f.name||''} ${f.label||''}`.replace(/_/g,' ');
  return f.type==='datetime-local'||((f.type==='date'||f.type==='text'||f.type==='time'||!f.type)&&WHEN.test(t)&&!NOT.test(t));
};
/* The service the patient picked in the same form, if any. */
export const serviceOf=(form,values)=>{const f=form.fields.find(x=>x.type==='select'&&/service|treatment|reason|procedure/i.test(`${x.name} ${x.label}`));return f?values[f.name]||'':''};
/* One clock covers every date/time field in a form; label it for both when there are several. */
export const whenLabel=(form,f)=>form.fields.filter(isWhenField).length>1?'Preferred date and time':f.label;
