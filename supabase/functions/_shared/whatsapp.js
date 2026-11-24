/* Meta WhatsApp Cloud API helpers. Pure; never log numbers, tokens or message text. */
import {normalizePhone} from './tools/phone.js';

/* Digits-only E.164 without "+", or '' when the number is not usable. A number without a country code is read in the clinic's country ('US' or 'IN'), never assumed Indian. */
export function toWaNumber(phone,country='US'){return(normalizePhone(phone,country)??'').replace(/^\+/,'')}

/* Default template name per data.template; the templates option overrides them. */
export const WA_TEMPLATES={reminder:'appointment_reminder',confirmation:'appointment_confirmation',cancellation:'appointment_cancellation',reschedule:'appointment_reschedule',decline:'appointment_declined'};

/* A reminder, confirmation, cancellation, reschedule or decline with params becomes a template message (params are the body text params, in order); anything else is plain text. */
export function buildWaPayload(msg,{templates,lang='en',country}={}){
  const to=toWaNumber(msg?.to_addr??msg?.to,country);
  const params=msg?.data?.params;
  const name=Object.hasOwn(WA_TEMPLATES,msg?.data?.template)?{...WA_TEMPLATES,...templates}[msg.data.template]:'';
  if(name&&Array.isArray(params)&&params.length)
    return{messaging_product:'whatsapp',to,type:'template',template:{name,language:{code:lang},
      components:[{type:'body',parameters:params.map(p=>({type:'text',text:String(p??'').slice(0,1024)}))}]}};
  return{messaging_product:'whatsapp',to,type:'text',text:{preview_url:false,body:String(msg?.body??'').slice(0,4096)}};
}

/* cfg: {phoneNumberId, accessToken, templates, lang, fetchImpl}. Returns {ok:true,id} or {ok:false,error}; never throws. */
export async function sendWhatsApp(cfg,msg){
  try{
    if(!cfg?.phoneNumberId||!cfg?.accessToken)return{ok:false,error:'WhatsApp is not configured'};
    const payload=buildWaPayload(msg,{templates:cfg.templates,lang:cfg.lang,country:cfg.country});
    if(!payload.to)return{ok:false,error:'Invalid phone number'};
    const r=await(cfg.fetchImpl??fetch)(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneNumberId)}/messages`,{
      method:'POST',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Bearer '+cfg.accessToken,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j?.messages?.[0]?.id)return{ok:true,id:String(j.messages[0].id)};
    return{ok:false,error:`Provider ${r.status}: ${String(j?.error?.message??'').slice(0,160)}`};
  }catch(e){return{ok:false,error:String(e?.name==='TimeoutError'?'Timed out':e?.message??e).slice(0,200)}}
}
