/* Strict schema validation for tool inputs and outputs. One schema serves the model, the browser and the server.
   Supported keywords: type, enum, required, properties, additionalProperties:false, items, minItems, maxItems,
   minLength, maxLength, pattern, minimum, maximum, and format date|time|uuid.
   Properties marked "x-normalise" accept natural language in the raw phase; their format is checked after normalisation. */
import {ToolError} from './errors.js';

const DATE=/^\d{4}-\d{2}-\d{2}$/, TIME=/^([01]\d|2[0-3]):[0-5]\d$/, UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isIsoDate=s=>{if(!DATE.test(s))return false;const [y,m,d]=s.split('-').map(Number);const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d};

function typeOk(t,v){
  switch(t){
    case 'string':return typeof v==='string';
    case 'integer':return Number.isInteger(v);
    case 'number':return typeof v==='number'&&Number.isFinite(v);
    case 'boolean':return typeof v==='boolean';
    case 'null':return v===null;
    case 'array':return Array.isArray(v);
    case 'object':return v!==null&&typeof v==='object'&&!Array.isArray(v);
    default:return false;
  }
}

function walk(s,v,path,raw,issues){
  const label=path||'input';
  if(s.type&&!([].concat(s.type)).some(t=>typeOk(t,v))){
    issues.push({code:'INVALID_ARGUMENT',path,message:`${label} must be ${[].concat(s.type).join(' or ')}`});return;
  }
  if(s.enum&&!s.enum.includes(v)){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} must be one of: ${s.enum.join(', ')}`});return}
  if(typeof v==='string'){
    if(s.minLength!==undefined&&v.length<s.minLength){issues.push({code:v.length===0?'MISSING_INFORMATION':'INVALID_ARGUMENT',path,message:`${label} is required`});return}
    if(s.maxLength!==undefined&&v.length>s.maxLength){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} is longer than ${s.maxLength} characters`});return}
    const checkFormat=!(raw&&s['x-normalise']);
    if(checkFormat&&s.pattern&&!new RegExp(s.pattern).test(v)){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} has an invalid format`});return}
    if(checkFormat&&s.format==='date'&&!isIsoDate(v)){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} must be a real date in YYYY-MM-DD form`});return}
    if(checkFormat&&s.format==='time'&&!TIME.test(v)){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} must be a time in HH:MM (24-hour) form`});return}
    if(checkFormat&&s.format==='uuid'&&!UUID.test(v)){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} is not a valid id`});return}
  }
  if(typeof v==='number'){
    if(s.minimum!==undefined&&v<s.minimum){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} must be at least ${s.minimum}`});return}
    if(s.maximum!==undefined&&v>s.maximum){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} must be at most ${s.maximum}`});return}
  }
  if(Array.isArray(v)){
    if(s.minItems!==undefined&&v.length<s.minItems){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} needs at least ${s.minItems} item(s)`});return}
    if(s.maxItems!==undefined&&v.length>s.maxItems){issues.push({code:'INVALID_ARGUMENT',path,message:`${label} has more than ${s.maxItems} items`});return}
    if(s.items)v.forEach((x,i)=>walk(s.items,x,`${path}[${i}]`,raw,issues));
  }
  if(v!==null&&typeof v==='object'&&!Array.isArray(v)){
    const props=s.properties??{};
    for(const r of s.required??[]){
      if(v[r]===undefined||v[r]===null)issues.push({code:'MISSING_INFORMATION',path:path?`${path}.${r}`:r,message:`${r} is required`});
    }
    if(s.additionalProperties===false){
      for(const k of Object.keys(v))if(!(k in props))issues.push({code:'INVALID_ARGUMENT',path:path?`${path}.${k}`:k,message:`unknown field "${k}"`});
    }
    for(const [k,ps] of Object.entries(props)){
      if(v[k]===undefined)continue;
      walk(ps,v[k],path?`${path}.${k}`:k,raw,issues);
    }
  }
}

/* Returns a list of issues. Empty list means valid. */
export function validate(schema,value,{phase='canonical'}={}){
  const issues=[];
  walk(schema,value,'',phase==='raw',issues);
  return issues;
}

/* Throws a ToolError for the first problem, with the field name and a next step the model can act on. */
export function assertValid(schema,value,{phase='canonical',code}={}){
  const issues=validate(schema,value,{phase});
  if(!issues.length)return;
  const first=issues[0];
  const outCode=code??first.code;
  throw new ToolError(outCode,first.message,{
    field:first.path||null,
    nextStep:outCode==='MISSING_INFORMATION'?`Provide ${first.path||'the missing value'} and try again.`:null,
  });
}
