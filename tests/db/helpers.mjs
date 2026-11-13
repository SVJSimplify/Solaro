// Test helpers for the local Postgres that mirrors Supabase (see tests/README). Connection comes from TEST_DATABASE_URL.
import pg from 'pg';

export const DB_URL=process.env.TEST_DATABASE_URL;
export function connect(){
  if(!DB_URL)throw new Error('TEST_DATABASE_URL is not set. Point it at a disposable Postgres with the migrations applied.');
  const c=new pg.Client({connectionString:DB_URL});
  return c.connect().then(()=>c);
}

/* Runs fn inside a transaction that is always rolled back, as the given user (authenticated) or as the server (service_role). */
export async function asUser(c, {uid,role='authenticated'}, fn){
  await c.query('begin');
  try{
    if(role==='authenticated'){
      await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,role:'authenticated'})]);
      await c.query('set local role authenticated');
    }else if(role==='anon'){
      await c.query("select set_config('request.jwt.claims','{}',true)");
      await c.query('set local role anon');
    }else{
      await c.query('set local role service_role');
    }
    return await fn(c);
  }finally{
    await c.query('rollback');
  }
}

/* Expects a Postgres error. A savepoint isolates the failure so later checks in the same transaction still run. */
export async function expectPgError(c, fn, {code,includes}={}){
  await c.query('savepoint expect_err');
  try{await fn()}catch(e){
    await c.query('rollback to savepoint expect_err');
    if(code&&e.code!==code)throw new Error(`expected SQLSTATE ${code}, got ${e.code}: ${e.message}`);
    if(includes&&!String(e.message).includes(includes))throw new Error(`expected message to include "${includes}", got: ${e.message}`);
    return e;
  }
  await c.query('release savepoint expect_err');
  throw new Error('expected an error, but the statement succeeded');
}
