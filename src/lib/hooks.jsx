import {createContext,useContext,useState,useEffect,useCallback,useRef} from 'react';
import {db} from './db';
import {clinicNow} from './avail';
export const AuthCtx=createContext(),ToastCtx=createContext();
export const useAuth=()=>useContext(AuthCtx),useToast=()=>useContext(ToastCtx);

/* Loads a table for the signed-in user and reloads whenever db writes.
   With Supabase, replace the 'solara' event with a Realtime subscription. */
export function useTable(t){
  const {user}=useAuth(),[rows,set]=useState([]),seq=useRef(0);
  // Only the newest load may write: an older, slower response never overwrites fresher data.
  const load=useCallback(()=>{const n=++seq.current;return db.list(t,user.id).then(r=>{if(n===seq.current)set(r)}).catch(()=>{})},[t,user.id]);
  // Reload only when this table changed (or when the event does not say which table, as in the local demo).
  useEffect(()=>{const on=e=>{const x=e?.detail?.table;if(!x||x===t)load()};load();addEventListener('solara',on);return()=>removeEventListener('solara',on)},[load,t]);
  return [rows];
}
export function ToastProvider({children}){
  const [m,setM]=useState(''),[on,setOn]=useState(false),t=useRef();
  const show=useCallback(msg=>{setM(msg);setOn(true);clearTimeout(t.current);t.current=setTimeout(()=>setOn(false),2200)},[]);
  return <ToastCtx.Provider value={show}>{children}<div id="toast" role="status" className={on?'on':''}>{m}</div></ToastCtx.Provider>;
}

/* The clinic's wall clock ("YYYY-MM-DDTHH:MM"), re-rendering each minute so open times and "now" never go stale. */
export function useClinicNow(tz){
  const [now,setNow]=useState(()=>clinicNow(tz));
  useEffect(()=>{setNow(clinicNow(tz));const t=setInterval(()=>setNow(clinicNow(tz)),20000);return()=>clearInterval(t)},[tz]);
  return now;
}

export {Reveal} from './Reveal';
