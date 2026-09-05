/* Donna · onboarding.js — 설치 직후 한 번 여는 화면
 *
 * 세 화면뿐이다: 어떤 알림이 오는지(예시) → 첫 구독 하나 → 끝.
 * 사용자가 적는 것은 '다음 결제일' 하나로 줄인다. 로고를 누르면 나머지는 presets.js가 채운다.
 * 예시 화면의 내용은 실제 구독으로 저장하지 않는다.
 */
const WT = self.SVSTWatch;
const PS = self.SVSTPresets;
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
  const day = ["일","월","화","수","목","금","토"][new Date(y, m-1, d).getDay()];
  return `${m}월 ${d}일 ${day}요일`;
};
const won = n => n == null ? "" : "₩" + Math.round(n).toLocaleString("ko-KR");
const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const STEP_INDEX = { demo: 0, register: 1, done: 2 };
const show = id => {
  document.querySelectorAll(".step").forEach(el => el.classList.toggle("on", el.id === id));
  document.querySelectorAll(".steps li").forEach((li, i) => li.classList.toggle("on", i <= STEP_INDEX[id]));
  scrollTo({ top: 0, behavior: "smooth" });
};

// ---------- 상태 ----------
const F = { kind: "sub", interval: "", channel: "web", preset: null };
let RATES = null;
let PROFILE = null;
let LEAD = WT.LEAD_DEFAULT;
chrome.runtime.sendMessage({ type: "getRates" }, res => {
  if (res && res.rates) { RATES = res.rates; demoKrw(); krwPreview(); }
});
chrome.storage.local.get(["profile", "settings"]).then(st => {
  PROFILE = st.profile || null;
  LEAD = { ...WT.LEAD_DEFAULT, ...((st.settings && st.settings.lead) || {}) };
});
const vatApplies = () => !(PROFILE && PROFILE.brn);

// ---------- 1. 예시 ----------
$("demo-due").textContent = koDate(addDays(5));
$("demo-notice").textContent = `${koDate(addDays(0))}과 ${koDate(addDays(4))}에 미리 알려드려요.`;
function demoKrw() {
  const k = WT.estimateKrw(20, "USD", RATES, { vat: true });
  if (k) $("demo-krw").textContent = won(k);
}

// ---------- 2. 등록 ----------
function seg(id, attr, v) {
  F[attr] = v;
  $(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset[attr] === v));
  if (attr === "kind") $("due-label").textContent = v === "trial" ? "무료 체험이 끝나는 날" : "다음 결제일";
  submitLabel();
}
["kinds:kind", "intervals:interval", "channels:channel"].forEach(pair => {
  const [id, attr] = pair.split(":");
  $(id).addEventListener("click", e => {
    const b = e.target.closest(`[data-${attr}]`); if (!b) return;
    seg(id, attr, b.dataset[attr]);
  });
});

$("services").innerHTML = PS.search("", 8).map(p =>
  `<button type="button" data-preset="${esc(p.id)}">${PS.avatarHtml(p, 56)}<span>${esc(p.name.split(" ")[0])}</span></button>`).join("");
$("services").addEventListener("click", e => {
  const b = e.target.closest("[data-preset]"); if (!b) return;
  applyPreset(PS.LIST.find(p => p.id === b.dataset.preset));
});
$("service").addEventListener("input", () => {
  const p = PS.find($("service").value);
  if (F.preset && (!p || p.id !== F.preset)) { F.preset = null; markChip(null); }
  renderPicked();
});
$("amount").addEventListener("input", krwPreview);
$("currency").addEventListener("change", krwPreview);
$("due").addEventListener("input", submitLabel);

function markChip(id) {
  $("services").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.preset === id));
}

function applyPreset(p) {
  if (!p) return;
  F.preset = p.id;
  markChip(p.id);
  $("service").value = p.name;
  $("amount").value = p.amount;
  $("currency").value = p.currency;
  seg("intervals", "interval", p.interval);
  krwPreview();
  $("due").focus();
}

function currentKrw() {
  const amt = parseFloat(String($("amount").value).replace(/[^\d.]/g, ""));
  if (isNaN(amt)) return null;
  return WT.estimateKrw(amt, $("currency").value, RATES, { vat: vatApplies() });
}

function krwPreview() {
  const amt = parseFloat(String($("amount").value).replace(/[^\d.]/g, ""));
  const cur = $("currency").value;
  const k = currentKrw();
  $("krw").innerHTML = isNaN(amt) || cur === "KRW" || k == null ? "" :
    `카드에는 약 <b>${won(k)}</b> · 환율·해외수수료${vatApplies() ? "·부가세 10%" : ""} 포함`;
  renderPicked();
}

/* 고른 서비스 요약 한 장. */
function renderPicked() {
  const el = $("picked");
  const name = $("service").value.trim();
  if (!name) { el.innerHTML = ""; return; }
  const p = F.preset ? PS.LIST.find(x => x.id === F.preset) : null;
  const amt = parseFloat(String($("amount").value).replace(/[^\d.]/g, ""));
  const cur = $("currency").value;
  const k = currentKrw();
  const cyc = F.interval === "year" ? "매년" : F.interval === "month" ? "매달" : "주기 미정";
  el.innerHTML = `${PS.avatarHtml(p || { name, color: "#8A8A91" }, 44)}
    <div class="m"><div class="nm">${esc(name)}</div><div class="s">${isNaN(amt) ? "금액 미정" : `${esc(cur)} ${amt}`} · ${cyc}${p ? " · 기본 요금" : ""}</div></div>
    <div class="krw">${k != null ? `<b>≈ ${won(k)}</b><small>환율·수수료${vatApplies() ? "·부가세" : ""} 포함</small>` : ""}</div>`;
}

/* 등록 버튼에 "언제 알릴지"를 미리 적는다. */
function submitLabel() {
  const due = $("due").value;
  const b = $("submit");
  if (!due || !F.interval) { b.textContent = F.kind === "trial" && !due ? "종료일을 넣어 주세요" : "등록하기"; return; }
  const days = WT.alertDaysBefore({ interval: F.interval, kind: F.kind, auto: true }, LEAD);
  const [, m, d] = due.split("-").map(Number);
  b.textContent = `${m}월 ${d}일 ${F.kind === "trial" ? "종료" : "결제"} · ${days.map(x => x === 0 ? "당일" : `${x}일 전`).join(" · ")} 알림`;
}

$("start").addEventListener("click", () => show("register"));
$("back").addEventListener("click", () => show("demo"));
$("skip").addEventListener("click", async () => {
  await chrome.storage.local.set({ onboardingCompleted: { at: Date.now(), result: "demo-only" } });
  openPanel();
});
$("add-another").addEventListener("click", () => {
  $("form").reset(); F.preset = null; markChip(null); $("krw").textContent = ""; $("picked").innerHTML = "";
  seg("kinds", "kind", "sub"); seg("intervals", "interval", ""); seg("channels", "channel", "web");
  show("register");
});
$("open-panel").addEventListener("click", openPanel);

/* 사이드패널은 사용자가 누른 직후에만 열 수 있다. 백그라운드로 보내면 그 클릭 권한이 따라간다.
   패널이 없는 브라우저면 같은 화면을 이 탭에서 연다. */
function openPanel() {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.runtime.sendMessage({ type: "openPanel" });
    setTimeout(() => window.close(), 400);
  } else {
    location.href = "popup.html";
  }
}

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("service").value.trim();
  if (!name) { $("error").textContent = "서비스를 누르거나 이름을 적어 주세요."; $("service").focus(); return; }
  const due = $("due").value || null;
  if (F.kind === "trial" && !due) { $("error").textContent = "무료 체험이 끝나는 날을 넣어 주세요. 그날부터 돈이 나갑니다."; $("due").focus(); return; }
  const raw = $("amount").value.trim().replace(/,/g, "");
  const amount = raw === "" ? null : Number(raw);
  if (raw !== "" && (!Number.isFinite(amount) || amount <= 0)) { $("error").textContent = "금액을 숫자로 확인해 주세요."; return; }
  $("error").textContent = "";

  const cur = $("currency").value;
  const preset = F.preset ? PS.LIST.find(p => p.id === F.preset) : null;
  const today = todayISO();
  const made = WT.makeWatch({
    name, interval: F.interval || null, kind: F.kind, channel: F.channel, nextDue: due,
    amountOrig: amount, currency: cur,
    amountKrw: amount == null ? null : WT.estimateKrw(amount, cur, RATES, { vat: vatApplies() }),
    manageUrl: preset ? preset.manageUrl : null, presetId: preset ? preset.id : null,
    refundUrl: preset ? preset.refundUrl : null, refundNote: preset ? preset.refundNote : null,
    auto: true, source: "manual"
  }, today);

  const st = await chrome.storage.local.get(["watch"]);
  const watch = st.watch || {};
  const normalized = name.toLocaleLowerCase().replace(/\s+/g, "");
  const existing = Object.keys(watch).find(k => String(watch[k].name || "").toLocaleLowerCase().replace(/\s+/g, "") === normalized);
  const key = existing || ("w" + Date.now().toString(36));
  watch[key] = existing ? { ...watch[key], ...made } : made;
  await chrome.storage.local.set({ watch, onboardingCompleted: { at: Date.now(), result: "registered" } });

  const complete = !!made.interval && !!made.due;
  const days = WT.alertDaysBefore(made, LEAD);
  const amt = WT.amountText(made);
  const cyc = made.interval === "year" ? "매년" : made.interval === "month" ? "매달" : "주기 확인 필요";
  const chan = made.channel !== "web" && PS.CHANNEL[made.channel] ? ` · ${PS.CHANNEL[made.channel].label}` : "";
  const alertDates = complete ? days.map(d => { const x = new Date(made.due); x.setDate(x.getDate() - d);
    return `<span class="tag green">${x.getMonth()+1}월 ${x.getDate()}일</span>`; }).join("") : "";
  $("result").innerHTML = `<div class="head">${PS.avatarHtml(preset || { name, color: "#8A8A91" }, 52)}
      <div><div class="nm">${esc(name)}</div><div class="s">${made.kind === "trial" ? "무료 체험" : cyc}${amt ? " · " + esc(amt) : ""}${chan}</div></div></div>
    <div class="box">
      <div class="r"><span>${made.kind === "trial" ? "체험 종료" : "다음 결제"}</span><b>${complete ? koDate(made.due) : "확인 필요"}</b></div>
      <div class="r"><span>알림</span>${complete ? `<span class="tags">${alertDates}</span>` : `<b>날짜를 채우면 시작</b>`}</div>
      ${made.refundNote ? `<div class="r"><span>환불</span><b>${esc(made.refundNote)}</b></div>` : ""}
    </div>`;
  show("done");
});
