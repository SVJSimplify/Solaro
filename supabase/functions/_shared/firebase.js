/* Firebase from Edge Functions, without the Admin SDK:
   • sendPush: Firebase Cloud Messaging HTTP v1, authorised with the service account (OAuth token cached ~1 hour).
   • verifyIdToken: checks a Firebase Auth ID token (from phone sign-in in the app) against Google's public keys.
   Secrets: FIREBASE_SERVICE_ACCOUNT (the service account JSON) and FIREBASE_PROJECT_ID. */

const enc=s=>new TextEncoder().encode(s);
export const b64url=buf=>{const b=typeof buf==='string'?enc(buf):new Uint8Array(buf);let s='';for(const x of b)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
const fromB64url=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0));
const pemToDer=pem=>Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,'')),c=>c.charCodeAt(0));

/* ── Push ─────────────────────────────────────────────────────────────────── */
let cached={key:'',token:'',exp:0};
export async function accessToken(sa,{fetchImpl=fetch,now=Date.now}={}){
  if(cached.key===sa.client_email&&cached.token&&now()<cached.exp-60e3)return cached.token;
  const t=Math.floor(now()/1000);
  const unsigned=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}))+'.'+b64url(JSON.stringify({
    iss:sa.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:t,exp:t+3600}));
  const key=await crypto.subtle.importKey('pkcs8',pemToDer(sa.private_key),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const jwt=unsigned+'.'+b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc(unsigned)));
  const r=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(10000),
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.access_token)throw new Error('Firebase auth failed: '+r.status);
  cached={key:sa.client_email,token:j.access_token,exp:now()+(Number(j.expires_in)||3600)*1000};
  return cached.token;
}

/* One notification to one device. gone=true means the device uninstalled the app or the token expired. */
export async function sendPush(sa,{token,title,body,data={}},{fetchImpl=fetch}={}){
  const at=await accessToken(sa,{fetchImpl});
  const strData=Object.fromEntries(Object.entries(data).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]));
  const r=await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,{method:'POST',signal:AbortSignal.timeout(10000),
    headers:{Authorization:'Bearer '+at,'Content-Type':'application/json'},
    body:JSON.stringify({message:{token,notification:{title,body},data:strData,
      android:{priority:'HIGH',notification:{channel_id:data.audience==='staff'?'solara-staff':'solara-patient',default_sound:true}}}})});
  if(r.ok){const j=await r.json().catch(()=>({}));return{ok:true,id:String(j.name??'')}}
  const j=await r.json().catch(()=>({}));
  const status=j?.error?.status??'',detail=(j?.error?.details??[]).map(d=>d.errorCode).join(',');
  const gone=r.status===404||status==='NOT_FOUND'||/UNREGISTERED/.test(detail)||(r.status===400&&/registration token/i.test(j?.error?.message??''));
  return{ok:false,gone,error:`FCM ${r.status} ${status} ${detail}`.trim().slice(0,200)};
}

/* ── ID tokens ────────────────────────────────────────────────────────────── */
const JWKS_URL='https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks={keys:null,exp:0};
async function googleKeys(fetchImpl){
  if(jwks.keys&&Date.now()<jwks.exp)return jwks.keys;
  const r=await fetchImpl(JWKS_URL,{signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error('Could not load Google keys');
  const age=Number((r.headers.get('cache-control')||'').match(/max-age=(\d+)/)?.[1]||3600);
  jwks={keys:(await r.json()).keys,exp:Date.now()+Math.min(age,21600)*1000};
  return jwks.keys;
}

/* Returns {uid, phone} for a valid Firebase ID token from a phone sign-in, or throws. */
export async function verifyIdToken(idToken,projectId,{fetchImpl=fetch,now=()=>Date.now(),keys}={}){
  if(!projectId)throw new Error('Firebase is not configured');
  const parts=String(idToken||'').split('.');
  if(parts.length!==3)throw new Error('Malformed token');
  const [h,p,s]=parts,header=JSON.parse(new TextDecoder().decode(fromB64url(h))),claims=JSON.parse(new TextDecoder().decode(fromB64url(p)));
  if(header.alg!=='RS256'||!header.kid)throw new Error('Unexpected token type');
  const jwk=(keys??await googleKeys(fetchImpl)).find(k=>k.kid===header.kid);
  if(!jwk)throw new Error('Unknown signing key');
  const key=await crypto.subtle.importKey('jwk',{kty:jwk.kty,n:jwk.n,e:jwk.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,fromB64url(s),enc(h+'.'+p)))throw new Error('Bad signature');
  const t=Math.floor(now()/1000);
  if(claims.aud!==projectId||claims.iss!==`https://securetoken.google.com/${projectId}`)throw new Error('Token is for another project');
  if(!(claims.exp>t)||!(claims.iat<=t+60)||!(claims.auth_time<=t+60))throw new Error('Token expired');
  if(!claims.sub)throw new Error('No user');
  if(!claims.phone_number)throw new Error('Not a phone sign-in');
  return{uid:claims.sub,phone:claims.phone_number};
}
