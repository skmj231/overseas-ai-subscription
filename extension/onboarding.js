/* 돈나가요 · onboarding.js — 설치 직후 한 번 여는 화면
 *
 * 세 화면뿐이다: 어떤 알림이 오는지(예시) → 첫 구독 하나 → 끝.
 * 사용자가 적는 것은 '다음 결제일' 하나로 줄인다. 이름을 누르면 나머지는 presets.js가 채운다.
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
  return `${y}년 ${m}월 ${d}일`;
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
chrome.runtime.sendMessage({ type: "getRates" }, res => {
  if (res && res.rates) { RATES = res.rates; demoKrw(); krwPreview(); }
});
chrome.storage.local.get("profile").then(st => { PROFILE = st.profile || null; });
const vatApplies = () => !(PROFILE && PROFILE.brn);

// ---------- 1. 예시 ----------
const demoDue = addDays(5);
$("demo-due").textContent = koDate(demoDue);
$("demo-notice").textContent = `${koDate(addDays(0))}과 ${koDate(addDays(4))}에 미리 알려드려요.`;
function demoKrw() {
  const k = WT.estimateKrw(20, "USD", RATES, { vat: true });
  if (k) $("demo-krw").textContent = won(k);
}

// ---------- 2. 등록 ----------
function seg(id, attr, v) {
  F[attr] = v;
  $(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset[attr] === v));
  if (attr === "kind") $("due-label").innerHTML = v === "trial"
    ? "무료 체험이 끝나는 날 <small>이날부터 돈이 나갑니다</small>"
    : "다음 결제일 <small>선택</small>";
}
["kinds:kind", "intervals:interval", "channels:channel"].forEach(pair => {
  const [id, attr] = pair.split(":");
  $(id).addEventListener("click", e => {
    const b = e.target.closest(`[data-${attr}]`); if (!b) return;
    seg(id, attr, b.dataset[attr]);
  });
});

$("services").innerHTML = PS.search("", 10).map(p =>
  `<button type="button" data-preset="${esc(p.id)}"><b>${esc(p.name)}</b><small>${esc(p.currency)} ${p.amount.toLocaleString("en-US")}/${p.interval === "year" ? "년" : "월"}</small></button>`).join("");
$("services").addEventListener("click", e => {
  const b = e.target.closest("[data-preset]"); if (!b) return;
  applyPreset(PS.LIST.find(p => p.id === b.dataset.preset));
});
$("service").addEventListener("input", () => {
  const p = PS.find($("service").value);
  if (F.preset && (!p || p.id !== F.preset)) { F.preset = null; $("preset-note").textContent = ""; markChip(null); }
});
$("amount").addEventListener("input", krwPreview);
$("currency").addEventListener("change", krwPreview);

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
  $("preset-note").textContent = `기본 요금을 넣었습니다. 실제 결제액이 다르면 고쳐 주세요.`
    + (p.appStore ? " 앱에서 결제했다면 아래에서 App Store·Google Play를 골라 주세요." : "");
  krwPreview();
  $("due").focus();
}

function krwPreview() {
  const amt = parseFloat(String($("amount").value).replace(/[^\d.]/g, ""));
  const cur = $("currency").value;
  if (isNaN(amt) || cur === "KRW") { $("krw").textContent = ""; return; }
  const k = WT.estimateKrw(amt, cur, RATES, { vat: vatApplies() });
  $("krw").innerHTML = k == null ? "" :
    `카드에는 약 <b>${won(k)}</b>이 찍힙니다 · 환율 + 해외수수료 1.3%${vatApplies() ? " + 부가세 10%" : ""}`;
}

$("start").addEventListener("click", () => show("register"));
$("back").addEventListener("click", () => show("demo"));
$("skip").addEventListener("click", async () => {
  await chrome.storage.local.set({ onboardingCompleted: { at: Date.now(), result: "demo-only" } });
  openPanel();
});
$("add-another").addEventListener("click", () => {
  $("form").reset(); F.preset = null; markChip(null); $("preset-note").textContent = ""; $("krw").textContent = "";
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
  if (!name) { $("error").textContent = "서비스 이름만 알려주세요."; $("service").focus(); return; }
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

  const st = await chrome.storage.local.get(["watch", "settings"]);
  const watch = st.watch || {};
  const normalized = name.toLocaleLowerCase().replace(/\s+/g, "");
  const existing = Object.keys(watch).find(k => String(watch[k].name || "").toLocaleLowerCase().replace(/\s+/g, "") === normalized);
  const key = existing || ("w" + Date.now().toString(36));
  watch[key] = existing ? { ...watch[key], ...made } : made;
  await chrome.storage.local.set({ watch, onboardingCompleted: { at: Date.now(), result: "registered" } });

  const lead = (st.settings && st.settings.lead) || WT.LEAD_DEFAULT;
  const complete = !!made.interval && !!made.due;
  const days = WT.alertDaysBefore(made, lead);
  const when = days.map(d => d === 0 ? "당일" : `${d}일 전`).join(" · ");
  const amt = WT.amountText(made);
  const cyc = made.interval === "year" ? "매년" : made.interval === "month" ? "매달" : "결제 주기 확인 필요";
  const chan = made.channel !== "web" && PS.CHANNEL[made.channel] ? ` · ${PS.CHANNEL[made.channel].label}` : "";
  $("result").innerHTML = `<strong>${esc(name)}</strong>
    <p>${made.kind === "trial" ? "무료 체험 종료" : cyc}${amt ? " · " + esc(amt) : ""}${chan}<br>${made.kind === "trial" ? "체험 종료" : "다음 결제"} ${koDate(made.due)}</p>`
    + (complete
      ? `<div class="schedule">${made.kind === "trial" ? "체험 종료" : "결제"} ${when}에 미리 알려드릴게요.${made.refundNote ? `<br><small>환불: ${esc(made.refundNote)}</small>` : ""}</div>`
      : `<div class="schedule">주기나 날짜를 몰라 ‘확인 필요’로 남겨두었습니다. 패널에서 채우면 그때부터 알림이 갑니다.</div>`);
  show("done");
});
