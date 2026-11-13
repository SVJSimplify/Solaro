/* Maps database errors (Postgres SQLSTATE, as returned through the Supabase client) to typed tool errors. */
import {ToolError} from './errors.js';

export function mapDbError(e){
  if(e instanceof ToolError)return e;
  const code=e?.code, msg=String(e?.message??'');
  if(code==='23505')return new ToolError('RESOURCE_CONFLICT','That is already recorded. Correct the existing record instead of adding another.',{retryable:false,nextStep:'Look up the existing record and correct it.'});
  if(code==='42501')return new ToolError('PERMISSION_DENIED',msg.includes('confirm')?'Only an owner or admin can confirm this. Record it as tentative instead.':'You do not have permission for this change.',{retryable:false});
  if(code==='P0002')return new ToolError('ENTITY_NOT_FOUND','That record was not found.',{retryable:false});
  if(code==='22023'||code==='23514'||code==='P0001')return new ToolError('PRECONDITION_FAILED',msg.replace(/^ERROR:\s*/,'').slice(0,200)||'That change is not allowed.',{retryable:false});
  if(code==='23P01')return new ToolError('RESOURCE_CONFLICT','This overlaps existing hours. Adjust the times or correct the existing record.',{retryable:false});
  if(code==='40001'||code==='40P01'||code==='57014'||code==='08006'||code==='08001')return new ToolError('UNAVAILABLE','The database was busy. Try again shortly.',{retryable:true});
  return new ToolError('EXECUTION_FAILED','The change could not be saved. Nothing was recorded.',{retryable:false});
}
