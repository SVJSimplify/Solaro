/* Operational helpers shared by every Edge Function: one JSON log line per event, and the shared rate limiter. */

/* Structured log line. Never pass message text, phone numbers or other patient information in fields. */
export function logEvent(fn,fields={}){
  try{console.log(JSON.stringify({ts:new Date().toISOString(),fn,...fields}))}catch{/* logging must never break a request */}
}

/* True when the request is within the limit. One atomic database hit per call (see hit_rate_limit).
   If the limiter itself is unavailable the request is allowed and the failure is logged: a limiter outage must not take the
   front desk down. The daily AI limit and the per-chat message limit still apply independently. */
export async function allow(svc,key,limit,windowSeconds){
  try{
    const {data,error}=await svc.rpc('hit_rate_limit',{p_key:key,p_limit:limit,p_window_seconds:windowSeconds});
    if(error){logEvent('rate_limit',{outcome:'limiter_error',error:String(error.message).slice(0,200)});return true}
    return data!==false;
  }catch(e){logEvent('rate_limit',{outcome:'limiter_error',error:String(e).slice(0,200)});return true}
}
