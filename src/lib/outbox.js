/* Outgoing messages (SMS, email). Local build records them; production sends them through a provider. */
export const queue=(db,uid,{channel,to,body})=>db.add('outbox',uid,{channel,to,body,status:'sent',at:Date.now()});

/* Sends one reminder for each booking starting within 24 hours that hasn't been reminded yet. */
export async function runReminders(db,uid){
  const now=Date.now(),bookings=await db.list('bookings',uid);
  let n=0;
  for(const b of bookings){
    if(b.status==='cancelled'||b.status==='requested'||b.reminded)continue;   // unconfirmed requests get no reminder
    const t=Date.parse(b.when+':00');
    if(!(t>now&&t-now<=24*3600e3))continue;
    // Claim first: with several staff tabs open, only the tab that wins the claim sends the reminder.
    if(!await db.claim('bookings',b.id,{reminded:false},{reminded:true}))continue;
    await queue(db,uid,{channel:'sms',to:b.phone,body:`Reminder: ${b.service||'appointment'} with ${b.doctor} at ${b.when.slice(11)} on ${b.when.slice(0,10)}.`});
    n++;
  }
  return n;
}
