import {buildMessages,triage,metaOf,FALLBACK,customerWords} from '../../supabase/functions/_shared/agent.js';
import {respondAgent} from './frontAgent';
import {queue} from './outbox';
import {audit} from './audit';
import {devProviders} from './llm';

/* One assistant turn on any db adapter (local or Supabase). The model call runs in this browser
   through the llm-proxy edge function. The model key stays on the server. */
export async function respondWith(store,id,uid){
  const [kb,cfg,convos,me]=await Promise.all([store.list('kb',uid),store.settings(uid),store.list('convos',uid),store.session()]);
  const cur=convos.find(x=>x.id===id);
  // Once a chat is with the team (or ended), Solara does not reply in it again.
  if(!cur||cur.status==='handoff'||cur.status==='closed')return;
  const messages=buildMessages(cur.messages.map(m=>({role:m.r,body:m.t})));
  const providers=devProviders();
  // Emergencies never go through the model.
  const t=triage(buildMessages(cur.messages.map(m=>({role:m.r,body:m.r==='cust'?customerWords(m):m.t}))));
  let res;
  if(t)res={reply:t.reply,handoff:true,reason:t.reason,form:null,urgent:t.urgent};
  else if(!providers.length)throw Error('AI is not connected. Connect Solara to its server first.');
  else{
    const org=me?.biz||'this business';
    res=await respondAgent({provider:providers[0],local:store,uid,me,convo:cur,settings:cfg,org,now:new Date(Date.now()-new Date().getTimezoneOffset()*6e4).toISOString().slice(0,16).replace('T',' ')});
  }
  await new Promise(r=>setTimeout(r,800));
  const latest=(await store.list('convos',uid)).find(x=>x.id===id);
  const handoff=!!res.handoff;
  await store.patch('convos',id,{messages:[...latest.messages,{r:'bot',t:res.reply,at:Date.now(),meta:metaOf({form:res.form,handoff,reason:res.reason,urgent:res.urgent})}],status:handoff?'handoff':latest.status});
  if(handoff&&!latest.alerted){
    await store.add('alerts',uid,{convo:id,customer:latest.customer,reason:res.reason||'other',text:latest.messages.at(-1)?.t?.slice(0,160)||'',read:false});
    if(cfg.handoff)await queue(store,uid,{channel:'sms',to:cfg.handoff,body:`Solara needs you: ${latest.customer} (${res.reason||'other'}).`});
    await audit(store,uid,'handoff',`${latest.customer}: ${res.reason||'other'}`);
  }
  if(handoff)await store.patch('convos',id,{alerted:true});
  // Say what actually went wrong, so a missing server setting is not mistaken for a bug in the chat.
  if(res.reply===FALLBACK)throw Error(/not configured/i.test(res.error||'')
    ?'Solara’s AI is not connected yet. In Supabase open Edge Functions → Secrets and add LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.'
    :res.error||'The model did not answer. Check the llm-proxy function logs in Supabase.');
}
