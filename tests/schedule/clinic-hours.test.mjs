// Clinic hours by weekday bound every doctor's open times; passed times are never offered.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {slotsFor,hoursOn,withClinic,assignDoctor} from '../../supabase/functions/_shared/tools/schedule.js';
import {openSlots,clinicNow} from '../../src/lib/avail.js';

const doc={id:'d1',name:'Dr. A',days:[1,2,3,4,5,6],start:'08:00',end:'20:00',slot:30,services:['Exam']};
const hours={1:{start:'13:00',end:'22:00'},6:{start:'14:00',end:'18:00'}};   // Mon 1-10pm, Sat 2-6pm, else closed
const [d]=withClinic([doc],hours);
const MON='2026-11-16',SAT='2026-11-14',TUE='2026-11-17';

test('a doctor works only inside the clinic hours of that weekday',()=>{
  assert.deepEqual(hoursOn(d,MON),{start:13*60,end:20*60});
  assert.equal(slotsFor(d,MON)[0],MON+'T13:00');
  assert.equal(slotsFor(d,MON).at(-1),MON+'T19:30');
  assert.equal(slotsFor(d,SAT)[0],SAT+'T14:00');
  assert.equal(slotsFor(d,SAT).at(-1),SAT+'T17:30');
});
test('a day the clinic is closed has no slots, even if the doctor works',()=>assert.deepEqual(slotsFor(d,TUE),[]));
test('without clinic hours the doctor\'s own hours apply',()=>assert.equal(slotsFor(doc,TUE)[0],TUE+'T08:00'));
test('booking routing refuses a time outside clinic hours',()=>{
  assert.equal(assignDoctor([d],[],MON+'T10:00','Exam'),null);
  assert.equal(assignDoctor([d],[],MON+'T13:00','Exam')?.id,'d1');
});
test('times that have passed in clinic time are not offered',()=>{
  const now=SAT+'T15:16';
  const left=openSlots([d],SAT,[],[],[],{now}).map(s=>s.when.slice(11));
  assert.deepEqual(left,['15:30','16:00','16:30','17:00','17:30']);
});
test('clinic time is the clinic\'s zone, not the browser\'s',()=>{
  const at=new Date('2026-11-14T14:16:00Z');
  assert.equal(clinicNow('Asia/Kolkata',at),'2026-11-14T19:46');
  assert.equal(clinicNow('America/New_York',at),'2026-11-14T09:16');
});
