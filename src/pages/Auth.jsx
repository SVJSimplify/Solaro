import {useState} from 'react';
import {db} from '../lib/db';import {Logo} from '../lib/ui';import {Field,problem} from '../lib/fields';

export default function Auth({onAuth}){
  const [sign,setSign]=useState(false),[f,setF]=useState({em:'',pw:'',bn:''}),[err,setErr]=useState(''),[shake,setShake]=useState(false),[busy,setBusy]=useState(false),[show,setShow]=useState(false);
  const set=k=>v=>setF({...f,[k]:v});
  const bad=m=>{setErr(m);setShake(true)};
  const forgot=async()=>{const em=f.em.trim();if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em))return bad('Enter your email first, then choose Forgot password.');
    try{await db.resetPassword(em);setErr('If that email has an account, a reset link is on its way.')}catch(x){bad(x.message)}};
  const submit=async e=>{
    e.preventDefault();const em=f.em.trim(),bn=f.bn.trim();
    // New accounts need 8+ characters; sign-in accepts whatever the account already has.
    const wrong=(sign&&problem('business',bn,{label:'Business name'}))||problem('email',em,{label:'Email'})||problem('password',f.pw,{label:'Password',min:sign?8:1});
    setShow(true);if(wrong)return bad(wrong);
    setBusy(true);
    try{onAuth(sign?await db.signUp(em,f.pw,bn):await db.signIn(em,f.pw))}catch(x){bad(x.message);setBusy(false)}
  };
  return(
    <div id="auth"><form className={'card'+(shake?' shake':'')} onSubmit={submit} noValidate onAnimationEnd={e=>e.target===e.currentTarget&&setShake(false)}>
      <Logo/>
      <h2>{sign?'Create your front desk':'Welcome back'}</h2>
      <p>{sign?'Takes a minute. No card needed.':'Sign in to your front desk.'}</p>
      {sign&&<Field id="bn" label="Business name" kind="business" value={f.bn} onChange={set('bn')} placeholder="Riverside Family Dental" autoComplete="organization" show={show}/>}
      <Field id="em" label="Email" kind="email" value={f.em} onChange={set('em')} autoComplete="email" show={show}/>
      <Field id="pw" label="Password" kind="password" min={sign?8:1} value={f.pw} onChange={set('pw')} autoComplete={sign?'new-password':'current-password'} hint={sign?'At least 8 characters.':''} show={show}/>
      <p className="err" role="alert">{err}</p>
      <button className={'btn'+(busy?' busy':'')} style={{width:'100%'}}>{sign?'Create account':'Sign in'}</button>
      <p style={{margin:'14px 0 0',textAlign:'center'}}><button type="button" className="lk" onClick={()=>{setSign(!sign);setErr('');setShow(false)}}>{sign?'I already have an account':'Create an account'}</button>{!sign&&<> · <button type="button" className="lk" onClick={forgot}>Forgot password</button></>}</p>
    </form></div>
  );
}

/* Reached from the link in a password-reset email: set the new password, then carry on signed in. */
export function Recover({onDone}){
  const [pw,setPw]=useState(''),[err,setErr]=useState(''),[busy,setBusy]=useState(false);
  const save=async e=>{e.preventDefault();if(pw.length<8)return setErr('Use at least 8 characters.');setBusy(true);
    try{await db.updatePassword(pw);onDone()}catch(x){setErr(x.message);setBusy(false)}};
  return(<div id="auth"><form className="card" onSubmit={save} noValidate><Logo/><h2>Choose a new password</h2>
    <Field id="npw" label="New password" kind="password" min={8} value={pw} onChange={setPw} autoComplete="new-password" hint="At least 8 characters."/>
    <p className="err" role="alert">{err}</p>
    <button className={'btn'+(busy?' busy':'')} style={{width:'100%'}}>Save password</button>
    <p style={{margin:'14px 0 0',textAlign:'center'}}><button type="button" className="lk" onClick={onDone}>Not now</button></p></form></div>);
}

/* Someone who works at several clinics picks one. Nothing is chosen for them. */
export function ChooseClinic({user,onChoose}){
  return(<div id="auth"><div className="card"><Logo/><h2>Which clinic?</h2><p>You belong to more than one. You can switch later from the sidebar.</p>
    {user.orgs.map(o=><button key={o.id} className="btn ghost" style={{width:'100%',marginTop:8}} onClick={()=>onChoose(o.id)}>{o.name} · {o.role}</button>)}</div></div>);
}
