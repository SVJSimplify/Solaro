/* Phone numbers for US (+1) and Indian (+91) customers. Solara is US-first: an ambiguous 10-digit number is read as US
   unless the clinic is in India (see countryForTimeZone).
   Accepts the formats people actually type, e.g. "+91 98765 43210", "098765 43210", "9876543210",
   "+1 (415) 555-0132", "1-415-555-0132", "0091 98765 43210", "tel:+14155550132".
   Returns E.164 ("+919876543210", "+14155550132") or null. A bare 10-digit number that is valid in
   both countries is read as the business's default country. */

const US=/^[2-9]\d{2}[2-9]\d{6}$/;   // area code and exchange cannot start with 0 or 1
const IN=/^[6-9]\d{9}$/;             // Indian mobile numbers start with 6-9

const clean=raw=>String(raw||'').trim().replace(/^tel:/i,'').replace(/[\s().\-\u00a0]/g,'');

/* The default country for a clinic, from its time zone. */
export const countryForTimeZone=tz=>/^Asia\/(Kolkata|Calcutta)$/.test(String(tz||''))?'IN':'US';

export function normalizePhone(raw,defaultCountry='US'){
  let s=clean(raw);
  if(!s)return null;
  if(s.startsWith('00'))s='+'+s.slice(2);
  if(s.startsWith('+')){
    const d=s.slice(1);
    if(!/^\d+$/.test(d))return null;
    if(d.startsWith('91')&&IN.test(d.slice(2)))return '+'+d;
    if(d.startsWith('1')&&US.test(d.slice(1)))return '+'+d;
    return null;
  }
  if(!/^\d+$/.test(s))return null;
  if(s.length===11&&s[0]==='0'&&IN.test(s.slice(1)))return '+91'+s.slice(1);   // 098765 43210
  if(s.length===11&&s[0]==='1'&&US.test(s.slice(1)))return '+1'+s.slice(1);    // 1 415 555 0132
  if(s.length===12&&s.startsWith('91')&&IN.test(s.slice(2)))return '+'+s;      // 91 98765 43210
  if(s.length===10){
    const inOk=IN.test(s),usOk=US.test(s);
    if(inOk&&usOk)return defaultCountry==='US'?'+1'+s:'+91'+s;
    if(inOk)return '+91'+s;
    if(usOk)return '+1'+s;
  }
  return null;
}

export const isValidPhone=(raw,defaultCountry)=>normalizePhone(raw,defaultCountry)!==null;

/* 'IN', 'US' or null for a stored E.164 number. */
export function phoneCountry(e164){
  if(!e164)return null;
  return e164.startsWith('+91')?'IN':e164.startsWith('+1')?'US':null;
}

/* Readable form for screens: "+91 98765 43210" or "+1 (415) 555-0132". */
export function formatPhone(e164){
  if(!e164)return '';
  if(e164.startsWith('+91')&&e164.length===13)return `+91 ${e164.slice(3,8)} ${e164.slice(8)}`;
  if(e164.startsWith('+1')&&e164.length===12)return `+1 (${e164.slice(2,5)}) ${e164.slice(5,8)}-${e164.slice(8)}`;
  return e164;
}

export const PHONE_HINT='US or India, e.g. (415) 555-0132 or +91 98765 43210';
export const PHONE_ERROR='Enter a valid US (+1) or Indian (+91) phone number';
