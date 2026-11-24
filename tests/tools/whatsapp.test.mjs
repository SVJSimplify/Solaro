import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toWaNumber,buildWaPayload,sendWhatsApp} from '../../supabase/functions/_shared/whatsapp.js';

test('W1 Indian numbers become digits-only with the 91 prefix',()=>{
  assert.equal(toWaNumber('98765 43210'),'919876543210');
  assert.equal(toWaNumber('+91 98765-43210'),'919876543210');
  assert.equal(toWaNumber('09876543210'),'919876543210');
  assert.equal(toWaNumber('919876543210'),'919876543210');
  assert.equal(toWaNumber('0091 98765 43210'),'919876543210');
  assert.equal(toWaNumber('+1 415 555 0132'),'14155550132');
});
test('W2 unusable numbers give an empty string',()=>{
  for(const v of ['',null,undefined,'abc','12345','1234567890','5876543210','91 5876543210','1'.repeat(16)])assert.equal(toWaNumber(v),'',String(v));
  assert.equal(toWaNumber('4155550132','1'),'14155550132');
});
test('W3 a reminder with params is a template message',()=>{
  const p=buildWaPayload({to_addr:'98765 43210',body:'x',data:{template:'reminder',params:['Cleaning','Dr Rao','Mon, Dec 1 at 10:00 AM']}},{template:'appointment_reminder',lang:'en'});
  assert.deepEqual(p,{messaging_product:'whatsapp',to:'919876543210',type:'template',template:{name:'appointment_reminder',language:{code:'en'},
    components:[{type:'body',parameters:[{type:'text',text:'Cleaning'},{type:'text',text:'Dr Rao'},{type:'text',text:'Mon, Dec 1 at 10:00 AM'}]}]}});
});
test('W4 anything else is plain text',()=>{
  const p=buildWaPayload({to_addr:'9876543210',body:'Hello',data:{}});
  assert.deepEqual(p,{messaging_product:'whatsapp',to:'919876543210',type:'text',text:{preview_url:false,body:'Hello'}});
  assert.equal(buildWaPayload({to_addr:'9876543210',body:'Hi',data:{template:'reminder',params:[]}}).type,'text');
});
test('W5 sendWhatsApp returns the message id and sends a Bearer request',async()=>{
  let seen;
  const fetchImpl=async(u,o)=>{seen={u,o};return{ok:true,status:200,json:async()=>({messages:[{id:'wamid.1'}]})}};
  const r=await sendWhatsApp({phoneNumberId:'123',accessToken:'tok',fetchImpl},{to_addr:'9876543210',body:'Hi',data:{}});
  assert.deepEqual(r,{ok:true,id:'wamid.1'});
  assert.equal(seen.u,'https://graph.facebook.com/v21.0/123/messages');
  assert.equal(seen.o.headers.Authorization,'Bearer tok');
});
test('W6 sendWhatsApp never throws and does not echo secrets',async()=>{
  const cfg={phoneNumberId:'123',accessToken:'secret-token'};
  assert.equal((await sendWhatsApp({},{to_addr:'9876543210'})).ok,false);
  assert.equal((await sendWhatsApp(cfg,{to_addr:'nope',body:'x'})).error,'Invalid phone number');
  const bad=await sendWhatsApp({...cfg,fetchImpl:async()=>({ok:false,status:400,json:async()=>({error:{message:'Bad template'}})})},{to_addr:'9876543210',body:'x'});
  assert.deepEqual(bad,{ok:false,error:'Provider 400: Bad template'});
  const boom=await sendWhatsApp({...cfg,fetchImpl:async()=>{throw new Error('network down')}},{to_addr:'9876543210',body:'x'});
  assert.equal(boom.ok,false);assert.ok(!JSON.stringify(boom).includes('secret-token'));
  const nojson=await sendWhatsApp({...cfg,fetchImpl:async()=>({ok:false,status:502,json:async()=>{throw new Error('x')}})},{to_addr:'9876543210',body:'x'});
  assert.equal(nojson.ok,false);
});
