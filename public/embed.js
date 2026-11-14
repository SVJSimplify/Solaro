/* Solara website chat. Add to any page: <script src="https://YOUR-SOLARA-APP/embed.js" data-org="CLINIC-ID" async></script>
   Optional: data-label="Book or ask a question", data-color="#C9413A", data-position="left". Adds one button and one iframe. */
(function(){
  var s=document.currentScript;if(!s||window.__solaraChat)return;
  var org=s.getAttribute('data-org');if(!org||!/^[0-9a-f-]{36}$/i.test(org))return;
  window.__solaraChat=true;
  // Tell the clinic's dashboard this site has the chat installed (public key; fire-and-forget).
  try{fetch('https://wqhxpfzbvtkdwzehddjr.supabase.co/rest/v1/rpc/widget_ping',{method:'POST',keepalive:true,
    headers:{'Content-Type':'application/json',apikey:'sb_publishable_mgqlYnRfwa91pfm52GRsNw_HVFu0wUP'},
    body:JSON.stringify({org:org,origin:location.origin})}).catch(function(){})}catch(e){}
  var base=new URL(s.src,location.href).origin,color=s.getAttribute('data-color')||'#C9413A',label=s.getAttribute('data-label')||'Chat with us';
  var side=s.getAttribute('data-position')==='left'?'left':'right',open=false,frame=null;
  var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CHAT='<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style="flex:none"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z" fill="currentColor"/></svg>';
  var CLOSE='<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style="flex:none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  var btn=document.createElement('button');
  btn.type='button';btn.setAttribute('aria-expanded','false');btn.setAttribute('aria-controls','solara-chat-frame');
  function paint(){
    btn.innerHTML=open?CLOSE+'<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Close chat</span>':CHAT+'<span>'+label.replace(/[<>&]/g,'')+'</span>';
    btn.style.padding=open?'0':'0 20px 0 16px';btn.style.width=open?'56px':'auto';
  }
  btn.style.cssText='position:fixed;bottom:20px;'+side+':20px;z-index:2147483647;height:56px;border:0;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;gap:8px;'+
    'font:600 15px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;background:'+color+';box-shadow:0 10px 28px -8px rgba(60,20,15,.45),0 2px 6px rgba(60,20,15,.18);cursor:pointer;'+
    'transition:'+(reduce?'none':'transform .2s ease,box-shadow .2s ease');
  btn.onmouseenter=function(){if(!reduce)btn.style.transform='translateY(-2px)'};
  btn.onmouseleave=function(){btn.style.transform='none'};
  paint();
  function size(){if(!frame)return;var small=window.innerWidth<520;
    frame.style.cssText='position:fixed;z-index:2147483646;border:0;background:#FFFBF5;color-scheme:light;box-shadow:0 24px 60px -12px rgba(60,20,15,.35),0 0 0 1px rgba(60,20,15,.06);'+
      'transition:'+(reduce?'none':'opacity .22s ease,transform .26s cubic-bezier(.22,1,.36,1)')+';transform-origin:bottom '+side+';'+
      (small?'inset:0;width:100%;height:100%;border-radius:0':'bottom:88px;'+side+':20px;width:384px;height:620px;max-height:calc(100vh - 108px);border-radius:20px')+
      (open?';opacity:1;transform:none':';opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;visibility:hidden')}
  btn.onclick=function(){
    if(!frame){frame=document.createElement('iframe');frame.id='solara-chat-frame';frame.title='Chat with the clinic';
      frame.src=base+'/widget?org='+encodeURIComponent(org);frame.setAttribute('allow','clipboard-write');size();document.body.appendChild(frame);frame.getBoundingClientRect()}
    open=!open;btn.setAttribute('aria-expanded',String(open));paint();size();
    if(open&&window.innerWidth<520){btn.style.bottom='auto';btn.style.top='10px';btn.style.height='44px';btn.style.width='44px';btn.style.boxShadow='none'}
    else{btn.style.top='auto';btn.style.bottom='20px';btn.style.height='56px';btn.style.boxShadow='0 10px 28px -8px rgba(60,20,15,.45),0 2px 6px rgba(60,20,15,.18)';if(!open)btn.style.width='auto'}
  };
  window.addEventListener('resize',size);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&open){btn.onclick();btn.focus()}});
  (document.body?Promise.resolve():new Promise(function(r){document.addEventListener('DOMContentLoaded',r)})).then(function(){document.body.appendChild(btn)});
})();
