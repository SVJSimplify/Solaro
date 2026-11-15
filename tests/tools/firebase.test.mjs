import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendPush,verifyIdToken,b64url,accessToken} from '../../supabase/functions/_shared/firebase.js';

const kp=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const pkcs8=Buffer.from(await crypto.subtle.exportKey('pkcs8',kp.privateKey)).toString('base64');
const SA={client_email:'svc@demo.iam.gserviceaccount.com',project_id:'solara-demo',private_key:`-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`};
const pubJwk={...await crypto.subtle.exportKey('jwk',kp.publicKey),kid:'k1'};
const sign=async claims=>{
  const u=b64url(JSON.stringify({alg:'RS256',kid:'k1',typ:'JWT'}))+'.'+b64url(JSON.stringify(claims));
  return u+'.'+b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',kp.privateKey,new TextEncoder().encode(u)));
};
const now=Math.floor(Date.now()/1000);
const good={aud:'solara-demo',iss:'https://securetoken.google.com/solara-demo',sub:'uid1',iat:now-10,auth_time:now-10,exp:now+3000,phone_number:'+919876543210'};

test('F1 a valid phone sign-in token gives the verified number',async()=>{
  assert.deepEqual(await verifyIdToken(await sign(good),'solara-demo',{keys:[pubJwk]}),{uid:'uid1',phone:'+919876543210'});
});
test('F2 tokens for another project, expired, without a phone, or tampered are refused',async()=>{
  const bad=async(c,msg)=>assert.rejects(verifyIdToken(await sign(c),'solara-demo',{keys:[pubJwk]}),msg);
  await bad({...good,aud:'other'},/another project/);
  await bad({...good,iss:'https://securetoken.google.com/other'},/another project/);
  await bad({...good,exp:now-1},/expired/);
  const {phone_number,...noPhone}=good;await bad(noPhone,/phone/);
  const t=await sign(good),[h,,s]=t.split('.');
  await assert.rejects(verifyIdToken(h+'.'+b64url(JSON.stringify({...good,phone_number:'+15555550100'}))+'.'+s,'solara-demo',{keys:[pubJwk]}),/signature/);
  await assert.rejects(verifyIdToken('nope','solara-demo',{keys:[pubJwk]}),/Malformed/);
});

test('F3 push: signs a service-account JWT Google can verify, sends to FCM v1, and flags uninstalled devices',async()=>{
  const calls=[];
  const fetchImpl=async(url,opts)=>{calls.push({url,opts});
    if(url.includes('oauth2')){
      const jwt=new URLSearchParams(opts.body).get('assertion'),[h,p,s]=jwt.split('.');
      const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',kp.publicKey,Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0)),new TextEncoder().encode(h+'.'+p));
      const c=JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/')));
      assert.ok(ok);assert.equal(c.iss,SA.client_email);assert.match(c.scope,/firebase.messaging/);
      return new Response(JSON.stringify({access_token:'at-1',expires_in:3600}));
    }
    const b=JSON.parse(opts.body);
    if(b.message.token==='gone')return new Response(JSON.stringify({error:{status:'NOT_FOUND',details:[{errorCode:'UNREGISTERED'}]}}),{status:404});
    return new Response(JSON.stringify({name:'projects/solara-demo/messages/1'}));
  };
  const r=await sendPush(SA,{token:'tok',title:'A chat needs a person',body:'Ravi is waiting',data:{link:'/inbox',audience:'staff',org:'o1'}},{fetchImpl});
  assert.deepEqual(r,{ok:true,id:'projects/solara-demo/messages/1'});
  const msg=JSON.parse(calls.at(-1).opts.body).message;
  assert.equal(calls.at(-1).url,'https://fcm.googleapis.com/v1/projects/solara-demo/messages:send');
  assert.equal(msg.android.notification.channel_id,'solara-staff');assert.equal(msg.data.link,'/inbox');
  const g=await sendPush(SA,{token:'gone',title:'t',body:'b'},{fetchImpl});
  assert.equal(g.ok,false);assert.equal(g.gone,true);
  assert.equal(calls.filter(c=>c.url.includes('oauth2')).length,1);   // the access token is reused
});
