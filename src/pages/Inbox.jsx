import {useState,useRef,useEffect,Fragment} from 'react';
import {db} from '../lib/db';
import {useAuth,useTable,useToast,Reveal} from '../lib/hooks';import {ago,RM,Icon,Empty,useConfirm} from '../lib/ui';
import FormCard from '../lib/FormCard';
import {REASON,phoneOf} from '../lib/reasons';
import CallPanel from '../lib/CallPanel';
import {useSearchParams} from 'react-router-dom';

/* Open conversations with a critical or urgent reply surface first. */
const isUrgent=x=>x.status==='handoff'&&x.messages.some(m=>m.meta?.urgent);
/* Plain-language reason a chat needs a human. */
/* Test chats: flagged on creation, or older ones named as test. */
const isTest=x=>!!x.test||x.customer==='Test customer';
const why=x=>REASON[[...x.messages].reverse().find(m=>m.meta?.reason)?.meta.reason]||REASON.other;

export default function Inbox(){
  const {user}=useAuth(),toast=useToast(),confirm=useConfirm(),[cv]=useTable('convos');
  const [tab,setTab]=useState('all'),[q,setQ]=useState(''),[as,setAs]=useState('patient');   // only used in test chats, where you play the patient so Solara answers (forms included); real chats always send as the team
  const [params]=useSearchParams(),[sel,setSel]=useState(params.get('c')),[callOpen,setCallOpen]=useState(false),[typing,setTyping]=useState(null),[reply,setReply]=useState('');
  const seen=useRef({}),box=useRef(null),[pending,setPending]=useState([]),opened=useRef({});
  const all=[...cv].sort((a,b)=>(Number(isUrgent(b))-Number(isUrgent(a)))||(b.created-a.created));
  const list=all.filter(x=>(tab==='all'||(tab==='open'?x.status==='handoff':tab==='closed'?x.status==='closed':x.status==='handled'))&&(!q.trim()||x.customer.toLowerCase().includes(q.trim().toLowerCase())||x.messages.some(m=>String(m.t).toLowerCase().includes(q.trim().toLowerCase()))));
  const c=list.find(x=>x.id===sel)||list[0];
  const open=cv.filter(x=>x.status==='handoff').length,bots=cv.reduce((n,x)=>n+x.messages.filter(m=>m.r==='bot').length,0);
  const base=c?seen.current[c.id]??0:0;
  if(c&&opened.current[c.id]==null)opened.current[c.id]=c.messages.length;   // replies arriving after this point are revealed smoothly
  // Optimistic messages: shown the moment they are sent, dropped once the stored copy arrives.
  const mine=c?pending.filter(p=>p.convo===c.id&&!c.messages.slice(p.from).some(m=>m.r===p.r&&m.t===p.t)):[];
  const shown=c?[...c.messages,...mine]:[];
  const lens=useRef({});if(c)lens.current[c.id]=c.messages.length;
  // Leaving a chat marks everything in it as read, so returning to it does not replay old replies.
  useEffect(()=>{const id=c?.id;return()=>{if(id)opened.current[id]=lens.current[id]}},[c?.id]);
  // "Solara is typing" stays until her reply is actually on screen, not just until the request returns.
  const thinking=c&&typing?.id===c.id&&!c.messages.slice(typing.from).some(m=>m.r==='bot'||m.r==='staff');
  useEffect(()=>{
    if(c)seen.current[c.id]=shown.length;
    box.current?.scrollTo({top:box.current.scrollHeight,behavior:RM?'auto':'smooth'});
  });

  const think=async(id,text,from)=>{
    setTyping({id,from});
    try{await db.respond(id,text,user.id)}catch(e){toast('Assistant error: '+e.message);setTyping(null)}
    setTimeout(()=>setTyping(t=>t?.id===id?null:t),8000);   // safety net if the reply never lands
  };
  const optimistic=(r,t)=>{const p={convo:c.id,r,t,at:Date.now(),from:c.messages.length};setPending(x=>[...x,p]);return p};
  const unsend=p=>setPending(x=>x.filter(y=>y!==p));
  /* Test chat: no scripted customer. You type as the customer; Solara answers with the same greeting the web widget shows. */
  const sim=async()=>{
    const greeting=(await db.settings(user.id)).greeting||'Hi! How can I help you today?';
    const r=await db.add('convos',user.id,{customer:'Test customer',channel:'Web chat',status:'handled',test:true,messages:[{r:'bot',t:greeting,at:Date.now()}]});
    setSel(r.id);toast('Test chat started');
  };
  /* One composer. Team replies go to the patient. Typing as the patient is only offered in test chats, where it is how you try the assistant out. */
  const send=async e=>{e.preventDefault();const v=reply.trim();if(!v)return;setReply('');
    const asPatient=as==='patient'&&isTest(c),p=optimistic(asPatient?'cust':'staff',v),from=c.messages.length+1;
    try{
      if(asPatient){await db.patch('convos',c.id,{messages:[...c.messages,{r:'cust',t:v,at:Date.now()}]});think(c.id,v,from)}
      else await db.patch('convos',c.id,{messages:[...c.messages,{r:'staff',t:v,at:Date.now()}]});
    }catch(err){unsend(p);setReply(v);toast('Not sent: '+err.message)}};
  /* A submitted form becomes a customer message carrying its values; the model then reads it like any other message. */
  const submitForm=async(form,{values,text,freeText})=>{
    const p=optimistic('cust',text),from=c.messages.length+1;
    try{await db.patch('convos',c.id,{messages:[...c.messages,{r:'cust',t:text,at:Date.now(),meta:{fv:{id:form.id,values,freeText}}}]});think(c.id,text,from)}
    catch(err){unsend(p);toast('Not sent: '+err.message)}
  };
  const clearTests=async()=>{const t=cv.filter(isTest);if(!t.length)return toast('No test chats');if(!await confirm({title:`Delete ${t.length} test chat${t.length>1?'s':''}?`,body:'Only test chats are removed. Real patient conversations are kept.',confirm:'Delete test chats',danger:true}))return;for(const x of t)await db.del('convos',x.id);setSel(null);toast('Test chats cleared')};
  /* Only test chats can be deleted. Real customer conversations are kept. */
  const removeTest=async()=>{if(!await confirm({title:'Delete this test chat?',confirm:'Delete',danger:true}))return;await db.del('convos',c.id);setSel(null);toast('Test chat deleted')};
  /* The team ends a conversation (the patient is told and can start a new chat) or reopens it with the team.
     A chat handed to the team never goes back to Solara. */
  const endChat=async()=>{
    if(!await confirm({title:`End the conversation with ${c.customer}?`,body:'They are told it has ended and can start a new chat any time. Solara will not reply in it again.',confirm:'End conversation',cancel:'Keep it open'}))return;
    try{await db.closeConversation(c.id,true);toast('Conversation ended')}catch(e){toast(e.message)}};
  const reopen=async()=>{try{await db.closeConversation(c.id,false);toast('Reopened with your team')}catch(e){toast(e.message)}};

  return(<>
    <header><div><h1>Inbox</h1><p>{cv.length} conversation{cv.length===1?'':'s'}, {bots} repl{bots===1?'y':'ies'} from Solara{open?`, ${open} waiting for a person`:''}.</p></div>
      <span className="hdr-actions">{cv.some(isTest)&&<button className="btn ghost sm" onClick={clearTests}>Clear test chats</button>}<button className="btn ghost sm" onClick={sim}><Icon n="plus" size={16}/>Test chat</button></span></header>
    <div className="inbox">
      <div className="card list">
        <div className="list-h">
          <div className="seg" role="group" aria-label="Show">{[['all','All'],['open',`With the team${open?` (${open})`:''}`],['done','Solara'],['closed','Ended']].map(([k,l])=><button key={k} type="button" className="btn sm" aria-pressed={k===tab} onClick={()=>setTab(k)}>{l}</button>)}</div>
          <label className="search"><Icon n="search" size={18}/><input type="search" placeholder="Search chats" aria-label="Search chats" value={q} onChange={e=>setQ(e.target.value)}/></label>
        </div>
        {list.map((x,i)=>(
          <button key={x.id} className={'row st'+(isUrgent(x)?' urgent':'')} style={{'--i':Math.min(i,14)}} aria-current={x.id===c?.id} onClick={()=>setSel(x.id)}>
            <b>{x.customer}<span className={'pill'+(x.status==='handoff'?' hot':'')+(isUrgent(x)?' urgent':'')}>{isUrgent(x)?'Urgent':x.status==='handoff'?'Needs a person':'Handled'}</span></b>
            <small>{x.messages.at(-1)?.t}</small><small>{x.status==='handoff'?why(x)+' · ':''}{x.channel} · {ago(x.created)}</small>
          </button>))}
        {!list.length&&<Empty icon="chat" title={cv.length?'No chats match':'No conversations yet'}>{cv.length?'Try a different filter or search.':'Chats from your website appear here. Start a test chat to see how Solara answers.'}</Empty>}
      </div>
      <div className="card thread">
        {c?<>
          <header><div><b>{c.customer}</b> <small>{c.channel}</small>{c.status==='handoff'&&(phoneOf(c.messages)?<button className="why" onClick={()=>setCallOpen(o=>!o)} aria-expanded={callOpen}> · {why(c)}</button>:<small className="why"> · {why(c)}</small>)}</div><span className="hdr-actions">{c.status==='closed'?<><span className="chip cancelled" style={{textDecoration:'none'}}>Ended</span><button className="btn sm ghost" onClick={reopen}>Reopen</button></>:<button className="btn sm" onClick={endChat}>End conversation</button>}{isTest(c)&&<button className="btn sm ghost" onClick={removeTest}>Delete test chat</button>}</span></header>
          {callOpen&&c.status==='handoff'&&phoneOf(c.messages)&&<CallPanel phone={phoneOf(c.messages)} onClose={()=>setCallOpen(false)}/>}
          <div className="msgs" ref={box} aria-live="polite">
            {shown.map((m,i)=>(
              <Fragment key={m.id??(m.convo?'p':'')+i+'-'+m.at}>
                <div className={'m '+(m.r==='cust'?'':m.r)+(i>=base&&!m.convo?' pop':'')+(m.convo?' sending':'')} style={{'--i':Math.max(0,i-base)}}>
                  <small>{m.r==='bot'?'Solara':m.r==='staff'?'Your team':c.customer}{m.at?' · '+new Date(m.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):''}{m.convo?' · sending':''}</small>
                  {m.r==='bot'?<Reveal text={m.t} animate={!RM&&i>=opened.current[c.id]}/>:m.t}
                </div>
                {m.meta?.form&&<FormCard form={m.meta.form} done={c.messages.some(x=>x.meta?.fv?.id===m.meta.form.id)} onSubmit={submitForm}/>}
              </Fragment>))}
            {thinking&&<div className="m bot typing" aria-label="Solara is typing"><i/><i/><i/></div>}
          </div>
          {c.status==='closed'?<p className="route send-ended">This conversation has ended. Reopen it to reply.</p>:<form className="send" onSubmit={send}>
            {isTest(c)&&<div className="seg" role="group" aria-label="Send as">{[['patient','As the patient'],['team','As the team']].map(([k,l])=><button key={k} type="button" className="btn sm" aria-pressed={k===as} onClick={()=>setAs(k)}>{l}</button>)}</div>}
            <input value={reply} maxLength={1000} onChange={e=>setReply(e.target.value)} placeholder={as==='patient'&&isTest(c)?'Type what a patient would ask…':`Reply to ${c.customer}…`} aria-label="Message"/><button className="btn" disabled={!reply.trim()}>Send</button>
          </form>}
        </>:<Empty icon="chat" title="No conversation selected">Pick a chat on the left to read it and reply.</Empty>}
      </div>
    </div>
  </>);
}
