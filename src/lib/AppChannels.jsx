/* Two more ways patients reach the chat: the clinic's own Android app (a WebView), and the Solara app via a QR code. */
import {useEffect,useMemo,useState} from 'react';
import QRCode from 'qrcode';
import {useToast} from './hooks';

const CHAT_HOST='solaro-six.vercel.app';

export function OwnAppEmbed({wkey}){
  const toast=useToast();
  const url=`https://${CHAT_HOST}/widget?key=${wkey}`;
  const code=useMemo(()=>`// ClinicChatActivity.kt: the clinic's Solara chat inside your Android app.
// Add to AndroidManifest.xml: <uses-permission android:name="android.permission.INTERNET" />
class ClinicChatActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true   // the chat is still there when the patient comes back
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "${CHAT_HOST}") return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))   // phone numbers and other sites open outside the chat
                return true
            }
        }
        setContentView(web)
        web.loadUrl("${url}")
    }
}`,[url]);
  const copy=t=>navigator.clipboard.writeText(t).then(()=>toast('Copied'),()=>toast('Copy failed'));
  return(<section className="card st">
    <h3>In your own Android app</h3>
    <p className="route">If your clinic has its own app, give this to your developer. It opens the same chat in a screen of your app. Flutter, React Native and other frameworks work the same way: load this address in a WebView with JavaScript and storage turned on.</p>
    <div className="url-row"><code className="sys-url">{url}</code><button type="button" className="btn ghost sm" onClick={()=>copy(url)}>Copy address</button></div>
    <pre className="inst-code"><code>{code}</code></pre>
    <button type="button" className="btn ghost sm" onClick={()=>copy(code)}>Copy Kotlin code</button>
    <p className="route" style={{marginTop:12}}>Inside your own app, patients manage bookings with a text-message code, so that part works once text messages are connected.</p>
  </section>);
}

export function SolaraAppQr({wkey,clinic}){
  const [img,setImg]=useState(null);
  const url=`https://${CHAT_HOST}/widget?key=${wkey}`;
  useEffect(()=>{QRCode.toDataURL(url,{width:560,margin:2,errorCorrectionLevel:'M',color:{dark:'#211A18',light:'#FFFFFF'}}).then(setImg).catch(()=>setImg(null))},[url]);
  return(<section className="card st">
    <h3>Patients on the Solara app</h3>
    <p className="route">Print this for your reception desk. Patients scan it with the Solara app to add your clinic, then get reminders and your replies as notifications. Scanning with an ordinary camera opens the same chat in the browser.</p>
    <div className="qr-row">
      {img?<img src={img} width={180} height={180} alt={`QR code that opens ${clinic||'your clinic'}'s chat`} className="qr"/>:<div className="qr" aria-hidden="true"/>}
      <div>
        {img&&<a className="btn sm" href={img} download={`solara-qr-${(clinic||'clinic').replace(/[^\w-]+/g,'-').toLowerCase()}.png`}>Download QR code</a>}
        <p className="route" style={{marginTop:10}}>Tip: add a line under it such as “Scan to book, change or cancel your visit”.</p>
      </div>
    </div>
  </section>);
}
