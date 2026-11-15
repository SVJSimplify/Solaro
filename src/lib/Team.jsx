/* Team members and invites. Owners and admins invite by email and send the join link themselves (no email service yet);
   the link only works for that email address, once, within 7 days. Only the owner changes roles or removes admins. */
import {useEffect,useState} from 'react';
import {db} from './db';
import {useAuth,useToast} from './hooks';

const ROLES={owner:'Owner',admin:'Admin',staff:'Front desk',doctor:'Doctor'};
const HINT={admin:'Everything except owner-only settings',staff:'Inbox, bookings and patients',doctor:'Their schedule and patients'};

export default function Team(){
  const {user:me}=useAuth(),toast=useToast();
  const isOwner=me.role==='owner',canManage=isOwner||me.role==='admin';
  const [t,setT]=useState(null),[email,setEmail]=useState(''),[role,setRole]=useState('staff'),[busy,setBusy]=useState(false),[link,setLink]=useState(null),[err,setErr]=useState('');
  const load=()=>db.team().then(setT).catch(e=>setErr(e.message));
  useEffect(()=>{load()},[]);
  const act=async(fn,msg)=>{try{await fn();if(msg)toast(msg);load()}catch(e){toast(e.message)}};
  const invite=async e=>{e.preventDefault();setErr('');setBusy(true);
    try{const tok=await db.invite(email.trim(),role);setLink({email:email.trim(),url:`${location.origin}/join?token=${tok}`});setEmail('');load()}
    catch(x){setErr(x.message)}finally{setBusy(false)}};
  const copy=()=>navigator.clipboard.writeText(link.url).then(()=>toast('Link copied'),()=>toast('Copy failed: select the link and copy it'));

  return(<section className="card st" id="team" style={{maxWidth:520,marginTop:16}}>
    <h3>Team</h3>
    {!t&&!err&&<p className="route">Loading…</p>}
    {t&&<ul className="team">{t.members.map(m=><li key={m.user_id}>
      <div><b>{m.email}</b>{m.me&&<small> (you)</small>}</div>
      {isOwner&&m.role!=='owner'
        ?<select aria-label={'Role for '+m.email} value={m.role} onChange={e=>act(()=>db.setRole(m.user_id,e.target.value),'Role updated')}>
            {['admin','staff','doctor'].map(r=><option key={r} value={r}>{ROLES[r]}</option>)}</select>
        :<span className="chip">{ROLES[m.role]}</span>}
      {canManage&&m.role!=='owner'&&!m.me&&(isOwner||m.role!=='admin')&&
        <button type="button" className="btn ghost sm" onClick={()=>confirm(`Remove ${m.email} from the team? They lose access straight away.`)&&act(()=>db.removeMember(m.user_id),'Removed')}>Remove</button>}
    </li>)}</ul>}

    {canManage&&t?.invites.length>0&&<><h4 className="team-h">Waiting to join</h4><ul className="team">{t.invites.map(i=><li key={i.id}>
      <div><b>{i.email}</b><small>{ROLES[i.role]} · link expires {new Date(i.expires_at).toLocaleDateString()}</small></div>
      <button type="button" className="btn ghost sm" onClick={()=>act(()=>db.revokeInvite(i.id),'Invite cancelled')}>Cancel</button>
    </li>)}</ul></>}

    {canManage&&<form onSubmit={invite} className="team-form">
      <h4 className="team-h">Invite someone</h4>
      <div className="f"><label htmlFor="ti-e">Email</label><input id="ti-e" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@yourclinic.com" autoComplete="off" required/></div>
      <div className="f"><label htmlFor="ti-r">Role</label><select id="ti-r" value={role} onChange={e=>setRole(e.target.value)}>
        {(isOwner?['admin','staff','doctor']:['staff','doctor']).map(r=><option key={r} value={r}>{ROLES[r]} · {HINT[r]}</option>)}</select></div>
      {err&&<p className="err" role="alert">{err}</p>}
      <button className="btn sm" disabled={busy||!email.trim()}>{busy?'Creating…':'Create invite link'}</button>
    </form>}

    {link&&<div className="team-link" role="status">
      <p>Send this link to <b>{link.email}</b>. It works once, for that email address, for 7 days.</p>
      <code>{link.url}</code>
      <div className="acts"><button type="button" className="btn sm" onClick={copy}>Copy link</button>
        <a className="btn ghost sm" href={`mailto:${link.email}?subject=${encodeURIComponent('Join '+(me.biz||'our clinic')+' on Solara')}&body=${encodeURIComponent('You have been invited to join '+(me.biz||'our clinic')+' on Solara.\n\nOpen this link and sign in or create an account with this email address:\n'+link.url+'\n\nThe link works once and expires in 7 days.')}`}>Open in email</a>
        <button type="button" className="btn ghost sm" onClick={()=>setLink(null)}>Done</button></div>
    </div>}
  </section>);
}
