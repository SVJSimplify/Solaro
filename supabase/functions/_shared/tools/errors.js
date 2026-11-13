/* Typed tool errors. Every failure reaches the model or the UI in one envelope. Stack traces never leave the server. */
export const CODES=['INVALID_ARGUMENT','MISSING_INFORMATION','ENTITY_NOT_FOUND','AMBIGUOUS_ENTITY','PERMISSION_DENIED',
  'APPROVAL_REQUIRED','RESOURCE_CONFLICT','UNAVAILABLE','RATE_LIMITED','PRECONDITION_FAILED','EXECUTION_FAILED','VERIFICATION_FAILED'];

/* Only these may be retried by the caller. Permission and validation errors are never retried. */
const RETRYABLE=new Set(['UNAVAILABLE','RATE_LIMITED']);

export class ToolError extends Error{
  constructor(code,message,opts={}){
    if(!CODES.includes(code))throw new Error('Unknown tool error code: '+code);
    super(message);
    this.name='ToolError';
    this.code=code;
    this.field=opts.field??null;
    this.nextStep=opts.nextStep??null;
    this.alternatives=opts.alternatives??null;
    this.retryable=opts.retryable??RETRYABLE.has(code);
  }
}

/* The envelope every tool returns: {ok:true,data} or {ok:false,error}. */
export const ok=(data,meta={})=>({ok:true,data,meta});
export const fail=e=>({ok:false,error:{code:e.code,message:e.message,field:e.field,retryable:e.retryable,next_step:e.nextStep,alternatives:e.alternatives}});

/* Converts anything thrown into a safe envelope. Unknown errors are not shown to the model in detail. */
export function toEnvelope(err){
  if(err instanceof ToolError)return fail(err);
  return fail(new ToolError('EXECUTION_FAILED','The action did not finish. Check the result before trying again.',{retryable:false}));
}
