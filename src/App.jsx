import {useState,useEffect} from 'react';
import {Routes,Route,Navigate} from 'react-router-dom';
import {db} from './lib/db';
import {AuthCtx,ToastProvider,useAuth} from './lib/hooks';
import {ConfirmProvider} from './lib/ui';
import Widget from './pages/Widget';import Admin from './pages/Admin';import Auth from './pages/Auth';import Layout from './pages/Layout';import Onboarding from './pages/Onboarding';
import Inbox from './pages/Inbox';import Demo from './pages/Demo';import Alerts from './pages/Alerts';import Customers from './pages/Customers';import Activity from './pages/Activity';import Bookings from './pages/Bookings';
import Insights from './pages/Insights';import Today from './pages/Today';import {Recover,ChooseClinic} from './pages/Auth';import Knowledge from './pages/Knowledge';import Install from './pages/Install';
import Settings from './pages/Settings';
import Help from './pages/Help';
import {captureJoin,pendingJoin} from './lib/join';
import AppHome from './pages/AppHome';
import {isApp,appMode,setAppMode,pushToken,onNotificationTap,wireBackButton,cachedPushToken} from './lib/native';

captureJoin();
if(isApp){wireBackButton();onNotificationTap(link=>location.assign(link));if(pendingJoin())setAppMode('staff')}   // an invite is for staff

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
  const [user,setUserRaw]=useState(undefined),[,bump]=useState(0);
  const setUser=u=>{setUserRaw(u);bump(n=>n+1)};
  // A password-recovery link lands here signed in; ask for the new password before anything else.
  const [recover,setRecover]=useState(()=>/[#&?]type=recovery/.test(window.location.hash+window.location.search));
  useEffect(()=>{db.onRecovery?.(()=>setRecover(true));db.session().then(setUser).catch(()=>setUser(null))},[]);
  // Staff on the app get alerts for the clinic they are signed in to.
  useEffect(()=>{if(isApp&&user?.org)pushToken().then(t=>t&&db.registerDevice?.(t)).catch(()=>{})},[user?.org]);
  if(user===undefined)return null;
  // The website chat is public: visitors never sign in.
  if(window.location.pathname==='/widget')return <Widget/>;
  // In the Solara app, patients never sign in: they get their clinics. Staff sign in as on the web.
  if(isApp&&!user&&appMode()!=='staff')return <AppHome onStaff={()=>setUser(null)}/>;
  if(!user)return <Auth onAuth={setUser} onPatient={isApp?()=>{setAppMode('patient');setUser(null)}:null}/>;
  const switchOrg=async id=>setUser(await db.chooseOrg(id));
  if(recover)return <Recover onDone={()=>{window.history.replaceState(null,'',window.location.pathname);setRecover(false)}}/>;
  if(user.needsOrg)return <ChooseClinic user={user} onChoose={switchOrg}/>;
  const signOut=async()=>{if(isApp)await db.unregisterDevice?.(cachedPushToken()).catch(()=>{});await db.signOut();setUser(null)};
  return(
    <AuthCtx.Provider value={{user,signOut,switchOrg}}><ToastProvider><ConfirmProvider>
      <Routes key={user.org||'local'}>
        <Route path="onboarding" element={<Onboarding/>}/>
        <Route path="demo" element={<Demo/>}/>
        <Route element={<Gate><Layout/></Gate>}>
          <Route index element={<Navigate to="/today" replace/>}/>
          <Route path="today" element={<Today/>}/>
          <Route path="inbox" element={<Inbox/>}/><Route path="alerts" element={<Alerts/>}/><Route path="customers" element={<Customers/>}/><Route path="activity" element={<Activity/>}/><Route path="bookings" element={<Bookings/>}/><Route path="insights" element={<Insights/>}/>
          <Route path="knowledge" element={<Knowledge/>}/><Route path="settings" element={<Settings/>}/><Route path="install" element={<Install/>}/><Route path="help" element={<Help/>}/><Route path="admin" element={user.platformAdmin?<Admin/>:<Navigate to="/inbox" replace/>}/>
          <Route path="*" element={<Navigate to="/inbox" replace/>}/>
        </Route>
      </Routes>
    </ConfirmProvider></ToastProvider></AuthCtx.Provider>
  );
}
