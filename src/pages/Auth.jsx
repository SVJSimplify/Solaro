import {useState} from 'react';
import {db} from '../lib/db';import {Logo} from '../lib/ui';

export default function Auth({onAuth}){
  const [sign,setSign]=useState(false),[f,setF]=useState({em:'',pw:'',bn:''}),[err,setErr]=useState(''),[shake,setShake]=useState(false),[busy,setBusy]=useState(false);
  const set=k=>e=>setF({...f,[k]:e.target.value});
  const bad=m=>{setErr(m);setShake(true)};
  const submit=async e=>{
    e.preventDefault();const em=f.em.trim(),bn=f.bn.trim();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em))return bad('Enter a valid email.');
    if(f.pw.length<6)return bad('Password needs 6+ characters.');
    if(sign&&!bn)return bad('Enter your business name.');
    setBusy(true);
    try{onAuth(sign?await db.signUp(em,f.pw,bn):await db.signIn(em,f.pw))}catch(x){bad(x.message);setBusy(false)}
  };
  return(
    <div id="auth"><form className={'card'+(shake?' shake':'')} onSubmit={submit} noValidate onAnimationEnd={e=>e.target===e.currentTarget&&setShake(false)}>
      <Logo/>
      <h2>{sign?'Create your front desk':'Welcome back'}</h2>
      <p>{sign?'Takes a minute. No card needed.':'Sign in to your front desk.'}</p>
      {sign&&<div className="f" id="bf"><label htmlFor="bn">Business name</label><input id="bn" value={f.bn} onChange={set('bn')} placeholder="Riverside Family Dental"/></div>}
      <div className="f"><label htmlFor="em">Email</label><input id="em" type="email" autoComplete="email" value={f.em} onChange={set('em')}/></div>
      <div className="f"><label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete={sign?'new-password':'current-password'} value={f.pw} onChange={set('pw')}/></div>
      <p className="err" role="alert">{err}</p>
      <button className={'btn'+(busy?' busy':'')} style={{width:'100%'}}>{sign?'Create account':'Sign in'}</button>
      <p style={{margin:'14px 0 0',textAlign:'center'}}><button type="button" className="lk" onClick={()=>{setSign(!sign);setErr('')}}>{sign?'I already have an account':'Create an account'}</button></p>
    </form></div>
  );
}
