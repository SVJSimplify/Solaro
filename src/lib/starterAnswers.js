/* Built-in answers for a business that hasn't written its own yet. Hours, prices, insurance and the
   cancellation policy are SAMPLE values: they are marked starter, shown as "sample, check it" in
   Knowledge, and must be replaced with the business's real details before going live. */
export const STARTER_ANSWERS=[
  {title:'Hours',body:'Monday to Friday 8am to 6pm, Saturday 9am to 2pm. Closed Sunday.',keywords:'hours open close when opening times'},
  {title:'Pricing',body:'A routine cleaning is $120 without insurance. Exams and X-rays are quoted at your visit.',keywords:'price cost how much fee charge'},
  {title:'Insurance',body:'We accept Cigna, Aetna, Delta Dental and most major plans. Share your member ID and we will verify coverage.',keywords:'insurance cover plan accepted coverage'},
  {title:'Cancellation policy',body:'Please give at least 24 hours notice to cancel or reschedule an appointment.',keywords:'cancel policy notice late fee'},
  {title:'Booking',body:'You can book by sharing your name, phone number, the service you need and a preferred date and time. Our team will confirm your appointment.',keywords:'book appointment schedule visit reserve'},
  {title:'Reschedule or cancel',body:'To change or cancel an appointment, tell us your name and the original date and time. Our team will confirm the change.',keywords:'reschedule cancel change move appointment'},
  {title:'Contact',body:'Our team will call you back on the number you give us as soon as possible.',keywords:'call phone contact reach speak talk'},
  {title:'What to bring',body:'Please bring photo ID and any insurance card or member ID you have.',keywords:'bring documents id insurance card paperwork'},
  {title:'Arriving',body:'Please arrive about 10 minutes before your appointment to check in.',keywords:'arrive early late on time check in'},
  {title:'Emergency',body:'If you have severe pain, heavy bleeding, trouble breathing or swelling, call your local emergency number now. We will also flag your message for our team.',keywords:'emergency pain bleeding swelling urgent breathing'}
];

/* Adds any starter the business doesn't already have (matched by topic). Returns how many were added. */
export async function addStarterAnswers(db,uid,existing){
  const have=new Set(existing.map(x=>x.title.toLowerCase()));
  let n=0;
  for(const a of STARTER_ANSWERS){
    if(have.has(a.title.toLowerCase()))continue;
    await db.add('kb',uid,{...a,starter:true});n++;
  }
  return n;
}
