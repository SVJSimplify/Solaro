// Retired. This legacy front-desk path bypassed the central tool registry, the per-clinic model key and the daily AI limit,
// and read knowledge without an organisation filter. The app uses staff-agent (staff) and widget-chat (public) instead.
import {withCors} from '../_shared/http.js';
Deno.serve(withCors(async()=>new Response(JSON.stringify({error:'This endpoint has been retired.'}),{status:410,headers:{'Content-Type':'application/json'}})));
