/* The tool registry: the single source of truth for every tool's name, schema, permissions and behaviour.
   Model-facing definitions, browser validation and server enforcement all come from here. Nothing is maintained separately. */
import {ToolError} from './errors.js';

const NAME=/^[a-z][a-z0-9_]{2,63}$/;
export const ROLE_RANK={doctor:1,staff:2,admin:3,owner:4};
export const hasRole=(role,min)=>(ROLE_RANK[role]??-1)>=(ROLE_RANK[min]??99);
/* Website visitors run as the "public" principal: they may use only tools marked public:true, and nothing else. */
export const canUse=(role,tool)=>role==='public'?tool.public===true:hasRole(role,tool.minRole);

/* Validates a tool definition at load time, so a malformed tool fails at startup, not at run time. */
export function defineTool(def){
  const problems=[];
  if(!NAME.test(def.name??''))problems.push('name');
  if(!Number.isInteger(def.version)||def.version<1)problems.push('version');
  if(typeof def.description!=='string'||def.description.length<20)problems.push('description');
  if(!def.input||def.input.type!=='object'||def.input.additionalProperties!==false)problems.push('input (object with additionalProperties:false)');
  if(!def.output||def.output.type!=='object')problems.push('output (object schema)');
  if(!ROLE_RANK[def.minRole])problems.push('minRole');
  if(typeof def.run!=='function')problems.push('run');
  if(typeof def.writes!=='boolean')problems.push('writes');
  if(def.writes===true&&def.idempotent!=='required')problems.push('idempotent (writes must declare idempotent:"required")');
  if(!Array.isArray(def.errors)||!def.errors.length)problems.push('errors (typed error codes this tool can return)');
  if(problems.length)throw new Error(`Invalid tool "${def.name??'(unnamed)'}": ${problems.join('; ')}`);
  return Object.freeze({canonical:def.input,...def});
}

export class ToolRegistry{
  #tools=new Map();
  constructor(defs){
    for(const d of defs){
      const t=defineTool(d);
      if(this.#tools.has(t.name))throw new Error('Duplicate tool name: '+t.name);
      this.#tools.set(t.name,t);
    }
  }
  get(name){
    const t=this.#tools.get(name);
    if(!t)throw new ToolError('INVALID_ARGUMENT',`Unknown tool "${String(name).slice(0,80)}".`,{field:'tool',alternatives:[...this.#tools.keys()]});
    return t;
  }
  list(){return [...this.#tools.values()]}
}

const stripExtensions=s=>{
  if(Array.isArray(s))return s.map(stripExtensions);
  if(s&&typeof s==='object'){const o={};for(const [k,v] of Object.entries(s))if(!k.startsWith('x-'))o[k]=stripExtensions(v);return o}
  return s;
};

/* Model-facing tool definitions in the provider's native function-calling format, generated from the registry.
   Only tools the role may use are included, and a tool may narrow its own fields for that role (for example, staff may only choose "tentative"). */
export function modelToolsFor(registry,{role,surface}){
  return registry.list()
    .filter(t=>!t.hidden&&canUse(role,t)&&(!surface||!t.surfaces||t.surfaces.includes(surface))&&(role!=='doctor'||t.patientData==='none'))
    .map(t=>({type:'function',function:{
      name:t.name,
      description:t.description,
      parameters:stripExtensions(t.inputFor?t.inputFor(role):t.input),
    }}));
}
