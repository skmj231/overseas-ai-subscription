/* Donna · onboarding.js — 설치 직후 한 번 여는 화면
 *
 * 세 화면뿐이다: 어떤 알림이 오는지(예시) → 첫 구독 하나 → 끝.
 * 로고 카드를 누르면 금액·주기·해지 화면이 채워지고, 사용자는 날짜 하나만 고른다.
 * 예시 화면의 내용은 실제 구독으로 저장하지 않는다.
 */
const WT = self.SVSTWatch;
const PS = self.SVSTPresets;
const $ = id => document.getElementById(id);
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO = () => iso(new Date());
const koDate = s => { if (!s) return "확인 필요"; const [y, m, d] = s.split("-").map(Number); return `${m}월 ${d}일 ${DOW[new Date(y, m - 1, d).getDay()]}요일`; };
const mdText = s => { if (!s) return ""; const [, m, d] = s.split("-").map(Number); return `${m}월 ${d}일`; };
const won = n => n == null ? "" : "₩" + Math.round(n).toLocaleString("ko-KR");
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const show = id => { document.querySelectorAll(".step").forEach(el => el.classList.toggle("on", el.id === id)); scrollTo({ top: 0, behavior: "smooth" }); };

// ---------- 상태 ----------
const F = { kind: "sub", interval: "", channel: "web", preset: null, due: "" };
let RATES = null, PROFILE = null, LEAD = WT.LEAD_DEFAULT;
chrome.runtime.sendMessage({ type: "getRates" }, res => { if (res && res.rates) { RATES = res.rates; demoKrw(); krwPreview(); } });
chrome.storage.local.get(["profile", "settings"]).then(st => {
  PROFILE = st.profile || null;
  LEAD = { ...WT.LEAD_DEFAULT, ...((st.settings && st.settings.lead) || {}) };
});
const vatApplies = () => !(PROFILE && PROFILE.brn);

// ---------- 1. 예시 ----------
function demoKrw() { const k = WT.estimateKrw(20, "USD", RATES, { vat: true }); if (k) $("demo-krw").textContent = won(k); }

// ---------- 2. 서비스 격자 ----------
$("services").innerHTML = PS.search("", 8).map(p =>
  `<button type="button" data-preset="${esc(p.id)}">${PS.avatarHtml(p, 44)}<div style="min-width:0;width:100%"><div class="nm">${esc(p.short || p.name.replace(/\s*\(.*\)$/, ""))}</div><div class="pr">${p.currency === "KRW" ? won(p.amount) : esc(p.currency) + " " + p.amount} / ${p.interval === "year" ? "년" : "월"}</div></div></button>`).join("")
  + `<button type="button" class="plus" id="svc-plus"><span class="avatar">+</span><div class="nm">직접 입력</div></button>`;
$("services").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  $("services").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  if (b.id === "svc-plus") startManual(); else applyPreset(PS.LIST.find(p => p.id === b.dataset.preset));
});

function openSheet() { $("services").hidden = true; $("form").hidden = false; renderWeeks(); setDue(F.due); }
function startManual() {
  F.preset = null; $("service").value = ""; $("amount").value = ""; seg("intervals", "interval", "");
  $("name-wrap").classList.add("on"); $("adv").classList.add("on");
  openSheet(); renderPicked(); $("service").focus();
}
function applyPreset(p) {
  if (!p) return;
  F.preset = p.id;
  $("service").value = p.name; $("amount").value = p.amount; $("currency").value = p.currency;
  seg("intervals", "interval", p.interval);
  $("name-wrap").classList.remove("on"); $("adv").classList.remove("on");
  openSheet(); krwPreview();
}
$("reselect").addEventListener("click", () => { $("form").hidden = true; $("services").hidden = false; });

function seg(id, attr, v) {
  F[attr] = v;
  $(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset[attr] === v));
  if (attr === "kind") $("due-label").textContent = v === "trial" ? "무료 체험이 끝나는 날" : "다음 결제일";
  renderPicked(); submitLabel();
}
["kinds:kind", "intervals:interval", "channels:channel"].forEach(pair => {
  const [id, attr] = pair.split(":");
  $(id).addEventListener("click", e => { const b = e.target.closest(`[data-${attr}]`); if (b) seg(id, attr, b.dataset[attr]); });
});
$("service").addEventListener("input", () => { if (F.preset) { const p = PS.LIST.find(x => x.id === F.preset); if (p && p.name !== $("service").value.trim()) F.preset = null; } renderPicked(); });
$("picked-row").addEventListener("click", () => $("adv").classList.toggle("on"));
$("amount").addEventListener("input", krwPreview);
$("currency").addEventListener("change", krwPreview);
$("due").addEventListener("input", () => setDue($("due").value));
$("due-text").addEventListener("click", () => { try { $("due").showPicker(); } catch (e) { $("due").focus(); } });

function currentKrw() {
  const amt = parseFloat(String($("amount").value).replace(/[^\d.]/g, ""));
  if (isNaN(amt)) return null;
  return WT.estimateKrw(amt, $("currency").value, RATES, { vat: vatApplies() });
}
function krwPreview() {
  const amt = parseFloat(String($("amount").value).replace(/[^\d.]/g, ""));
  const k = currentKrw();
  $("krw").innerHTML = isNaN(amt) || $("currency").value === "KRW" || k == null ? "" :
    `카드에는 약 <b>${won(k)}</b> · 환율·해외수수료${vatApplies() ? "·부가세 10%" : ""} 포함`;
  renderPicked();
}
function renderPicked() {
  const name = $("service").value.trim();
  const p = F.preset ? PS.LIST.find(x => x.id === F.preset) : null;
  const amt = parseFloat(String($("amount").value).replace(/[^\d.]/g, ""));
  const cur = $("currency").value;
  const k = currentKrw();
  const cyc = F.interval === "year" ? "매년" : F.interval === "month" ? "매달" : "주기 미정";
  $("picked-row").innerHTML = `${PS.avatarHtml(p || { name: name || "?", color: "#8A8A91" }, 44)}
    <div class="m"><div class="nm">${esc(name || "서비스 이름")}</div><div class="s">${isNaN(amt) ? "금액 미정" : `${esc(cur)} ${amt}`} · ${cyc}${p ? " · 기본 요금" : ""}</div></div>
    <div class="krw">${k != null ? `<b>≈ ${won(k)}</b><small>환율·수수료${vatApplies() ? "·부가세" : ""} 포함</small>` : `<small>눌러서 금액 입력</small>`}</div>`;
}
function submitLabel() {
  const t = $("submit-text");
  if (!F.due || !F.interval) { t.textContent = F.kind === "trial" && !F.due ? "종료일을 골라 주세요" : "등록하기"; return; }
  const days = WT.alertDaysBefore({ interval: F.interval, kind: F.kind, auto: true }, LEAD);
  const words = days.map(x => x === 0 ? "당일" : `${x}일 전`);
  const when = words.length > 1 ? words.slice(0, -1).join(", ") + "과 " + words[words.length - 1] : words[0];
  t.textContent = `${mdText(F.due)} ${F.kind === "trial" ? "종료" : "결제"} · ${when}에 알림`;
}

/* 날짜 띠: 오늘이 있는 주부터 12주 */
function renderWeeks() {
  const box = $("week");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(today.getDate() - today.getDay());
  const tIso = iso(today);
  let html = "";
  for (let wk = 0; wk < 12; wk++) {
    html += `<div class="w7">${DOW.map((d, i) => `<div class="dow ${i === 0 ? "sun" : ""}">${d}</div>`).join("")}`;
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + wk * 7 + i);
      const v = iso(d); const past = v < tIso;
      html += `<button type="button" class="d ${v === F.due ? "on" : ""} ${past ? "past" : ""}" data-d="${v}" ${past ? "disabled" : ""}>${d.getDate()}</button>`;
    }
    html += `</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-d]").forEach(b => b.addEventListener("click", () => setDue(b.dataset.d)));
}
function setDue(v) {
  F.due = v || "";
  $("due").value = F.due;
  $("due-text").textContent = F.due ? koDate(F.due) : "달력에서 고르기";
  $("week").querySelectorAll("[data-d]").forEach(b => b.classList.toggle("on", b.dataset.d === F.due));
  const sel = $("week").querySelector(".d.on");
  if (sel) $("week").scrollLeft = sel.closest(".w7").offsetLeft - $("week").offsetLeft;
  submitLabel();
}

$("start").addEventListener("click", () => show("register"));
$("back").addEventListener("click", () => show("demo"));
$("skip").addEventListener("click", async () => {
  await chrome.storage.local.set({ onboardingCompleted: { at: Date.now(), result: "demo-only" } });
  openPanel();
});
$("add-another").addEventListener("click", () => {
  $("form").reset(); F.preset = null; F.due = "";
  $("services").querySelectorAll("button").forEach(b => b.classList.remove("on"));
  seg("kinds", "kind", "sub"); seg("intervals", "interval", ""); seg("channels", "channel", "web");
  $("form").hidden = true; $("services").hidden = false;
  show("register");
});
$("open-panel").addEventListener("click", openPanel);

/* 사이드패널은 사용자가 누른 직후에만 열 수 있다. 백그라운드로 보내면 그 클릭 권한이 따라간다. */
function openPanel() {
  if (chrome.sidePanel && chrome.sidePanel.open) { chrome.runtime.sendMessage({ type: "openPanel" }); setTimeout(() => window.close(), 400); }
  else location.href = "popup.html";
}

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("service").value.trim();
  if (!name) { $("error").textContent = "서비스를 누르거나 이름을 적어 주세요."; $("service").focus(); return; }
  const due = F.due || null;
  if (F.kind === "trial" && !due) { $("error").textContent = "무료 체험이 끝나는 날을 골라 주세요. 그날부터 돈이 나갑니다."; return; }
  const raw = $("amount").value.trim().replace(/,/g, "");
  const amount = raw === "" ? null : Number(raw);
  if (raw !== "" && (!Number.isFinite(amount) || amount <= 0)) { $("error").textContent = "금액을 숫자로 확인해 주세요."; return; }
  $("error").textContent = "";

  const cur = $("currency").value;
  const preset = F.preset ? PS.LIST.find(p => p.id === F.preset) : null;
  const made = WT.makeWatch({
    name, interval: F.interval || null, kind: F.kind, channel: F.channel, nextDue: due,
    amountOrig: amount, currency: cur,
    amountKrw: amount == null ? null : WT.estimateKrw(amount, cur, RATES, { vat: vatApplies() }),
    manageUrl: preset ? preset.manageUrl : null, presetId: preset ? preset.id : null,
    refundUrl: preset ? preset.refundUrl : null, refundNote: preset ? preset.refundNote : null,
    auto: true, source: "manual"
  }, todayISO());

  const st = await chrome.storage.local.get(["watch"]);
  const watch = st.watch || {};
  const normalized = name.toLocaleLowerCase().replace(/\s+/g, "");
  const existing = Object.keys(watch).find(k => String(watch[k].name || "").toLocaleLowerCase().replace(/\s+/g, "") === normalized);
  const key = existing || ("w" + Date.now().toString(36));
  watch[key] = existing ? { ...watch[key], ...made } : made;
  await chrome.storage.local.set({ watch, onboardingCompleted: { at: Date.now(), result: "registered" } });

  const complete = !!made.interval && !!made.due;
  const days = WT.alertDaysBefore(made, LEAD);
  const cyc = made.interval === "year" ? "매년" : made.interval === "month" ? "매달" : "주기 확인 필요";
  const amtTxt = amount != null ? `${cur} ${amount}` : "";
  const krw = made.amountKrw != null ? ` · ≈ ${won(made.amountKrw)}` : "";
  const alertDates = complete ? days.map(d => { const x = new Date(made.due); x.setDate(x.getDate() - d); return `<span class="tag green">${x.getMonth() + 1}월 ${x.getDate()}일</span>`; }).join("") : "";
  $("result").innerHTML = `<div class="head">${PS.avatarHtml(preset || { name, color: "#8A8A91" }, 52)}
      <div><div class="nm">${esc(name)}</div><div class="s">${made.kind === "trial" ? "무료 체험" : cyc}${amtTxt ? " · " + esc(amtTxt) : ""}${krw}</div></div></div>
    <div class="box">
      <div class="r"><span>${made.kind === "trial" ? "체험 종료" : "다음 결제"}</span><b>${complete ? koDate(made.due) : "확인 필요"}</b></div>
      <div class="r"><span>알림</span>${complete ? `<span class="tags">${alertDates}</span>` : `<b>날짜를 채우면 시작</b>`}</div>
      ${made.refundNote ? `<div class="r"><span>환불</span><b>${esc(made.refundNote)}</b></div>` : ""}
    </div>
    <button type="button" class="pill gray" id="ics"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#111114" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="4"></rect><path d="M16 2v4M8 2v4M3 10h18"></path></svg>캘린더에 넣기</button>`;
  $("ics").addEventListener("click", () => downloadIcs(made, key));
  show("done");
});

/* 캘린더 파일 한 장. 패널의 것과 같은 규격이지만 방금 등록한 구독 하나만 담는다. */
function downloadIcs(w, key) {
  if (!w.due || !w.interval) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const d = w.due.replace(/-/g, "");
  const escI = v => String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const days = WT.alertDaysBefore(w, LEAD);
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Donna//KR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:해외 구독 결제일",
    "BEGIN:VEVENT", `UID:svst-${encodeURIComponent(key)}-${d}@overseas-ai-subscription`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`,
    `RRULE:FREQ=${w.interval === "year" ? "YEARLY" : "MONTHLY"};INTERVAL=1`,
    `SUMMARY:${escI(w.name + (w.kind === "trial" ? " 무료 체험 종료" : " 자동 결제"))}`];
  for (const day of days) L.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escI(w.name)}`, `TRIGGER:-P${day}D`, "END:VALARM");
  L.push("END:VEVENT", "END:VCALENDAR");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([L.join("\r\n") + "\r\n"], { type: "text/calendar;charset=utf-8" }));
  a.download = `Donna_${w.name}.ics`; a.click(); URL.revokeObjectURL(a.href);
}
