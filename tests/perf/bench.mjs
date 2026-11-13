// Production-scale benchmark. Seeds a disposable database with many clinics and a large one, then times the queries the
// app and Edge Functions actually run, as a signed-in clinic member (row-level security on). Never point this at production.
// Usage: TEST_DATABASE_URL=... node tests/perf/bench.mjs [--seed] [--label before]
import pg from 'pg';
const url=process.env.TEST_DATABASE_URL;if(!url)throw new Error('TEST_DATABASE_URL is not set');
const c=new pg.Client({connectionString:url});await c.connect();
const q=(s,p)=>c.query(s,p).then(r=>r.rows);
const BIG='aaaaaaaa-0000-4000-8000-00000000b16b',OWNER='bbbbbbbb-0000-4000-8000-00000000b16b';
const label=process.argv.includes('--label')?process.argv[process.argv.indexOf('--label')+1]:'run';

if(process.argv.includes('--seed')){
  const t=Date.now();
  await q(`insert into auth.users(id,email) values($1,'big@bench.test') on conflict do nothing`,[OWNER]);
  // 1 large clinic (20k chats, 200k messages, 60k bookings over 3 years) + 9 smaller ones (2k chats, 20k messages, 6k bookings each).
  const orgs=[[BIG,20000,10,60000],...Array.from({length:9},(_,i)=>[`aaaaaaaa-0000-4000-8000-0000000000${String(i+10)}`,2000,10,6000])];
  for(const [id,convos,per,books] of orgs){
    await q(`insert into organizations(id,name) values($1::uuid,'Bench '||left($1::text,8)) on conflict do nothing`,[id]);
    await q(`insert into conversations(org_id,customer,channel,status,created_at)
      select $1,'Patient '||g,'Web chat',case when g%9=0 then 'handoff' else 'handled' end,now()-(g||' minutes')::interval from generate_series(1,$2) g`,[id,convos]);
    await q(`insert into messages(org_id,conversation_id,role,body,created_at)
      select c.org_id,c.id,case when k%2=0 then 'cust' else 'bot' end,'message '||k,c.created_at+(k||' seconds')::interval
      from conversations c, generate_series(1,$2) k where c.org_id=$1`,[id,per]);
    await q(`insert into doctors(org_id,name,days,start_time,end_time) select $1,'Dr '||d,'{1,2,3,4,5}','08:00','17:00' from generate_series(1,4) d`,[id]);
    // 30-minute slots, spread over 3 years back and 60 days ahead; unique per doctor and time.
    await q(`insert into bookings(org_id,name,phone,service,starts_at,doctor_id,doctor,status,source)
      select $1,'Patient '||g,'+1415555'||lpad((g%10000)::text,4,'0'),'Cleaning',
        date_trunc('hour',now())+((g-$2*0.95)::int*30||' minutes')::interval,
        (select id from doctors where org_id=$1 order by name offset (g%4) limit 1),'Dr',case when g%7=0 then 'cancelled' else 'booked' end,'staff'
      from generate_series(1,$2) g on conflict do nothing`,[id,books]);
    await q(`insert into alerts(org_id,convo,customer,reason,text) select $1,null,'p','unsure','x' from generate_series(1,$2/20) g`,[id,convos]);
  }
  await q(`insert into members(org_id,user_id,role) values($1,$2,'owner') on conflict do nothing`,[BIG,OWNER]);
  await q('analyze');
  console.log(JSON.stringify({seeded_ms:Date.now()-t}));
}

const counts=(await q(`select (select count(*) from conversations) convos,(select count(*) from messages) messages,(select count(*) from bookings) bookings`))[0];

/* Each query runs as the big clinic's owner with RLS on. Median of 7 runs after 1 warm-up. */
async function time(name,sql,params=[]){
  const runs=[];
  for(let i=0;i<8;i++){
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({sub:OWNER,role:'authenticated'})]);
    await c.query('set local role authenticated');
    const t=performance.now();const r=await c.query(sql,params);const ms=performance.now()-t;
    await c.query('rollback');
    if(i)runs.push({ms,rows:r.rowCount});
  }
  runs.sort((a,b)=>a.ms-b.ms);
  return{name,median_ms:+runs[3].ms.toFixed(1),rows:runs[3].rows};
}
// The same shapes PostgREST produces for the app's calls (an embedded messages array per conversation, etc.).
const INBOX=`select c.*, coalesce((select json_agg(json_build_object('role',m.role,'body',m.body,'created_at',m.created_at)) from messages m where m.conversation_id=c.id),'[]') messages from conversations c`;
const results=[
  await time('inbox: all chats with all messages (old app query)',INBOX+` order by c.created_at desc`),
  await time('inbox: latest 200 chats (new app query)',INBOX+` order by c.created_at desc limit 200`),
  await time('bookings: entire history (old app query)',`select * from bookings order by created_at`),
  await time('bookings: last 180 days onward (new app query)',`select * from bookings where starts_at>=now()-interval '180 days' order by created_at`),
  await time('availability: all bookings for the clinic (old tool load)',`select * from bookings where org_id=$1 order by starts_at`,[BIG]),
  await time('availability: bookings from today (intermediate)',`select * from bookings where org_id=$1 and starts_at>=current_date order by starts_at`,[BIG]),
  await time('availability: the requested day only (new tool load)',`select * from bookings where org_id=$1 and starts_at>=current_date+1 and starts_at<current_date+2 order by starts_at`,[BIG]),
  await time('widget poll: one chat since a time',`select role,body,created_at from messages where org_id=$1 and conversation_id=(select id from conversations where org_id=$1 order by created_at desc limit 1) and created_at>now()-interval '1 day' order by created_at`,[BIG]),
  await time('alerts: list',`select * from alerts order by created_at desc limit 500`),
  await time('self-service: bookings on one phone',`select id from bookings where org_id=$1 and phone='+14155550042' and status<>'cancelled' and starts_at>=current_date`,[BIG]),
];
/* Concurrency: many staff screens and website chats at once. 400 queries, 25 in flight, each as the clinic owner. */
async function load(name,sql,params=[],total=400,conc=25){
  const pool=new pg.Pool({connectionString:url,max:conc});const lat=[];let next=0;const t0=performance.now();
  await Promise.all(Array.from({length:conc},async()=>{
    const cl=await pool.connect();
    try{while(next<total){next++;
      await cl.query('begin');await cl.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({sub:OWNER,role:'authenticated'})]);await cl.query('set local role authenticated');
      const t=performance.now();await cl.query(sql,params);lat.push(performance.now()-t);await cl.query('rollback')}}
    finally{cl.release()}
  }));
  const secs=(performance.now()-t0)/1000;await pool.end();lat.sort((a,b)=>a-b);
  return{name,queries:total,concurrency:conc,per_second:+(total/secs).toFixed(0),p50_ms:+lat[Math.floor(lat.length*.5)].toFixed(1),p95_ms:+lat[Math.floor(lat.length*.95)].toFixed(1)};
}
const concurrency=[
  await load('availability: whole history (old tool load)',`select * from bookings where org_id=$1 order by starts_at`,[BIG],100,25),
  await load('availability: requested day (new tool load)',`select * from bookings where org_id=$1 and starts_at>=current_date+1 and starts_at<current_date+2 order by starts_at`,[BIG],2000,25),
  await load('inbox (new bounded query)',INBOX+` order by c.created_at desc limit 200`,[],200,10),
  await load('widget poll',`select role,body,created_at from messages where org_id=$1 and conversation_id=(select id from conversations where org_id=$1 order by created_at desc limit 1) and created_at>now()-interval '1 day' order by created_at`,[BIG],2000,25),
];
console.log(JSON.stringify({label,counts,results,concurrency},null,1));
await c.end();
