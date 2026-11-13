/* The one place the tool set is assembled. Everything that runs or advertises a tool goes through this registry. */
import {ToolRegistry} from './registry.js';
import {informationTools} from './information.js';
import {extractionTools} from './extraction.js';
import {frontTools,setupTools,publicOnlyTools} from './front.js';

const on=(tools,surfaces)=>tools.map(t=>({...t,surfaces}));

/* surfaces: "front" = the in-app front desk; "public" = the website chat (tools marked public:true only);
   "staff" = the staff assistant (setup and business information). */
export const buildRegistry=()=>new ToolRegistry([...on(informationTools,['staff']),...on(extractionTools,['staff']),...on(setupTools,['staff']),
  ...frontTools.map(t=>({...t,surfaces:t.public?['front','public']:['front']})),...on(publicOnlyTools,['public'])]);
export {ToolRegistry,modelToolsFor,hasRole} from './registry.js';
export {executeTool} from './executor.js';
export {runToolLoop} from './loop.js';
