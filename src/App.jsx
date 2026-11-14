import {useState,useEffect} from 'react';
import {Routes,Route,Navigate} from 'react-router-dom';
import {db} from './lib/db';
import {AuthCtx,ToastProvider,useAuth} from './lib/hooks';
import {ConfirmProvider} from './lib/ui';
import Widget from './pages/Widget';import Admin from './pages/Admin';import Auth from './pages/Auth';import Layout from './pages/Layout';import Onboarding from './pages/Onboarding';
import Inbox from './pages/Inbox';import Demo from './pages/Demo';import Alerts from './pages/Alerts';import Customers from './pages/Customers';import Activity from './pages/Activity';import Bookings from './pages/Bookings';
import Insights from './pages/Insights';import Today from './pages/Today';import {Recover,ChooseClinic} from './pages/Auth';import Knowledge from './pages/Knowledge';import Install from './pages/Install';
import Settings from './pages/Settings';

/* Sends the user to onboarding until a hand-off number and at least one answer exist. */
function Gate({children}){
  const {user}=useAuth(),[ok,setOk]=useState(null);
  useEffect(()=>{
    let live=true;
    Promise.all([db.settings(user.id),db.list('kb',user.id)])
      .then(([s,kb])=>live&&setOk(!!(s.handoff&&kb.length)))
      .catch(()=>live&&setOk(false));
    return()=>{live=false};
  },[user.id]);
  if(ok===null)return null;
  if(!ok)return<Navigate to="/onboarding" replace/>;
  return children;
}

export default function App(){
  const [user,setUser]=useState(undefined);
  // A password-recovery link lands here signed in; ask for the new password before anything else.
  const [recover,setRecover]=useState(()=>/[#&?]type=recovery/.test(window.location.hash+window.location.search));
  useEffect(()=>{db.onRecovery?.(()=>setRecover(true));db.session().then(setUser).catch(()=>setUser(null))},[]);
  if(user===undefined)return null;
  // The website chat is public: visitors never sign in.
  if(window.location.pathname==='/widget')return <Widget/>;
  if(!user)return <Auth onAuth={setUser}/>;
  const switchOrg=async id=>setUser(await db.chooseOrg(id));
  if(recover)return <Recover onDone={()=>{window.history.replaceState(null,'',window.location.pathname);setRecover(false)}}/>;
  if(user.needsOrg)return <ChooseClinic user={user} onChoose={switchOrg}/>;
  const signOut=async()=>{await db.signOut();setUser(null)};
  return(
    <AuthCtx.Provider value={{user,signOut,switchOrg}}><ToastProvider><ConfirmProvider>
      <Routes key={user.org||'local'}>
        <Route path="onboarding" element={<Onboarding/>}/>
        <Route path="demo" element={<Demo/>}/>
        <Route element={<Gate><Layout/></Gate>}>
          <Route index element={<Navigate to="/today" replace/>}/>
          <Route path="today" element={<Today/>}/>
          <Route path="inbox" element={<Inbox/>}/><Route path="alerts" element={<Alerts/>}/><Route path="customers" element={<Customers/>}/><Route path="activity" element={<Activity/>}/><Route path="bookings" element={<Bookings/>}/><Route path="insights" element={<Insights/>}/>
          <Route path="knowledge" element={<Knowledge/>}/><Route path="settings" element={<Settings/>}/><Route path="install" element={<Install/>}/><Route path="admin" element={user.platformAdmin?<Admin/>:<Navigate to="/inbox" replace/>}/>
          <Route path="*" element={<Navigate to="/inbox" replace/>}/>
        </Route>
      </Routes>
    </ConfirmProvider></ToastProvider></AuthCtx.Provider>
  );
}
