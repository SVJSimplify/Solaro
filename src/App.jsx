import {useState,useEffect} from 'react';
import {Routes,Route,Navigate} from 'react-router-dom';
import {db} from './lib/db';
import {AuthCtx,ToastProvider,useAuth} from './lib/hooks';
import Widget from './pages/Widget';import Admin from './pages/Admin';import Auth from './pages/Auth';import Layout from './pages/Layout';import Onboarding from './pages/Onboarding';
import Inbox from './pages/Inbox';import Demo from './pages/Demo';import Alerts from './pages/Alerts';import Customers from './pages/Customers';import Activity from './pages/Activity';import Bookings from './pages/Bookings';
import Insights from './pages/Insights';import Knowledge from './pages/Knowledge';import Settings from './pages/Settings';

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
  useEffect(()=>{db.session().then(setUser).catch(()=>setUser(null))},[]);
  if(user===undefined)return null;
  // The website chat is public: visitors never sign in.
  if(window.location.pathname==='/widget')return <Widget/>;
  if(!user)return <Auth onAuth={setUser}/>;
  const signOut=async()=>{await db.signOut();setUser(null)};
  return(
    <AuthCtx.Provider value={{user,signOut}}><ToastProvider>
      <Routes>
        <Route path="onboarding" element={<Onboarding/>}/>
        <Route path="demo" element={<Demo/>}/>
        <Route element={<Gate><Layout/></Gate>}>
          <Route index element={<Navigate to="/inbox" replace/>}/>
          <Route path="inbox" element={<Inbox/>}/><Route path="alerts" element={<Alerts/>}/><Route path="customers" element={<Customers/>}/><Route path="activity" element={<Activity/>}/><Route path="bookings" element={<Bookings/>}/><Route path="insights" element={<Insights/>}/>
          <Route path="knowledge" element={<Knowledge/>}/><Route path="settings" element={<Settings/>}/><Route path="admin" element={user.platformAdmin?<Admin/>:<Navigate to="/inbox" replace/>}/>
          <Route path="*" element={<Navigate to="/inbox" replace/>}/>
        </Route>
      </Routes>
    </ToastProvider></AuthCtx.Provider>
  );
}
