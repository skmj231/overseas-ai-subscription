document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{
  const text=document.querySelector(button.dataset.copy)?.textContent.trim();
  if(!text)return;
  await navigator.clipboard.writeText(text);
  button.textContent='복사했어요';
  donnaTrack('guide_refund_copy');
  setTimeout(()=>button.textContent='영문 요청문 복사',1600);
}));
