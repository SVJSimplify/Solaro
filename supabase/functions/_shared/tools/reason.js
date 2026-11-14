/* A cancellation reason must say something: a few real words, not "no", "idk" or a placeholder. */
const JUNK=/^(no|nothing|none|na|n\/a|idk|dunno|ok|okay|yes|cancel|cancelled|because|just|reason|whatever|nope|test|asdf|\.+|-+)$/i;
export const reasonProblem=r=>{
  const t=String(r??'').trim().replace(/\s+/g,' ');
  if(!t)return 'Please tell us why you are cancelling.';
  if(t.length<8||JUNK.test(t)||(t.match(/[\p{L}]{2,}/gu)||[]).length<2)return 'Please give a short real reason, for example "I have a work trip that day".';
  return null;
};
