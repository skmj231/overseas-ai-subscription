(function(){
  const allowed=new Set(['guide_official_link_click','guide_refund_copy','guide_related_click','guide_donna_cta_click','calculator_started','calculator_completed','calculator_donna_cta_click']);
  window.donnaTrack=function(name,params={}){
    if(!allowed.has(name)) return;
    const payload={event:name,page_location:location.href,page_path:location.pathname,service:document.body.dataset.service||null,...params};
    if(typeof window.gtag==='function') window.gtag('event',name,payload);
    window.dispatchEvent(new CustomEvent('donna:analytics',{detail:payload}));
  };
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-event]');
    if(el) donnaTrack(el.dataset.event,{destination:el.href||null,placement:el.dataset.placement||null});
  });
})();
