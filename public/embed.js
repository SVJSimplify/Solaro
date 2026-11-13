/* Solara website chat. Add to any page: <script src="https://YOUR-SOLARA-APP/embed.js" data-org="CLINIC-ID" async></script>
   Optional: data-label="Book or ask a question", data-color="#0f766e", data-position="left". Adds one button and one iframe. */
(function(){
  var s=document.currentScript;if(!s||window.__solaraChat)return;
  var org=s.getAttribute('data-org');if(!org||!/^[0-9a-f-]{36}$/i.test(org))return;
  window.__solaraChat=true;
  var base=new URL(s.src,location.href).origin,color=s.getAttribute('data-color')||'#0f766e',label=s.getAttribute('data-label')||'Chat with us';
  var side=s.getAttribute('data-position')==='left'?'left':'right',open=false,frame=null;
  var btn=document.createElement('button');
  btn.type='button';btn.textContent=label;btn.setAttribute('aria-expanded','false');btn.setAttribute('aria-controls','solara-chat-frame');
  btn.style.cssText='position:fixed;bottom:20px;'+side+':20px;z-index:2147483646;border:0;border-radius:999px;padding:12px 18px;font:600 15px/1.2 system-ui,sans-serif;color:#fff;background:'+color+';box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:pointer';
  function size(){if(!frame)return;var small=window.innerWidth<520;
    frame.style.cssText='position:fixed;z-index:2147483647;border:0;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.25);'+
      (small?'inset:0;width:100%;height:100%;border-radius:0':'bottom:80px;'+side+':20px;width:380px;height:600px;max-height:calc(100vh - 100px);border-radius:16px')+(open?'':';display:none')}
  btn.onclick=function(){
    if(!frame){frame=document.createElement('iframe');frame.id='solara-chat-frame';frame.title='Chat with the clinic';
      frame.src=base+'/widget?org='+encodeURIComponent(org);frame.setAttribute('allow','clipboard-write');document.body.appendChild(frame)}
    open=!open;btn.setAttribute('aria-expanded',String(open));btn.textContent=open?'Close chat':label;size();
    if(open&&window.innerWidth<520){btn.style.zIndex='2147483647';btn.style.bottom='auto';btn.style.top='12px'}
    else{btn.style.zIndex='2147483646';btn.style.top='auto';btn.style.bottom='20px'}
  };
  window.addEventListener('resize',size);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&open)btn.onclick()});
  (document.body?Promise.resolve():new Promise(function(r){document.addEventListener('DOMContentLoaded',r)})).then(function(){document.body.appendChild(btn)});
})();
