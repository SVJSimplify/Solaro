/* The Solara Android app runs this same web code inside Capacitor. Everything native lives here, behind isApp,
   so the website never loads or calls a native plugin. Plugins are imported lazily for the same reason. */
import {Capacitor} from '@capacitor/core';

export const isApp=Capacitor.isNativePlatform();

const ls={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},del:k=>{try{localStorage.removeItem(k)}catch{}}};

/* ── Who is using this phone: a patient, or clinic staff ─────────────────── */
const MODE='solara.appMode';
export const appMode=()=>ls.get(MODE);
export const setAppMode=m=>m?ls.set(MODE,m):ls.del(MODE);

/* ── Clinics a patient has opened in the app ─────────────────────────────── */
const CLINICS='solara.clinics';
export const savedClinics=()=>{try{return JSON.parse(ls.get(CLINICS)||'[]')}catch{return[]}};
export function rememberClinic(key,name){
  if(!isApp||!key)return;
  const list=savedClinics().filter(c=>c.key!==key);
  ls.set(CLINICS,JSON.stringify([{key,name:name||'Clinic',at:Date.now()},...list].slice(0,20)));
}
export const forgetClinic=key=>ls.set(CLINICS,JSON.stringify(savedClinics().filter(c=>c.key!==key)));
/* A clinic link or QR code: …/widget?key=<uuid>, or just the key. */
export const keyFrom=text=>(String(text||'').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)||[])[0]?.toLowerCase()||null;

/* ── Push notifications ──────────────────────────────────────────────────── */
const TOKEN='solara.pushToken';
let pushPlugin=null;
const push=async()=>pushPlugin??=(await import('@capacitor/push-notifications')).PushNotifications;

export async function notificationsAllowed(){
  if(!isApp)return false;
  try{return(await(await push()).checkPermissions()).receive==='granted'}catch{return false}
}

/* Asks for permission if needed and returns this phone's push token, or null (declined, or Firebase not configured). */
export async function pushToken({ask=true}={}){
  if(!isApp)return null;
  try{
    const P=await push();
    let perm=await P.checkPermissions();
    if(perm.receive!=='granted'){
      if(!ask||perm.receive==='denied')return null;
      perm=await P.requestPermissions();
      if(perm.receive!=='granted')return null;
    }
    await P.createChannel({id:'solara-staff',name:'Clinic alerts',description:'Chats that need a person, new booking requests',importance:5,visibility:1,sound:'default'}).catch(()=>{});
    await P.createChannel({id:'solara-patient',name:'Appointments and replies',description:'Reminders and messages from your clinic',importance:4,visibility:0}).catch(()=>{});
    const token=await new Promise(resolve=>{
      const subs=[],done=v=>{subs.forEach(s=>s.then(x=>x.remove()));clearTimeout(t);resolve(v)};
      const t=setTimeout(()=>done(null),15000);
      subs.push(P.addListener('registration',x=>done(x.value)));
      subs.push(P.addListener('registrationError',()=>done(null)));
      P.register().catch(()=>done(null));
    });
    if(token)ls.set(TOKEN,token);
    return token;
  }catch{return null}
}
export const cachedPushToken=()=>ls.get(TOKEN);

/* Tapping a notification opens the page it is about (same app origin). */
export async function onNotificationTap(go){
  if(!isApp)return;
  try{(await push()).addListener('pushNotificationActionPerformed',a=>{const link=a?.notification?.data?.link;if(link&&link.startsWith('/'))go(link)})}catch{}
}

/* ── Phone sign-in (Firebase) ────────────────────────────────────────────── */
const auth=async()=>(await import('@capacitor-firebase/authentication')).FirebaseAuthentication;

/* Sends a code to the number. Resolves {verificationId} or, when Android verifies the number on its own, {idToken}. */
export async function startPhoneSignIn(phone){
  const A=await auth();
  return new Promise((resolve,reject)=>{
    const subs=[],done=(v,e)=>{subs.forEach(s=>s.then(x=>x.remove()));e?reject(e):resolve(v)};
    subs.push(A.addListener('phoneCodeSent',e=>done({verificationId:e.verificationId})));
    subs.push(A.addListener('phoneVerificationCompleted',async()=>{try{done({idToken:(await A.getIdToken({forceRefresh:true})).token})}catch(e){done(null,e)}}));
    subs.push(A.addListener('phoneVerificationFailed',e=>done(null,new Error(friendly(e?.message)))));
    A.signInWithPhoneNumber({phoneNumber:phone}).catch(e=>done(null,new Error(friendly(e?.message))));
  });
}
export async function confirmPhoneCode(verificationId,code){
  const A=await auth();
  try{await A.confirmVerificationCode({verificationId,verificationCode:code})}catch(e){throw new Error(friendly(e?.message))}
  return(await A.getIdToken({forceRefresh:true})).token;
}
const friendly=m=>/invalid.*code|verification code/i.test(m||'')?'That code is not right. Check it and try again.'
  :/too many|quota|blocked/i.test(m||'')?'Too many attempts. Please wait a while and try again.'
  :/network/i.test(m||'')?'No connection. Check your internet and try again.':'We could not verify that number. Please try again.';

/* ── QR scanning (Google code scanner: no camera permission needed) ──────── */
export async function scanQr(){
  const {BarcodeScanner,BarcodeFormat}=await import('@capacitor-mlkit/barcode-scanning');
  const {available}=await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable().catch(()=>({available:true}));
  if(!available)await BarcodeScanner.installGoogleBarcodeScannerModule();
  const {barcodes}=await BarcodeScanner.scan({formats:[BarcodeFormat.QrCode]});
  return barcodes?.[0]?.rawValue??null;
}

/* ── Android back button: back through history, or leave the app at the start ── */
export async function wireBackButton(){
  if(!isApp)return;
  try{
    const {App}=await import('@capacitor/app');
    App.addListener('backButton',({canGoBack})=>canGoBack?history.back():App.exitApp());
    // A clinic QR code or invite link opened the app: go to that page (only our own paths).
    App.addListener('appUrlOpen',({url})=>{try{const u=new URL(url);if(u.host==='solaro-six.vercel.app'&&/^\/(widget|join)$/.test(u.pathname))location.assign(u.pathname+u.search)}catch{}});
  }catch{}
}
