import {createContext,useContext,useState,useEffect,useCallback,useRef} from 'react';
import {db} from './db';
export const AuthCtx=createContext(),ToastCtx=createContext();
export const useAuth=()=>useContext(AuthCtx),useToast=()=>useContext(ToastCtx);

/* Loads a table for the signed-in user and reloads whenever db writes.
   With Supabase, replace the 'solara' event with a Realtime subscription. */
export function useTable(t){
  const {user}=useAuth(),[rows,set]=useState([]);
  const load=useCallback(()=>db.list(t,user.id).then(set),[t,user.id]);
  // Reload only when this table changed (or when the event does not say which table, as in the local demo).
  useEffect(()=>{const on=e=>{const x=e?.detail?.table;if(!x||x===t)load()};load();addEventListener('solara',on);return()=>removeEventListener('solara',on)},[load,t]);
  return [rows];
}
export function ToastProvider({children}){
  const [m,setM]=useState(''),[on,setOn]=useState(false),t=useRef();
  const show=useCallback(msg=>{setM(msg);setOn(true);clearTimeout(t.current);t.current=setTimeout(()=>setOn(false),2200)},[]);
  return <ToastCtx.Provider value={show}>{children}<div id="toast" role="status" className={on?'on':''}>{m}</div></ToastCtx.Provider>;
}
