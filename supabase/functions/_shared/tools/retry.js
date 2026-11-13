/* Bounded exponential backoff with full jitter, and a timeout. Only retryable errors are retried. */
import {ToolError} from './errors.js';

export const defaultIsRetryable=e=>e instanceof ToolError&&e.retryable;

export async function withRetry(fn,{attempts=3,baseMs=100,maxMs=2000,random=Math.random,
    sleep=ms=>new Promise(r=>setTimeout(r,ms)),isRetryable=defaultIsRetryable}={}){
  for(let attempt=1;;attempt++){
    try{return await fn(attempt)}
    catch(e){
      if(attempt>=attempts||!isRetryable(e))throw e;
      const cap=Math.min(maxMs,baseMs*2**(attempt-1));
      await sleep(Math.floor(random()*cap));
    }
  }
}

export function withTimeout(promise,ms,label='operation'){
  let t;
  const timer=new Promise((_,rej)=>{t=setTimeout(()=>rej(new ToolError('UNAVAILABLE',`${label} took too long. Check the result before trying again.`,{retryable:true})),ms)});
  return Promise.race([promise,timer]).finally(()=>clearTimeout(t));
}
