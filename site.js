(function(){
  const pad=n=>String(n).padStart(2,'0'); document.querySelectorAll('[data-demo-date]').forEach(el=>{const d=new Date();d.setDate(d.getDate()+Number(el.dataset.demoDate));el.textContent=`다음 결제 ${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`}); document.querySelectorAll('[data-demo-days]').forEach(el=>el.textContent=`${el.dataset.demoDays}일 남음`);
  const date=document.getElementById('chargedAt'); if(date){const now=new Date();date.value=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;}
  const official={chatgpt:{name:'ChatGPT',manage:'https://chatgpt.com/',support:'https://help.openai.com/en/articles/7232895-how-do-i-request-a-refund'},claude:{name:'Claude',manage:'https://claude.ai/settings/billing',support:'https://support.anthropic.com/en/articles/9015913-how-to-get-support'},cursor:{name:'Cursor',manage:'https://cursor.com/dashboard/billing',support:'https://prod.cursor.com/help/account-and-billing/refunds'},midjourney:{name:'Midjourney',manage:'https://www.midjourney.com/account',support:'https://help.midjourney.com/en/articles/8150966-refunds'}};
  const serviceNames={gemini:'Gemini',copilot:'Microsoft Copilot',perplexity:'Perplexity',github:'GitHub Copilot',windsurf:'Windsurf',replit:'Replit',runway:'Runway',higgsfield:'Higgsfield',leonardo:'Leonardo AI',elevenlabs:'ElevenLabs',heygen:'HeyGen',canva:'Canva',figma:'Figma',adobe:'Adobe',notion:'Notion',slack:'Slack',zoom:'Zoom',dropbox:'Dropbox',miro:'Miro',linear:'Linear',framer:'Framer',webflow:'Webflow',zapier:'Zapier',make:'Make',n8n:'n8n Cloud'};
  const logoRows=[[
    ['ChatGPT'],['Claude','anthropic'],['Gemini','googlegemini'],['Microsoft Copilot'],['Perplexity','perplexity'],['Cursor'],['GitHub Copilot','githubcopilot'],['Windsurf'],['Replit','replit'],['Notion','notion'],['Slack'],['Figma','figma'],['Zoom','zoom']
  ],[
    ['Midjourney'],['Runway'],['Higgsfield'],['Leonardo AI'],['ElevenLabs','elevenlabs'],['HeyGen'],['Canva'],['Adobe'],['Dropbox','dropbox'],['Miro','miro'],['Linear','linear'],['Framer','framer'],['Webflow','webflow'],['Zapier','zapier'],['Make','make'],['n8n Cloud','n8n']
  ]];
  const logoMarquee=document.getElementById('logoMarquee');
  if(logoMarquee) logoRows.forEach((row,rowIndex)=>{const lane=document.createElement('div');lane.className=`logo-lane${rowIndex?' reverse':''}`;[...row,...row].forEach(([name,icon],index)=>{const item=document.createElement('span');item.className='brand-item';if(index>=row.length)item.setAttribute('aria-hidden','true');item.innerHTML=icon?`<img src="./logos/${icon}.svg" alt="" width="20" height="20"><span>${name}</span>`:`<i class="brand-letter">${name.slice(0,1)}</i><span>${name}</span>`;lane.append(item)});logoMarquee.append(lane)});
  const serviceSelect=document.getElementById('service'); let otherInput;
  if(serviceSelect){
    const group=document.createElement('optgroup'); group.label='그 밖의 해외 AI·SaaS';
    Object.entries(serviceNames).forEach(([value,name])=>group.append(new Option(name,value)));
    group.append(new Option('목록에 없는 다른 서비스','other')); serviceSelect.append(group);
    const label=document.createElement('label'); label.className='other-service'; label.innerHTML='서비스 이름을 직접 입력하세요<input id="otherService" maxlength="80" placeholder="예: Descript, Gamma, Synthesia">'; serviceSelect.closest('label').after(label); otherInput=label.querySelector('input');
    serviceSelect.addEventListener('change',()=>label.classList.toggle('show',serviceSelect.value==='other'));
    const guideLabel=document.querySelector('.service-links span'); if(guideLabel) guideLabel.textContent='상세 가이드를 먼저 준비한 서비스';
  }
  const situations={trial:'무료체험이 유료로 바뀐 시각과 사용 여부를 적으세요.',annual:'월 결제로 생각한 근거와 연 결제로 청구된 화면을 준비하세요.',aftercancel:'해지 확인 메일이나 화면, 해지한 날짜를 준비하세요.',duplicate:'두 결제의 날짜·금액·거래번호를 나란히 준비하세요.',unknown:'카드사에 표시된 가맹점명과 승인번호를 먼저 확인하세요.'};
  const channels={apple:['Apple에서 환불 요청','https://reportaproblem.apple.com/'],google:['Google Play 주문내역에서 문제 신고','https://play.google.com/store/account/orderhistory']};
  const btn=document.getElementById('makePlan'); if(btn) btn.addEventListener('click',()=>{
    const svc=serviceSelect.value,sit=document.getElementById('situation').value,ch=document.getElementById('channel').value,isDetailed=Boolean(official[svc]);
    const name=svc==='other'?(otherInput.value.trim()||'선택한 서비스'):(official[svc]?.name||serviceNames[svc]);
    const s=official[svc]||{name,manage:'./blog-how-to-cancel.html',support:'./blog-refund-email.html'};
    const d=date.value?new Date(date.value+'T00:00:00'):new Date(),days=Math.max(0,Math.floor((new Date()-d)/86400000)); let first,href;
    if(channels[ch]) [first,href]=channels[ch]; else if(ch==='unknown'){first='카드 영수증·이메일에서 결제 경로 확인';href='./blog-card-statement.html'} else if(isDetailed){first=`${s.name} 결제 관리에서 자동갱신 중지`;href=s.manage} else {first=`${s.name}의 Account·Billing에서 자동갱신 중지`;href='./blog-how-to-cancel.html'}
    const requestHref=(svc==='chatgpt'&&ch==='google')?s.support:(ch==='web'?s.support:href),requestLabel=isDetailed?'공식 문의 경로 열기':'공식 Help·Support 찾는 순서 보기';
    document.getElementById('actionPlan').innerHTML=`<div class="plan-head"><span>결제 후 ${days}일</span><b>${s.name}에서 지금 할 일</b></div><ol><li><b>추가 결제를 먼저 막습니다.</b><a href="${href}" target="_blank" rel="noopener">${first} →</a></li><li><b>요청에 필요한 근거를 모읍니다.</b><p>${situations[sit]} 카드 전체 번호·CVC·비밀번호는 보내지 마세요.</p></li><li><b>결제를 처리한 곳의 공식 경로로 문의합니다.</b><a href="${requestHref}" target="_blank" rel="noopener">${requestLabel} →</a></li><li><b>답변과 다음 결제일을 기록합니다.</b><p>환불 여부는 서비스 정책·결제 경로·사용 상태에 따라 달라집니다.</p></li></ol><div class="plan-note">돈나가요는 특정 서비스 전용이 아닙니다. 상세 링크가 아직 없는 서비스도 같은 순서로 처리하고, 다음 결제일을 직접 등록해 관리할 수 있습니다. 환불 성공은 보장하거나 대행하지 않습니다.</div>`;
  });
})();
