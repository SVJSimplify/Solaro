/* Meta WhatsApp Cloud API helpers. Pure and dependency-free; never log numbers, tokens or message text. */

/* Digits-only E.164 without "+", or '' when the number is not usable. A 10-digit Indian mobile (6-9...) gets the 91 prefix. */
export function toWaNumber(phone,cc='91'){
  let d=String(phone??'').replace(/\D/g,'');
  d=d.startsWith('00')?d.slice(2):d.replace(/^0/,'');
  if(d.length===10)d=cc==='91'&&!/^[6-9]/.test(d)?'':cc+d;
  if(cc==='91'&&d.startsWith('91')&&d.length===12&&!/^91[6-9]/.test(d))return'';
  return/^[1-9]\d{10,14}$/.test(d)?d:'';
}

/* A reminder with params becomes a template message (params are the body text params, in order); anything else is plain text. */
export function buildWaPayload(msg,{template='appointment_reminder',lang='en'}={}){
  const to=toWaNumber(msg?.to_addr??msg?.to);
  const params=msg?.data?.params;
  if(msg?.data?.template==='reminder'&&Array.isArray(params)&&params.length)
    return{messaging_product:'whatsapp',to,type:'template',template:{name:template,language:{code:lang},
      components:[{type:'body',parameters:params.map(p=>({type:'text',text:String(p??'').slice(0,1024)}))}]}};
  return{messaging_product:'whatsapp',to,type:'text',text:{preview_url:false,body:String(msg?.body??'').slice(0,4096)}};
}

/* cfg: {phoneNumberId, accessToken, template, lang, fetchImpl}. Returns {ok:true,id} or {ok:false,error}; never throws. */
export async function sendWhatsApp(cfg,msg){
  try{
    if(!cfg?.phoneNumberId||!cfg?.accessToken)return{ok:false,error:'WhatsApp is not configured'};
    const payload=buildWaPayload(msg,{template:cfg.template,lang:cfg.lang});
    if(!payload.to)return{ok:false,error:'Invalid phone number'};
    const r=await(cfg.fetchImpl??fetch)(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.phoneNumberId)}/messages`,{
      method:'POST',signal:AbortSignal.timeout(10000),
      headers:{Authorization:'Bearer '+cfg.accessToken,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json().catch(()=>({}));
    if(r.ok&&j?.messages?.[0]?.id)return{ok:true,id:String(j.messages[0].id)};
    return{ok:false,error:`Provider ${r.status}: ${String(j?.error?.message??'').slice(0,160)}`};
  }catch(e){return{ok:false,error:String(e?.name==='TimeoutError'?'Timed out':e?.message??e).slice(0,200)}}
}
