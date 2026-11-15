/* Team invites arrive as /join?token=…. The token is kept until the person has signed in (it survives the email
   confirmation tab and a password reset), then accepted once. Only the invite's hash is stored on the server. */
const KEY='solara.join',ERR='solara.joinError',TTL=7*864e5;
const ls={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},del:k=>{try{localStorage.removeItem(k)}catch{}}};

export function captureJoin(){
  if(typeof window==='undefined'||location.pathname!=='/join')return;
  const token=new URLSearchParams(location.search).get('token');
  if(token&&/^[0-9a-f]{64}$/.test(token))ls.set(KEY,JSON.stringify({token,at:Date.now()}));
  history.replaceState(null,'','/');
}
export function pendingJoin(){
  try{const j=JSON.parse(ls.get(KEY)||'null');if(j&&Date.now()-j.at<TTL)return j.token}catch{}
  ls.del(KEY);return null;
}
export const clearJoin=()=>ls.del(KEY);
export const setJoinError=m=>ls.set(ERR,m);
export function takeJoinError(){const m=ls.get(ERR);ls.del(ERR);return m}
