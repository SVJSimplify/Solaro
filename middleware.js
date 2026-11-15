/* Vercel Routing Middleware for the patient chat page (/widget).
   Browsers only let a page show the chat in an iframe if that page's origin is on the clinic's allowed list
   (Website chat → Allowed websites). Everything else in the app is never framable (see vercel.json). */
import {next} from '@vercel/functions';

export const config={matcher:'/widget'};

// Public values: the same project URL and publishable key ship in embed.js.
const SUPABASE_URL=process.env.VITE_SUPABASE_URL||'https://wqhxpfzbvtkdwzehddjr.supabase.co';
const ANON=process.env.VITE_SUPABASE_ANON_KEY||'sb_publishable_mgqlYnRfwa91pfm52GRsNw_HVFu0wUP';
const KEY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN=/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?$/;
const TTL=60e3,cache=new Map();

async function allowedOrigins(key){
  const hit=cache.get(key);
  if(hit&&hit.at>Date.now()-TTL)return hit.list;
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),2500);
  try{
    const r=await fetch(SUPABASE_URL+'/rest/v1/rpc/widget_frame_origins',{method:'POST',signal:ctl.signal,
      headers:{apikey:ANON,Authorization:'Bearer '+ANON,'Content-Type':'application/json'},body:JSON.stringify({key})});
    const list=r.ok?((await r.json())||[]).filter(o=>typeof o==='string'&&ORIGIN.test(o)):[];
    if(cache.size>500)cache.clear();
    cache.set(key,{at:Date.now(),list});
    return list;
  }catch{return[]}   // fail closed: the chat still opens directly, but no other site can frame it
  finally{clearTimeout(t)}
}

export default async function middleware(request){
  const key=new URL(request.url).searchParams.get('key')||'';
  const sites=KEY.test(key)?await allowedOrigins(key):[];
  const ancestors=["'self'",...sites].join(' ');
  return next({headers:{
    'Content-Security-Policy':[
      "default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:","img-src 'self' data:",
      `connect-src 'self' ${SUPABASE_URL}`,"object-src 'none'","base-uri 'self'","form-action 'self'",
      `frame-ancestors ${ancestors}`].join('; '),
    'Referrer-Policy':'strict-origin-when-cross-origin',
    'Cache-Control':'private, no-store',
  }});
}
