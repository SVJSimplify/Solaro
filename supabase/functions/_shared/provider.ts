// The clinic's model connection and daily limit, shared by every function that calls the model.
export async function orgProvider(svc:any, orgId:string){
  const endpoint=Deno.env.get('LLM_BASE_URL')??'';
  if(!endpoint)return{error:'AI is not configured on the server',status:503};
  const {data:key,error:kErr}=await svc.rpc('get_model_key',{org:orgId});
  if(kErr)return{error:'Could not load the clinic AI key',status:500};
  if(!key)return{error:'AI is not set up for this clinic yet',status:402};
  const {data:allowed,error:aErr}=await svc.rpc('consume_ai_call',{org:orgId});
  if(aErr)return{error:'Could not check the AI limit',status:500};
  if(!allowed)return{error:'Daily AI limit reached for this clinic. It resets tomorrow.',status:429};
  const {data:org}=await svc.from('organizations').select('model').eq('id',orgId).single();
  return{provider:{endpoint,key,model:org?.model||Deno.env.get('LLM_MODEL')||''}};
}
