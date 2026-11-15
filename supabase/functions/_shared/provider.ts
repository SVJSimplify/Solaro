// The clinic's model connection and daily limit, shared by every function that calls the model.
// Each clinic can have its own OpenAI-compatible endpoint, model and key (set in Admin).
//  • Clinic endpoint set  → the clinic's own key and model are required. The server's key is never sent there.
//  • No clinic endpoint   → the server's LLM_BASE_URL, with the clinic's own key if it has one, else LLM_API_KEY.
export async function orgProvider(svc:any, orgId:string){
  const {data:org,error:oErr}=await svc.from('organizations').select('model,model_endpoint').eq('id',orgId).single();
  if(oErr||!org)return{error:'Could not load the clinic AI settings',status:500};
  const {data:own,error:kErr}=await svc.rpc('get_model_key',{org:orgId});
  if(kErr)return{error:'Could not load the clinic AI key',status:500};

  const clinicEndpoint=(org.model_endpoint||'').trim(),serverEndpoint=Deno.env.get('LLM_BASE_URL')??'';
  const endpoint=clinicEndpoint||serverEndpoint;
  if(!endpoint)return{error:'AI is not configured on the server',status:503};
  const key=clinicEndpoint?(own||''):(own||Deno.env.get('LLM_API_KEY')||'');
  if(!key)return{error:'AI is not set up for this clinic yet',status:402};
  const model=org.model||(clinicEndpoint?'':Deno.env.get('LLM_MODEL')||'');
  if(clinicEndpoint&&!model)return{error:'AI model is not set for this clinic',status:402};

  const {data:allowed,error:aErr}=await svc.rpc('consume_ai_call',{org:orgId});
  if(aErr)return{error:'Could not check the AI limit',status:500};
  if(!allowed)return{error:'Daily AI limit reached for this clinic. It resets tomorrow.',status:429};

  // Optional second provider, tried when the first keeps failing. Only for clinics on the server's provider,
  // so a clinic with its own provider is never silently moved onto (and billed to) the platform's account.
  const fb=Deno.env.get('LLM_FALLBACK_BASE_URL'),fbKey=Deno.env.get('LLM_FALLBACK_API_KEY');
  const fallback=!clinicEndpoint&&fb&&fbKey?{endpoint:fb,key:fbKey,model:Deno.env.get('LLM_FALLBACK_MODEL')||''}:undefined;
  return{provider:{endpoint,key,model,fallback}};
}
