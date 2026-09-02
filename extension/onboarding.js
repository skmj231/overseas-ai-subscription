const WT = self.SVSTWatch;
const $ = id => document.getElementById(id);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const addDays = n => {
  const d = new Date(); d.setDate(d.getDate()+n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const koDate = s => {
  if (!s) return "확인 필요";
  const [y,m,d] = s.split("-").map(Number);
  return `${y}년 ${m}월 ${d}일`;
};
const show = id => {
  document.querySelectorAll(".step").forEach(el => el.classList.toggle("on",el.id===id));
  scrollTo({top:0,behavior:"smooth"});
};

const popular = ["ChatGPT","Claude","Cursor","Midjourney","Gemini","Microsoft Copilot","Perplexity","GitHub Copilot","Canva","Figma","Notion","기타 서비스"];
$("services").innerHTML = popular.map(x=>`<button type="button" data-name="${x}">${x}</button>`).join("");
$("services").addEventListener("click",e=>{
  const b=e.target.closest("[data-name]"); if(!b)return;
  $("service").value=b.dataset.name==="기타 서비스"?"":b.dataset.name;
  $("service").focus();
});

const demoDue=addDays(20);
$("demo-due").textContent=koDate(demoDue);
$("demo-notice").textContent=`${koDate(addDays(15))}과 ${koDate(addDays(19))}에 미리 알려드려요.`;

let interval="";
$("intervals").addEventListener("click",e=>{
  const b=e.target.closest("[data-interval]"); if(!b)return;
  interval=b.dataset.interval;
  $("intervals").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b));
});

$("start").addEventListener("click",()=>show("register"));
$("back").addEventListener("click",()=>show("demo"));
$("skip").addEventListener("click",async()=>{
  await chrome.storage.local.set({onboardingCompleted:{at:Date.now(),result:"demo-only"}});
  window.close();
});
$("add-another").addEventListener("click",()=>{
  $("form").reset(); interval="";
  $("intervals").querySelectorAll("button").forEach(x=>x.classList.remove("on"));
  show("register");
});
$("open-list").addEventListener("click",()=>location.href="popup.html");

$("form").addEventListener("submit",async e=>{
  e.preventDefault();
  const name=$("service").value.trim();
  if(!name){$("error").textContent="서비스 이름만 알려주세요.";$("service").focus();return;}
  const due=$("due").value||null;
  const raw=$("amount").value.trim().replace(/,/g,"");
  const amount=raw===""?null:Number(raw);
  if(raw!==""&&(!Number.isFinite(amount)||amount<=0)){$("error").textContent="금액을 숫자로 확인해 주세요.";return;}
  $("error").textContent="";
  const today=todayISO();
  const made=WT.makeWatch({name,interval:interval||null,nextDue:due,amountOrig:amount,
    amountKrw:$("currency").value==="KRW"?amount:null,currency:$("currency").value,auto:true,source:"manual"},today);
  const st=await chrome.storage.local.get("watch");
  const watch=st.watch||{};
  const normalized=name.toLocaleLowerCase().replace(/\s+/g,"");
  const existing=Object.keys(watch).find(k=>String(watch[k].name||"").toLocaleLowerCase().replace(/\s+/g,"")===normalized);
  const key=existing||("w"+Date.now().toString(36));
  watch[key]=existing?{...watch[key],...made}:made;
  await chrome.storage.local.set({watch,onboardingCompleted:{at:Date.now(),result:"registered"}});

  const complete=!!made.interval&&!!made.due;
  $("result").innerHTML=`<strong>${name}</strong><p>${made.interval==="year"?"매년":made.interval==="month"?"매달":"결제 주기 확인 필요"} · 다음 결제 ${koDate(made.due)}</p>`+
    (complete?`<div class="schedule">${made.interval==="year"?"14일 전과 3일 전":"5일 전과 1일 전"}에 미리 알려드릴게요.</div>`:
      `<div class="schedule">모르는 내용은 ‘확인 필요’로 남겨두었습니다. 목록에서 언제든 완성할 수 있어요.</div>`);
  show("done");
});
