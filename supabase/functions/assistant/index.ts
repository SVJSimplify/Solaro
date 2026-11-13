// Retired. This legacy front-desk path bypassed the central tool registry, the per-clinic model key and the daily AI limit,
// and read knowledge without an organisation filter. The app uses staff-agent (staff) and widget-chat (public) instead.
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type'};
Deno.serve(req=>req.method==='OPTIONS'?new Response('ok',{headers:cors}):
  new Response(JSON.stringify({error:'This endpoint has been retired.'}),{status:410,headers:{...cors,'Content-Type':'application/json'}}));
