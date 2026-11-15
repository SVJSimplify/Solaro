/* Browser access to the Edge Functions. Only Solara's own app origins get CORS; everything else is refused by the browser.
   (CORS is not authentication: every function still checks its JWT or chat token.) Extra origins, e.g. a custom domain,
   come from the ALLOWED_ORIGINS secret as a comma-separated list. */
const DEFAULT_ORIGINS=['https://solaro-six.vercel.app','http://localhost:5173','http://localhost:4173'];
// Vercel preview deployments of this project only (team slug pins them to our account).
const PREVIEW=/^https:\/\/solaro-(?:[a-z0-9]+|git-[a-z0-9-]+)-amu-a674\.vercel\.app$/;

export function originAllowed(origin,extra=(globalThis.Deno?.env.get('ALLOWED_ORIGINS')??'')){
  if(!origin)return false;
  const list=extra.split(',').map(s=>s.trim().replace(/\/$/,'')).filter(Boolean);
  return DEFAULT_ORIGINS.includes(origin)||list.includes(origin)||PREVIEW.test(origin);
}

const BASE={'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS',
  'Access-Control-Max-Age':'600','Vary':'Origin','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'};

/* Wraps a handler: answers preflight, and sets the CORS and safety headers on every response it returns. */
export function withCors(handler){
  return async req=>{
    const origin=req.headers.get('origin'),ok=originAllowed(origin);
    const h={...BASE,...(ok?{'Access-Control-Allow-Origin':origin}:{})};
    if(req.method==='OPTIONS')return new Response(null,{status:ok?204:403,headers:h});
    const res=await handler(req);
    res.headers.delete('Access-Control-Allow-Origin');
    for(const [k,v] of Object.entries(h))res.headers.set(k,v);
    return res;
  };
}

/* The caller's IP as seen by Supabase's edge (Cloudflare sets cf-connecting-ip and overwrites client values). */
export const clientIp=req=>req.headers.get('cf-connecting-ip')?.trim()||req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
