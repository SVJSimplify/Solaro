/* Plain-language label for why a chat needs a human. Used by the inbox and alerts. */
export const REASON={emergency:'Emergency: call the customer now',health_risk:'Health concern: call back',asked_for_person:'Customer asked for a person',upset:'Customer is upset',unsure:'Solara was unsure',error:'Solara failed to answer',other:'Needs a reply'};

/* Latest phone number a customer typed in this chat (form answers included), or null. */
const PHONE=/\+?\d[\d\s().-]{7,}\d/;
export const phoneOf=messages=>{
  for(const m of [...messages].reverse()){
    if(m.r!=='cust')continue;
    const hit=m.t?.match(PHONE);
    if(hit)return hit[0].replace(/\s+/g,' ').trim();
  }
  return null;
};
