/* 해외AI구독관리 · 기록함 — 확정 원장 + 구독 예측 + 할 일 + 분기 자료 내보내기
 * 판정 규칙은 rules.js에만 있다. 여기서는 표시와 파일 만들기만 한다.
 */
const R = self.SVST;
const { SUPPLIER: SUP, CHARGE: CH, TAX_TYPE: T } = R;

let ST = { ledger: [], subs: {}, stats: { saved: 0 }, tasks: [], profile: null, suppliers: {},
           settings: { notify: true, lead: self.SVSTWatch.LEAD_DEFAULT } };
let QUARTER = "this";
let pendingExport = null;

const won = n => n == null ? "-" : "₩" + Math.round(n).toLocaleString("ko-KR");
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/* 서비스명과 적요는 결제 페이지의 글자에서 왔다. 즉 우리가 쓴 글이 아니다.
   그걸 그대로 innerHTML에 넣으면 남의 페이지가 이 확장 화면에 태그를 심을 수 있다.
   실행은 CSP가 막지만 화면을 흉내 내는 것까지는 막지 못하므로, 넣기 전에 중화한다. */
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function quarterRange(which) {
  const now = new Date();
  let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3);
  if (which === "last") { q -= 1; if (q < 0) { q = 3; y -= 1; } }
  const from = `${y}-${String(q * 3 + 1).padStart(2, "0")}-01`;
  const toM = q * 3 + 3;
  const to = `${y}-${String(toM).padStart(2, "0")}-${new Date(y, toM, 0).getDate()}`;
  return { from, to, label: `${y}_${q + 1}분기`, human: `${y}년 ${q + 1}분기` };
}

/* 예측 행은 저장하지 않는다. lastPaid가 갱신되면 저절로 사라진다.
   단, 이미 확정 기록이 있는 날짜는 예측하지 않는다 — 안 그러면 같은 결제가 두 줄로 보인다. */
function alreadyLogged(mkey, date, s) {
  return ST.ledger.some(r => R.sameRecord(r, {
    mkey, date, currency: s.currency, amountOrig: s.amountOrig, amountKrw: s.amountKrw
  }));
}

function computePredicted() {
  const rows = [];
  const today = todayISO();
  for (const mkey of Object.keys(ST.subs)) {
    const s = ST.subs[mkey];
    if (!s.lastPaid || !s.interval || s.trial) continue;
    let next = R.addInterval(s.lastPaid, s.interval);
    let guard = 0;
    while (next <= today && guard++ < 24) {
      if (alreadyLogged(mkey, next, s)) { next = R.addInterval(next, s.interval); continue; }
      rows.push({
        id: `est-${mkey}-${next}`, date: next, merchant: s.merchant, mkey, desc: s.desc || "",
        currency: s.currency, amountOrig: s.amountOrig, amountKrw: s.amountKrw,
        krwBasis: s.currency === "KRW" ? "actual" : "estimated", vatKrw: s.vatKrw,
        supplier: s.supplier || SUP.UNKNOWN, charge: CH.RENEWAL,
        status: "estimated", interval: s.interval
      });
      next = R.addInterval(next, s.interval);
    }
  }
  return rows;
}

function visibleRows() {
  const all = [...ST.ledger.map(r => ({ ...r })), ...computePredicted()];
  all.sort((a, b) => b.date.localeCompare(a.date));
  if (QUARTER === "all") return all;
  const { from, to } = quarterRange(QUARTER);
  return all.filter(r => r.date >= from && r.date <= to);
}

// ---------- 할 일 ----------
/* 할 일은 '우리 화면에서 하는 일'이 아니라 '그 서비스 사이트에 가서 하는 일'이다.
   그 뜻이 문장에서 드러나지 않으면 사용자는 여기 어딘가에 입력란이 있는 줄 알고 헤맨다. */
const TASK_TEXT = {
  register: (m) => `<b>${m}</b> 사이트의 결제 설정에서 사업자번호 입력. 다음 결제부터 부가세 0원`,
  invoice: (m) => `<b>${m}</b>에 세금계산서 발급 요청. 국내 사업자라 공제 대상입니다`,
  supplier: (m) => `<b>${m}</b>가 국내인지 해외인지 확인. 세무사에게 물어보세요`
};

const TASK_HOW = {
  register: "각 서비스의 Billing · 결제 설정 화면에서 <b>Tax ID</b> 또는 <b>VAT / Business number</b> 칸을 찾아 넣으시면 됩니다. 아래 번호를 복사해 가세요.",
  invoice: "국내 사업자가 발행하는 건이라 세금계산서를 받으면 매입세액공제 대상이 됩니다.",
  supplier: "공급자가 국내인지 해외인지에 따라 부가세 처리가 달라집니다. 확실하지 않으면 비워서 넘기는 편이 안전합니다."
};

function renderTasks() {
  const open = ST.tasks.filter(t => !t.done);
  const box = document.getElementById("todo");
  if (!open.length) { box.innerHTML = ""; return; }

  const brn = ST.profile && ST.profile.brn;
  box.innerHTML = `<h4>할 일 ${open.length}</h4>` + open.map(t => {
    const url = (WATCH[t.mkey] && WATCH[t.mkey].manageUrl) || "";
    const acts = [
      url ? `<button class="go" data-open="${esc(url)}">사이트 열기</button>` : "",
      t.kind === "register" && brn ? `<button class="go" data-copy="${esc(brn)}">번호 복사</button>` : "",
      `<span class="x" data-done="${t.id}">완료</span>`
    ].filter(Boolean).join("");
    return `<div class="t"><span>${(TASK_TEXT[t.kind] || (m => m))(esc(t.merchant))}</span>
      <span class="a">${acts}</span></div>`;
  }).join("")
  + `<div class="how">${TASK_HOW[open[0].kind] || ""}` +
    (open.some(t => t.kind === "register") && !brn
      ? ` <b>내 정보</b> 탭에서 사업자등록번호를 먼저 저장해 주세요.` : "") + `</div>`;

  box.querySelectorAll("[data-done]").forEach(el => el.addEventListener("click", async () => {
    const id = el.getAttribute("data-done");
    const t = ST.tasks.find(x => x.id === id);
    if (t) t.done = true;
    await chrome.storage.local.set({ tasks: ST.tasks });
    renderTasks();
  }));
  box.querySelectorAll("[data-open]").forEach(el => el.addEventListener("click", () =>
    chrome.tabs.create({ url: el.getAttribute("data-open") })));
  box.querySelectorAll("[data-copy]").forEach(el => el.addEventListener("click", () => {
    navigator.clipboard.writeText(el.getAttribute("data-copy"));
    const back = el.textContent; el.textContent = "복사됨 ✓";
    setTimeout(() => (el.textContent = back), 1500);
  }));
}

/* ── 결제 예정 — 화면에서 가장 먼저.
   결제된 뒤에 아는 건 늦다. 해외 서비스는 환불이 거의 안 되니까,
   빠져나가기 전에 "쓸 건가 말 건가"를 정할 시간을 만들어 주는 게 이 칸의 역할이다. */
function renderDue() {
  const box = document.getElementById("due");
  const today = todayISO();
  const rows = [];
  for (const mkey of Object.keys(ST.subs)) {
    const s = ST.subs[mkey];
    if (!s.lastPaid || !s.interval) continue;
    const next = R.addInterval(s.lastPaid, s.interval);
    const left = Math.round((new Date(next) - new Date(today)) / 86400e3);
    if (left < 0 || left > 30) continue;
    rows.push({ mkey, merchant: s.merchant || "구독", next, left,
      auto: s.auto !== false, trial: !!s.trial,
      amountKrw: s.amountKrw, currency: s.currency, amountOrig: s.amountOrig,
      billing: R.billingLabel({ interval: s.interval, auto: s.auto !== false }) });
  }
  if (!rows.length) { box.innerHTML = ""; return; }
  rows.sort((a, b) => a.left - b.left);

  const anyAuto = rows.some(r => r.auto);
  const total = rows.reduce((a, r) => a + (r.amountKrw || 0), 0);
  box.innerHTML = `<h4>결제 예정 ${rows.length} · 합계 ${won(total)}</h4>` +
    rows.map(r => {
      const when = r.left === 0 ? "오늘" : `${r.left}일 뒤`;
      const amt = r.currency && r.currency !== "KRW"
        ? `${r.currency} ${r.amountOrig}` : won(r.amountKrw);
      return `<div class="r"><span class="n">${esc(r.merchant)}</span>
        <span class="w">${when} · ${r.trial ? "유료 전환" : r.billing}</span>
        <span class="a">${amt}</span></div>`;
    }).join("") +
    (anyAuto
      ? `<div class="note">가만히 두면 자동으로 빠져나갑니다.
           해외 서비스는 결제되고 나면 환불이 거의 안 됩니다.</div>`
      : `<div class="note">지난번 이맘때 결제하셨습니다. 이번에도 필요하신지 확인해 보세요.</div>`);
}

// ---------- 목록 ----------
function render() {
  renderDue();
  renderTasks();
  const rows = visibleRows();
  const real = rows.filter(r => r.status !== "upcoming");
  const sum = real.reduce((a, r) => a + (r.amountKrw || 0), 0);
  const leak = real.reduce((a, r) => a + (r.vatKrw || 0), 0);
  const unsure = real.filter(r => r.supplier === SUP.UNKNOWN || r.amountKrw == null).length;

  /* 두 숫자 모두 "앞으로 1년에 안 나갈 돈"이다. 이미 아낀 돈이 아니다.
     하나는 사업자번호 등록으로 부가세가 안 붙게 된 것, 하나는 해지로 결제 자체가 없어진 것.
     단위를 1년으로 맞춰야 나란히 놓을 수 있고, 그래야 합계도 말이 된다. */
  const vatYear = WT.vatFreeYear(ST.stats);
  const cutYear = ST.stats.canceledYear || 0;
  const parts = [
    vatYear > 0 ? `부가세 ${won(vatYear)}` : "",
    cutYear > 0 ? `해지 ${won(cutYear)}` : ""
  ].filter(Boolean);
  document.getElementById("total-saved").textContent =
    parts.length ? "1년에 안 나갈 수 있는 돈 · " + parts.join(" · ") : "";

  document.getElementById("summary").innerHTML = real.length
    ? `<b>${real.length}건</b> · 합계 <b>${won(sum)}</b>`
      + (leak > 0 ? ` · 부가세 <span class="leak">${won(leak)}</span>` : "")
      + (unsure > 0 ? ` · <span class="warn">확인 필요 ${unsure}</span>` : "")
    : "";

  const list = document.getElementById("list");
  /* 아무것도 없을 때 분기 탭과 내보내기 버튼까지 보여 주면, 화면이 기능으로 가득한데
     정작 볼 것은 없는 상태가 된다. 채워질 때까지는 무엇을 하면 채워지는지 한 줄만 남긴다. */
  const bare = !rows.length && !ST.ledger.length;
  document.querySelector(".tabs").style.display = bare ? "none" : "";
  document.querySelector("#view-book footer").style.display = bare ? "none" : "";
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><b>${bare ? "아직 기록이 없어요" : "이 분기에는 결제가 없어요"}</b>
      해외 결제창을 열면 금액과 부가세를 자동으로 읽어<br>여기에 쌓아 둡니다. 따로 하실 일은 없습니다.
      <span class="then">분기가 끝나면 결제일 · 서비스명 · 금액 · 부가세가 정리된<br>
      파일 한 장(CSV)을 여기서 내려받아 세무대리인께 보내시면 됩니다.</span></div>`;
    return;
  }
  list.innerHTML = "";

  list.innerHTML = rows.map(r => {
    const chip = r.supplier === SUP.UNKNOWN && r.status !== "upcoming"
      ? `<span class="chip ask" data-ask="${r.id}">공급자?</span>`
      : r.status === "confirmed" ? `<span class="chip ok">확정</span>`
      : r.status === "estimated" ? `<span class="chip est">추정</span>`
      : `<span class="chip next">예정</span>`;
    const confirmBtn = r.status === "estimated" ? `<button class="confirm" data-id="${r.id}">확인</button>` : "";
    const fxPending = r.currency && r.currency !== "KRW" && r.krwBasis !== "actual" && r.status !== "upcoming";
    const sub = r.status === "upcoming" ? "다음 결제 예정"
      : r.charge === CH.REFUND ? "환불"
      : [r.currency && r.currency !== "KRW" ? `${r.currency} ${r.amountOrig}` : "",
         r.interval ? R.billingLabel({ interval: r.interval, auto: r.auto !== false }) : (r.desc || "")]
        .filter(Boolean).join(" · ");
    return `<li>
      <span class="d">${r.date.slice(0, 4)}<br>${r.date.slice(5).replace("-", ".")}</span>
      <span class="m"><span class="n">${esc(r.merchant || "-")}</span><span class="s">${esc(sub)}</span></span>
      ${chip}
      <span class="a"><span class="w">${fxPending ? "≈" : ""}${won(r.amountKrw)}</span>
        ${fxPending ? `<div class="fx" data-fx="${r.id}">실제 청구액 입력</div>`
          : (r.vatKrw > 0 ? `<div class="v">부가세 ${won(r.vatKrw)}</div>` : "")}</span>
      ${confirmBtn}
    </li>`;
  }).join("");

  list.querySelectorAll(".confirm").forEach(b => b.addEventListener("click", () => confirmEstimated(b.dataset.id)));
  list.querySelectorAll("[data-fx]").forEach(e => e.addEventListener("click", () => enterActualKrw(e.dataset.fx)));
  list.querySelectorAll("[data-ask]").forEach(e => e.addEventListener("click", () => askSupplier(e.dataset.ask)));
}

/* 기록함에서도 공급자를 답할 수 있어야 한다 — 결제창을 다시 열 수는 없으니까 */
async function askSupplier(id) {
  const r = ST.ledger.find(x => x.id === id);
  if (!r) return;
  const a = prompt(
    `${r.merchant} (${r.date})\n\n` +
    `이 서비스에서 세금계산서를 받을 수 있나요?\n\n` +
    `1 = 받을 수 있어요 (국내 사업자)\n` +
    `2 = 해외 서비스라 못 받아요\n` +
    `0 = 아직 모르겠어요`, "2");
  if (a !== "1" && a !== "2") return;
  const sup = a === "1" ? SUP.DOMESTIC : SUP.OVERSEAS;
  const taxType = (ST.profile && ST.profile.taxType) || T.UNKNOWN;
  const vt = R.vatTreatment(taxType, sup);

  // 같은 서비스의 다른 건도 함께 확정한다 — 한 번 물었으면 다시 묻지 않는다
  ST.ledger.forEach(x => {
    if (x.mkey === r.mkey && x.supplier === SUP.UNKNOWN) {
      x.supplier = sup; x.supplierWhy = "사용자 확인"; x.vatCsv = vt.csv; x.vatReview = vt.review;
    }
  });
  if (ST.subs[r.mkey]) ST.subs[r.mkey].supplier = sup;
  ST.suppliers[r.mkey] = sup;
  if (sup === SUP.DOMESTIC && !ST.tasks.some(t => t.mkey === r.mkey && t.kind === "invoice" && !t.done)) {
    ST.tasks.push({ id: `invoice-${r.mkey}-${Date.now()}`, mkey: r.mkey, merchant: r.merchant, kind: "invoice", ts: Date.now(), done: false });
  }
  await chrome.storage.local.set({ ledger: ST.ledger, subs: ST.subs, suppliers: ST.suppliers, tasks: ST.tasks });
  render();
}

async function enterActualKrw(id) {
  const r = ST.ledger.find(x => x.id === id);
  if (!r) return;
  const input = prompt(
    `${r.merchant} · ${r.currency} ${r.amountOrig} (${r.date})\n\n` +
    `카드 명세서의 실제 청구 원화금액을 입력하세요.\n` +
    `지금 표시된 ${won(r.amountKrw)}은 추정치입니다.`, r.amountKrw ?? "");
  if (input === null) return;
  const val = Math.round(Number(String(input).replace(/[^\d.]/g, "")));
  if (!val || val <= 0) return;
  r.amountKrw = val; r.krwBasis = "actual"; r.fxNote = "카드 명세서 실제 청구액";
  await chrome.storage.local.set({ ledger: ST.ledger });
  render();
}

async function confirmEstimated(id) {
  const [, mkey, date] = id.match(/^est-(.+)-(\d{4}-\d{2}-\d{2})$/) || [];
  const s = ST.subs[mkey];
  if (!s) return;
  const taxType = (ST.profile && ST.profile.taxType) || T.UNKNOWN;
  const sup = s.supplier || SUP.UNKNOWN;
  const vt = R.vatTreatment(taxType, sup);
  ST.ledger.push({
    id: "r" + Date.now(), date, merchant: s.merchant, mkey, desc: s.desc || "",
    currency: s.currency, amountOrig: s.amountOrig, amountKrw: s.amountKrw,
    krwBasis: s.currency === "KRW" ? "actual" : "estimated",
    vatKrw: s.vatKrw, supplier: sup, charge: CH.RENEWAL,
    vatCsv: vt.csv, vatReview: vt.review, interval: s.interval,
    status: "confirmed", source: "manual"
  });
  if (date > (s.lastPaid || "")) s.lastPaid = date;
  await chrome.storage.local.set({ ledger: ST.ledger, subs: ST.subs });
  render();
}

// ---------- 내보내기 ----------
/* 과세유형을 모르면 부가세 처리 칸이 전부 비어 나간다. 그래서 만들기 직전에 딱 한 번 묻는다. */
function toCsv() {
  const rows = visibleRows().filter(r => r.status !== "upcoming");
  const taxType = (ST.profile && ST.profile.taxType) || T.UNKNOWN;
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [R.CSV_HEADER.map(esc).join(",")];
  for (const r of rows) {
    const vt = R.vatTreatment(taxType, r.supplier || SUP.UNKNOWN);
    lines.push(R.csvRow({ ...r, vatCsv: r.vatCsv || vt.csv, vatReview: r.vatReview ?? vt.review }).map(esc).join(","));
  }
  return "﻿" + lines.join("\r\n");
}

function doDownload() {
  const q = QUARTER === "all" ? { label: "전체" } : quarterRange(QUARTER);
  const blob = new Blob([toCsv()], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `savestripe_${q.label}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function download() {
  const t = ST.profile && ST.profile.taxType;
  if (!t || t === T.UNKNOWN) {
    pendingExport = true;
    document.getElementById("gate").classList.add("on");
    return;
  }
  doDownload();
}

function copyHandover() {
  const rows = visibleRows().filter(r => r.status !== "upcoming");
  const sum = rows.reduce((a, r) => a + (r.amountKrw || 0), 0);
  const q = QUARTER === "all" ? { human: "전체 기간" } : quarterRange(QUARTER);
  const overseas = rows.filter(r => r.supplier === SUP.OVERSEAS).length;
  const domestic = rows.filter(r => r.supplier === SUP.DOMESTIC).length;
  const unknown = rows.filter(r => !r.supplier || r.supplier === SUP.UNKNOWN).length;
  const fxPending = rows.filter(r => r.currency && r.currency !== "KRW" && r.krwBasis !== "actual").length;

  let text = `${q.human} 해외·SaaS 결제 내역 ${rows.length}건(합계 ${won(sum)}) 정리 파일 보내드립니다.\n\n`;
  if (overseas) text += `· 해외 사업자 결제 ${overseas}건. 세금계산서가 없는 건들입니다.\n`;
  if (domestic) text += `· 국내 사업자 결제 ${domestic}건. 세금계산서 수취 대상이라 별도 표시해 두었습니다.\n`;
  if (unknown) text += `· 공급자 소재가 확인되지 않은 ${unknown}건은 부가세 처리 칸을 비워 두었습니다. 확인 부탁드립니다.\n`;
  if (fxPending) text += `· 외화 결제 ${fxPending}건의 원화금액은 매매기준율 + 해외수수료 1.3% 가정의 추정치입니다. 카드 명세서 금액과 다를 수 있습니다.\n`;
  text += `\n증빙용 인보이스는 각 서비스의 이메일 영수증으로 보관 중입니다.`;

  navigator.clipboard.writeText(text).then(() => {
    const b = document.getElementById("copy");
    b.textContent = "복사됨 ✓";
    setTimeout(() => (b.textContent = "전달 문구 복사"), 1500);
  });
}

/* ── 백업과 복원.
   기록은 이 Chrome 프로필 안에만 있다. 노트북을 바꾸거나 브라우저를 갈아타면 사라진다.
   로그인을 붙이면 해결되지만 그러려면 서버가 생기고, 그 순간
   "서버로 보내지 않습니다"라는 이 도구의 가장 큰 약속을 잃는다.
   그래서 지금은 파일 한 장으로 옮긴다. 계정 동기화는 팀 단위가 필요해질 때 붙인다. */
const BACKUP_KEYS = ["profile", "ledger", "subs", "suppliers", "tasks", "stats", "consent", "settings"];

async function doBackup() {
  const data = await chrome.storage.local.get(BACKUP_KEYS);
  const payload = { app: "overseas-ai-subscription", version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `돈나가요_백업_${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  flash("backup", "저장됨 ✓", "기록 백업");
}

/* 복원은 덮어쓰기가 아니라 합치기다.
   두 기기에서 각각 쌓인 기록이 있을 수 있고, 어느 쪽도 버리면 안 된다. */
async function doRestore(file) {
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch (e) { return alert("백업 파일을 읽지 못했습니다."); }
  const d = payload && payload.data;
  if (!d || !Array.isArray(d.ledger)) return alert("이 앱의 백업 파일이 아닌 것 같습니다.");

  const cur = await chrome.storage.local.get(BACKUP_KEYS);
  const ledger = (cur.ledger || []).slice();
  let added = 0;
  for (const rec of d.ledger) {
    if (!ledger.some(x => R.sameRecord(x, rec))) { ledger.push(rec); added++; }
  }
  const subs = { ...(d.subs || {}), ...(cur.subs || {}) };
  for (const k of Object.keys(d.subs || {})) {
    const a = d.subs[k], b = cur.subs && cur.subs[k];
    if (a && b && a.lastPaid && b.lastPaid) subs[k] = a.lastPaid > b.lastPaid ? a : b;
  }
  const tasks = (cur.tasks || []).slice();
  for (const t of (d.tasks || [])) if (!tasks.some(x => x.id === t.id)) tasks.push(t);

  const merged = {
    ledger, subs, tasks,
    suppliers: { ...(d.suppliers || {}), ...(cur.suppliers || {}) },
    profile: cur.profile || d.profile || null,
    consent: cur.consent || d.consent || null,
    stats: { saved: Math.max((cur.stats && cur.stats.saved) || 0, (d.stats && d.stats.saved) || 0) }
  };
  await chrome.storage.local.set(merged);
  Object.assign(ST, merged);
  render();
  alert(`불러왔습니다. 새로 추가된 기록 ${added}건.\n기존 기록은 지워지지 않았습니다.`);
}

function flash(id, tmp, back) {
  const el = document.getElementById(id);
  el.textContent = tmp;
  setTimeout(() => (el.textContent = back), 1600);
}

// ---------- 시작 ----------

/* ============================================================
   결제 전 알림 — 세무 기능과 저장소·화면이 모두 분리되어 있다.
   여기서 만지는 건 watch 하나뿐이고, ledger·subs는 건드리지 않는다.
   ============================================================ */
const WT = self.SVSTWatch;
let WATCH = {};

const STATE_CHIP = {
  [WT.STATUS.CANCELED]: { cls: "off", label: "해지함" },
  [WT.STATUS.PAUSED]:   { cls: "off", label: "알림 끔" },
  [WT.STATUS.STALE]:    { cls: "wait", label: "확인 필요" },
  [WT.STATUS.PENDING]:  { cls: "wait", label: "해지 확인 중" },
  [WT.STATUS.NEEDS_INFO]: { cls: "wait", label: "확인 필요" }
};

function watchLine(w, today) {
  const cyc = w.interval === "year" ? "매년" : w.interval === "month" ? "매달" : "";
  const join = (...xs) => xs.filter(Boolean).join(" · ");
  if (w.status === WT.STATUS.CANCELED) return join(`<span class="st off">해지함</span>`, cyc);
  if (w.status === WT.STATUS.PAUSED) return join(`<span class="st off">알림 끔</span>`, cyc);
  if (w.status === WT.STATUS.STALE) return join(`<span class="st wait">확인 필요</span>`, "결제 여부를 몰라 알림을 멈췄어요");
  if (!w.interval || !w.due || w.status === WT.STATUS.NEEDS_INFO)
    return join(`<span class="st wait">확인 필요</span>`, "주기와 날짜를 채우면 알림이 시작돼요");
  const left = WT.daysBetween(today, w.due);
  const when = left < 0 ? "예정일 지남" : left === 0 ? "오늘" : `${left}일 뒤`;
  const soon = left >= 0 && left <= (w.kind === "trial" ? 2 : w.interval === "year" ? 14 : 5);
  if (w.kind === "trial")
    return join(`<span class="st ${soon ? "trial" : "ok"}">체험 종료 ${when}</span>`, cyc ? `그 뒤 ${cyc} 결제` : "");
  const fresh = WT.amountText(w) ? WT.freshness(w, today) : null;
  const old = fresh === WT.FRESH.STALE ? `<span class="old">${WT.seenAgo(w, today) || "예전"} 금액</span>` : "";
  return join(`<span class="st ${soon ? "soon" : "ok"}">${when}</span>`, cyc ? cyc + (w.auto === false ? " 직접 결제" : " 자동결제") : "", old);
}

/* 오른쪽 금액: 원화 예상액을 크게, 원래 통화를 작게. 둘 다 모르면 비운다. */
function amountCell(w) {
  if (w.amountOrig == null && w.amountKrw == null) return "";
  if (!w.currency || w.currency === "KRW") return won(w.amountKrw != null ? w.amountKrw : w.amountOrig);
  return (w.amountKrw != null ? `≈${won(w.amountKrw)}` : "") + `<small>${esc(w.currency)} ${w.amountOrig}</small>`;
}

/* 채널이 스토어면 해지 경로가 다르다는 것을, 환불 규정이 있으면 그 한 줄을 카드에 남긴다.
   둘 다 결제 전에 알아야 쓸모 있는 정보다. */
function metaLine(w) {
  const parts = [];
  if (w.channel && w.channel !== "web" && PS.CHANNEL[w.channel]) parts.push(esc(PS.CHANNEL[w.channel].cancelHint));
  if (w.refundNote) parts.push(`환불 · ${esc(w.refundNote)}` +
    (w.refundUrl ? ` <span class="lnk3" data-w="refund" data-k="${esc(w.__k)}">규정 ↗</span>` : ""));
  const url = w.manageUrl || w.sourceUrl;
  if (url) { try { parts.push(`<span class="lnk3" data-w="site" data-k="${esc(w.__k)}">${esc(new URL(url).host.replace(/^www\./, ""))} ↗</span>`); } catch (e) { /* 주소 아님 */ } }
  return parts.length ? `<div class="meta">${parts.join("<br>")}</div>` : "";
}

function renderHero() {
  const box = document.getElementById("hero");
  const today = todayISO();
  const live = Object.keys(WATCH).filter(k => WT.isLive(WATCH[k]));
  if (!live.length) {
    box.innerHTML = `<div class="k">결제 전 알림</div>
      <div class="v text">카드 문자보다 먼저 알려드려요</div>
      <div class="sub">등록하면 결제 며칠 전에 원화 예상액과 함께 알림이 옵니다.</div>`;
    return;
  }
  const up = WT.upcoming(WATCH, today, 30);
  const sum = up.reduce((a, u) => a + (u.w.amountKrw || 0), 0);
  const unknownUp = up.filter(u => u.w.amountKrw == null).length;
  const mt = WT.monthlyTotal(WATCH);
  box.innerHTML = `<div class="k">앞으로 30일 안에 나갈 돈</div>
    <div class="v">${won(sum)}${unknownUp ? `<small>+ 미확인 ${unknownUp}건</small>` : ""}</div>
    <div class="sub">구독 <b>${mt.count}개</b> · 월 환산 <b>${won(mt.monthly)}</b></div>`;
}

function siteLine(w) {
  const url = w.manageUrl || w.sourceUrl;
  if (!url) return "";
  let host = "";
  try { host = new URL(url).host.replace(/^www\./, ""); } catch (e) { return ""; }
  const what = w.manageUrl ? "관리 화면" : "등록한 화면";
  return `<div class="site"><span class="lnk3" data-w="site" data-k="${esc(w.__k)}"
    title="${esc(url)}">${esc(host)} ↗</span> <i>${what}</i></div>`;
}

function renderWatch() {
  const box = document.getElementById("w-list");
  const keys = Object.keys(WATCH);
  renderHero();
  if (!keys.length) {
    box.innerHTML = `<div class="empty"><b>쓰고 있는 서비스를 눌러 주세요</b>
      금액과 주기는 채워 드려요. 다음 결제일만 알려주시면 됩니다.
      <div class="chips" id="w-empty-chips">${PS.search("", 8).map(p =>
        `<button type="button" data-preset="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div>
      <span class="or">목록에 없나요? <span class="lnk" id="w-empty-add">직접 입력</span></span></div>`;
    document.getElementById("w-empty-add").addEventListener("click", () => openForm(null));
    box.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => openForm(null, b.dataset.preset)));
    return;
  }
  const today = todayISO();
  /* 가장 가까운 결제가 맨 위. '확인 필요'는 그 아래 — 이 화면의 첫 줄은 "다음에 나갈 돈"이어야 한다. */
  const rank = { active: 0, pending: 1, "needs-info": 2, stale: 3, paused: 4, canceled: 5 };
  keys.sort((a, b) => ((rank[WATCH[a].status] ?? 2) - (rank[WATCH[b].status] ?? 2))
    || String(WATCH[a].due || "").localeCompare(String(WATCH[b].due || "")));

  box.innerHTML = keys.map(k => {
    const w = WATCH[k];
    w.__k = k;
    const left = w.due ? WT.daysBetween(today, w.due) : 999;
    const chip = STATE_CHIP[w.status]
      || (w.kind === "trial" ? { cls: "trial", label: left >= 0 && left <= 2 ? "체험 곧 종료" : "무료 체험" }
        : left >= 0 && left <= (w.interval === "year" ? 14 : 5)
          ? { cls: "due", label: "곧 결제" } : { cls: "ok", label: "예정" });
    const live = w.status === WT.STATUS.ACTIVE || w.status === WT.STATUS.PENDING;
    const needsInfo = w.status === WT.STATUS.NEEDS_INFO || !w.interval || !w.due;
    return `<div class="wc" data-row="${esc(k)}">
      <div class="t"><span class="nm">${esc(w.name)}</span><span class="amt">${amountCell(w)}</span></div>
      <div class="b">${watchLine(w, today)}</div>
      <div class="detail" hidden>
        ${metaLine(w)}
        <div class="btns">
          ${live && w.manageUrl && WT.amountText(w) && WT.freshness(w, today) === WT.FRESH.STALE
            ? `<button class="p" data-w="verify" data-k="${esc(k)}">지금 금액 확인</button>` : ""}
          ${live && WT.cancelUrl(w) ? `<button class="${needsInfo ? "" : "p"}" data-w="open" data-k="${esc(k)}">해지하러 가기</button>` : ""}
          ${w.status === WT.STATUS.STALE || w.status === WT.STATUS.CANCELED || w.status === WT.STATUS.PAUSED
            ? `<button class="p" data-w="resume" data-k="${esc(k)}">알림 다시 받기</button>` : ""}
          <button class="${needsInfo ? "p" : ""}" data-w="edit" data-k="${esc(k)}">${needsInfo ? "정보 완성하기" : "수정"}</button>
          ${live ? `<button data-w="canceled" data-k="${esc(k)}">해지했어요</button>` : ""}
          ${live ? `<button data-w="pause" data-k="${esc(k)}">알림 끄기</button>` : ""}
          <button class="sp" data-w="del" data-k="${esc(k)}">삭제</button>
        </div>
      </div></div>`;
  }).join("");

  /* 버튼은 줄을 눌렀을 때만. 늘 보이면 목록이 버튼으로 가득 찬다. */
  box.querySelectorAll(".wc .t, .wc .b").forEach(el => el.addEventListener("click", () => {
    const d = el.closest(".wc").querySelector(".detail");
    if (d) d.hidden = !d.hidden;
  }));
  box.querySelectorAll("[data-w]").forEach(b => b.addEventListener("click", async () => {
    const k = b.dataset.k, act = b.dataset.w;
    if (act === "edit") return openForm(k);
    /* 확인은 여는 것까지다. 실제 갱신은 그 페이지에서 숫자를 읽었을 때 일어난다.
       여기서 미리 확인했다고 표시하면 못 읽었을 때도 확인한 것이 된다. */
    if (act === "site") {
      const u = WATCH[k].manageUrl || WATCH[k].sourceUrl;
      if (u) chrome.tabs.create({ url: u });
      return;
    }
    if (act === "verify") { if (WATCH[k].manageUrl) chrome.tabs.create({ url: WATCH[k].manageUrl }); return; }
    if (act === "refund") { if (WATCH[k].refundUrl) chrome.tabs.create({ url: WATCH[k].refundUrl }); return; }
    if (act === "open") { const u = WT.cancelUrl(WATCH[k]); if (u) chrome.tabs.create({ url: u });
      WATCH[k] = WT.applyAction(WATCH[k], "cancel-go", todayISO()); }
    else if (act === "del") { delete WATCH[k]; }
    else { WATCH[k] = WT.applyAction(WATCH[k], act, todayISO()); }
    await chrome.storage.local.set({ watch: WATCH });
    renderWatch();
  }));
}

// ---------- 수정 폼 ----------
/* 설치 직후 사용자는 금액과 날짜를 모를 수 있다. 서비스 이름만 먼저 적어 두고
   나머지는 확인 필요로 남길 수 있게 한다. 모르는 값을 추측해서 알림으로 만들지는 않는다.
   다만 자주 쓰는 서비스는 이름 하나로 금액·주기·해지 화면을 채운다 — 기본값이라고 밝히고. */
const $w = (id) => document.getElementById(id);
const PS = self.SVSTPresets;
let EDIT_KEY = null;
const F = { kind: "sub", interval: "", channel: "web", preset: null };

function segSet(id, v) {
  F[{ "w-kind": "kind", "w-int": "interval", "w-channel": "channel" }[id]] = v;
  $w(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  if (id === "w-kind") $w("w-due-label").textContent = v === "trial" ? "무료 체험이 끝나는 날" : "다음 결제일";
}

/* 사업자번호를 넣은 사람은 결제창에서 부가세가 빠진다. 그 외에는 10%가 붙는 것이 기본이다. */
function vatApplies() { return !(ST.profile && ST.profile.brn); }

function krwPreview() {
  const amt = parseFloat(String($w("w-amt").value).replace(/[^\d.]/g, ""));
  const cur = $w("w-cur").value;
  const el = $w("w-krw");
  if (isNaN(amt) || cur === "KRW") { el.innerHTML = ""; return; }
  const krw = WT.estimateKrw(amt, cur, ST.rates, { vat: vatApplies() });
  el.innerHTML = krw == null ? "환율을 아직 못 받았습니다. 원화 예상액은 나중에 채워집니다."
    : `카드에는 약 <b>${won(krw)}</b> · 환율·해외수수료${vatApplies() ? "·부가세 10%" : ""} 포함`;
}

function applyPreset(p) {
  F.preset = p ? p.id : null;
  $w("w-sugg").querySelectorAll("button").forEach(b => b.classList.toggle("on", !!p && b.dataset.preset === p.id));
  if (!p) { $w("w-preset-note").textContent = ""; return; }
  $w("w-name").value = p.name;
  $w("w-amt").value = p.amount;
  $w("w-cur").value = p.currency;
  segSet("w-int", p.interval);
  if (!$w("w-url").value) $w("w-url").value = p.manageUrl || "";
  $w("w-preset-note").textContent = "기본 요금을 넣었어요. 실제와 다르면 고쳐 주세요.";
  krwPreview();
  $w("w-due").focus();
}

function renderSugg(q) {
  const list = PS.search(q, 8);
  $w("w-sugg").innerHTML = list.map(p =>
    `<button type="button" data-preset="${esc(p.id)}" class="${F.preset === p.id ? "on" : ""}">${esc(p.name)}</button>`).join("");
  $w("w-sugg").querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => applyPreset(PS.LIST.find(x => x.id === b.dataset.preset))));
}

function openForm(key, presetId) {
  EDIT_KEY = key || null;
  const w = key ? WATCH[key] : null;
  $w("w-form-title").textContent = w ? "구독 수정" : "구독 등록";
  $w("w-form-lead").textContent = w
    ? "아는 내용만 고쳐 주세요. 모르는 내용은 비워도 됩니다."
    : "서비스 이름만 먼저 적어도 됩니다. 주기와 날짜를 알면 그때부터 알림이 갑니다.";
  $w("w-err").textContent = "";
  $w("w-preset-note").textContent = "";
  $w("w-name").value = w ? (w.name || "") : "";
  $w("w-amt").value = w && w.amountOrig != null ? w.amountOrig : "";
  $w("w-cur").value = (w && w.currency) || "USD";
  $w("w-due").value = (w && w.due) || "";
  $w("w-auto").checked = !w || w.auto !== false;
  $w("w-url").value = (w && w.manageUrl) || "";
  F.preset = (w && w.presetId) || null;
  segSet("w-kind", (w && w.kind) || "sub");
  segSet("w-int", (w && w.interval) || "");
  segSet("w-channel", (w && w.channel) || "web");
  renderSugg(w ? w.name : "");
  krwPreview();
  $w("w-form").classList.add("on");
  if (presetId) applyPreset(PS.LIST.find(x => x.id === presetId));
  else $w("w-name").focus();
}
function closeForm() { EDIT_KEY = null; $w("w-form").classList.remove("on"); }

function bindForm() {
  ["w-kind", "w-int", "w-channel"].forEach(id => $w(id).addEventListener("click", e => {
    const b = e.target.closest("button[data-v]"); if (b) segSet(id, b.dataset.v);
  }));
  $w("w-name").addEventListener("input", () => {
    const q = $w("w-name").value;
    if (F.preset) { const p = PS.LIST.find(x => x.id === F.preset); if (p && p.name !== q.trim()) F.preset = null; }
    renderSugg(q);
  });
  $w("w-amt").addEventListener("input", krwPreview);
  $w("w-cur").addEventListener("change", krwPreview);
}

/* Envato·Movavi·Artlist처럼 결제 화면을 직접 만들어 쓰는 곳은 도메인 목록으로 잡을 수가 없다.
   그렇다고 모든 사이트에 미리 들어가 앉아 있을 수는 없다 — 그건 설치할 때
   "모든 웹사이트의 데이터를 읽습니다" 경고가 붙고, 실제로 그럴 필요도 없다.
   그래서 순서를 뒤집는다: 사용자가 그 결제창에서 이 버튼을 누른 그 순간에만 들어간다.
   한 번 들어가 본 사이트는 "앞으로 자동으로"를 눌러 두면 다음부터 알아서 뜬다. */
async function enableHere() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return grabNote("탭을 찾지 못했습니다.");
    let origin = "";
    try { origin = new URL(tab.url).origin; } catch (e) { /* chrome:// 같은 곳 */ }
    if (!/^https?:$/.test(origin ? new URL(origin).protocol : "")) {
      return grabNote("이 페이지에서는 켤 수 없습니다. 결제 화면에서 눌러 주세요.");
    }

    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["panel.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["rules.js", "watch.js", "content.js"] });

    const already = await chrome.permissions.contains({ origins: [origin + "/*"] });
    if (already) return grabNote("켰습니다. 결제창 왼쪽 아래를 보세요.");
    grabNote("켰습니다. 결제창 왼쪽 아래를 보세요.");
    askAlways(origin);
  } catch (e) {
    grabNote("이 페이지는 읽을 수 없습니다.");
  }
}

/* 결제사 목록은 아무리 채워도 늘 뒤늦다. 새 AI 툴은 매주 나오고, 그중 상당수는
   자기 도메인에서 결제를 받는다. 그래서 목록을 늘리는 대신 문을 하나 열어 둔다.
   설치할 때 묻지 않고, 사용자가 이 줄을 누른 그 순간에만 묻는다.
   그래야 스토어 설치 화면에 "모든 웹사이트의 데이터를 읽습니다"가 붙지 않는다. */
const ALL_ORIGINS = { origins: ["https://*/*"] };

async function renderAllSites() {
  const el = document.getElementById("w-all");
  if (!el) return;
  let on = false;
  try { on = await chrome.permissions.contains(ALL_ORIGINS); } catch (e) { /* 확인 불가 */ }
  el.dataset.on = on ? "1" : "";
  el.textContent = on ? "모든 결제창에서 자동으로 켜져 있습니다 · 끄기"
                      : "모든 결제창에서 자동으로 켜기";
}

async function toggleAllSites() {
  const el = document.getElementById("w-all");
  if (el && el.dataset.on) {
    try { await chrome.scripting.unregisterContentScripts({ ids: ["svst-all"] }); } catch (e) { /* 없으면 넘어간다 */ }
    try { await chrome.permissions.remove(ALL_ORIGINS); } catch (e) { /* 이미 없다 */ }
    grabNote("껐습니다. 결제사 목록에 있는 곳에서는 그대로 뜹니다.");
    return renderAllSites();
  }
  let ok = false;
  try { ok = await chrome.permissions.request(ALL_ORIGINS); } catch (e) { /* 사용자가 닫음 */ }
  if (!ok) return grabNote("괜찮습니다. 필요할 때 위의 '이 결제창에서 켜기'로 쓰시면 됩니다.");
  try {
    await chrome.scripting.registerContentScripts([{
      id: "svst-all", matches: ["https://*/*"], allFrames: true,
      js: ["rules.js", "watch.js", "content.js"], css: ["panel.css"], runAt: "document_idle"
    }]);
  } catch (e) { /* 이미 등록돼 있으면 그대로 둔다 */ }
  grabNote("이제 어느 결제창에서든 자동으로 뜹니다.");
  renderAllSites();
}

/* 권한 요청은 사용자가 누른 직후여야 브라우저가 받아 준다. 그래서 버튼을 하나 띄운다. */
function askAlways(origin) {
  const el = document.getElementById("w-note");
  if (!el) return;
  const host = origin.replace(/^https?:\/\//, "");
  el.innerHTML = `켰습니다. 결제창 왼쪽 아래를 보세요.
    <button class="lnk2" id="w-always">${esc(host)}에서 앞으로 자동으로 켜기</button>`;
  clearTimeout(grabNote._t);
  document.getElementById("w-always").addEventListener("click", async () => {
    const ok = await chrome.permissions.request({ origins: [origin + "/*"] });
    if (!ok) return grabNote("괜찮습니다. 필요할 때 이 버튼으로 켜시면 됩니다.");
    try {
      await chrome.scripting.registerContentScripts([{
        id: "svst-" + host.replace(/[^a-z0-9]/gi, "-"),
        matches: [origin + "/*"],
        js: ["rules.js", "watch.js", "content.js"], css: ["panel.css"],
        runAt: "document_idle"
      }]);
    } catch (e) { /* 이미 등록돼 있으면 그대로 둔다 */ }
    grabNote(`${host}에서는 앞으로 자동으로 뜹니다.`);
  });
}

/* 사용자가 아이콘을 누른 그 탭에서만 읽는다(activeTab).
   누르지 않으면 아무것도 읽지 않고, 다른 탭은 볼 수 없다. */
async function grabFromPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("탭 없음");
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ text: document.body ? document.body.innerText.slice(0, 20000) : "",
                     title: document.title, url: location.href })
    });
    const d = res && res.result;
    if (!d) throw new Error("읽지 못함");
    const p = WT.parsePage(d.text, d.title, d.url, self.SVST);
    if (!p.name && p.amountOrig == null) return grabNote("이 페이지에서는 구독을 찾지 못했습니다.");

    const key = "w" + Date.now().toString(36);
    WATCH[key] = WT.makeWatch({
      name: p.name || d.title || "이름 없는 구독",
      amountOrig: p.amountOrig, currency: p.currency || "KRW", amountKrw: krwOf(p.amountOrig, p.currency),
      interval: p.interval || "month", auto: p.auto !== false,
      nextDue: p.nextDue || null, manageUrl: p.manageUrl || d.url, source: "grab"
    }, todayISO());
    await chrome.storage.local.set({ watch: WATCH });
    renderWatch();
    // 못 읽은 칸이 있으면 바로 고칠 수 있게 폼을 연다 — 특히 다음 결제일이 없으면 알릴 수가 없다
    if (!p.nextDue || p.amountOrig == null) openForm(key);
    else grabNote(`${WATCH[key].name} 을(를) 목록에 넣었습니다.`);
  } catch (e) {
    grabNote("이 페이지는 읽을 수 없습니다.");
  }
}

/* 읽어 오기 결과는 폼이 아니라 목록 위에 잠깐 띄운다 — 폼을 열지 않고 끝나는 경우가 대부분이다. */
function grabNote(msg) {
  const el = document.getElementById("w-note");
  if (!el) return;
  el.textContent = msg;
  el.dataset.plain = "1";
  clearTimeout(grabNote._t);
  grabNote._t = setTimeout(() => { el.textContent = ""; }, 4000);
}

function krwOf(amt, cur) {
  return WT.estimateKrw(amt, cur, ST.rates || null, { vat: vatApplies() });
}

async function saveWatch() {
  const name = $w("w-name").value.trim();
  const due = $w("w-due").value;
  if (!name) { $w("w-err").textContent = "서비스 이름을 넣어 주세요."; return; }
  if (F.kind === "trial" && !due) { $w("w-err").textContent = "무료 체험이 끝나는 날을 넣어 주세요. 그날부터 돈이 나갑니다."; return; }
  const amt = parseFloat(String($w("w-amt").value).replace(/[^\d.\-]/g, ""));
  const cur = $w("w-cur").value;
  const krw = isNaN(amt) ? null : WT.estimateKrw(amt, cur, ST.rates, { vat: vatApplies() });
  const preset = F.preset ? PS.LIST.find(x => x.id === F.preset) : null;
  const key = EDIT_KEY || ("w" + Date.now().toString(36));
  const w = WT.makeWatch({
    name, amountOrig: isNaN(amt) ? null : amt, currency: cur, amountKrw: krw,
    interval: F.interval, kind: F.kind, channel: F.channel, auto: $w("w-auto").checked,
    nextDue: due, manageUrl: $w("w-url").value.trim() || null,
    presetId: preset ? preset.id : ((WATCH[key] && WATCH[key].presetId) || null),
    refundUrl: preset ? preset.refundUrl : ((WATCH[key] && WATCH[key].refundUrl) || null),
    refundNote: preset ? preset.refundNote : ((WATCH[key] && WATCH[key].refundNote) || null),
    source: (WATCH[key] && WATCH[key].source) || "manual"
  }, todayISO());
  // 고치는 것이지 새로 만드는 게 아니다 — 이미 보낸 알림 기록(ackedFor·misses)은 그대로 둔다
  WATCH[key] = WATCH[key] ? { ...WATCH[key], ...w } : w;
  await chrome.storage.local.set({ watch: WATCH });
  ["w-name", "w-amt", "w-due", "w-url"].forEach(id => { $w(id).value = ""; });
  closeForm();
  renderWatch();
  const lead = alertsText(w);
  grabNote(w.status === WT.STATUS.NEEDS_INFO
    ? `${name}을(를) 확인 필요로 저장했습니다. 주기와 날짜를 채우면 알림이 시작됩니다.`
    : `${name} 등록 완료 · ${lead}`);
}

/* "5일 전과 1일 전에 알려드려요" — 등록 직후 사용자가 가장 궁금한 한 줄 */
function alertsText(w) {
  const days = WT.alertDaysBefore(w, ST.settings && ST.settings.lead);
  if (!days.length) return "";
  const words = days.map(d => d === 0 ? "당일" : `${d}일 전`);
  return (w.kind === "trial" ? "체험 종료 " : "결제 ") + words.join(" · ") + "에 알려드려요";
}

/* ── 내 정보 ──
   전에는 사업자등록번호를 넣는 자리가 결제창 위 패널뿐이었다.
   그래서 결제하러 가지 않으면 번호를 등록할 방법이 아예 없었다. 여기서도 되게 한다. */
function renderMe() {
  const p = ST.profile || {};
  $w("me-brn").value = p.brn || "";
  $w("me-type").value = p.type || "solo";
  $w("me-tax").value = p.taxType || "unknown";
  $w("me-err").textContent = "";

  const set = ST.settings || {};
  $w("me-noti").checked = set.notify !== false;
  const lead = set.lead || {};
  const pick = (sel, arr, fallback) => {
    const v = (Array.isArray(arr) && arr.length ? arr : fallback).join(",");
    const el = $w(sel);
    el.value = [...el.options].some(o => o.value === v) ? v : fallback.join(",");
  };
  pick("me-lead-y", lead.year, WT.LEAD_DEFAULT.year);
  pick("me-lead-m", lead.month, WT.LEAD_DEFAULT.month);
}

async function saveMe() {
  const raw = $w("me-brn").value.trim();
  const type = $w("me-type").value;
  const err = $w("me-err");

  if (raw && !R.validBrn(raw)) {
    err.textContent = "번호를 다시 확인해 주세요. 국세청 검증을 통과하지 않습니다.";
    return;
  }
  if (!raw && type !== "personal") {
    err.textContent = "사업자등록번호를 넣으시면 결제창에서 부가세를 뺄 수 있습니다.";
  } else {
    err.textContent = "";
  }

  ST.profile = { ...(ST.profile || {}), type, taxType: $w("me-tax").value,
                 brn: raw ? R.fmtBrn(raw) : "" };
  delete ST.profile.pendingBrn;
  await chrome.storage.local.set({ profile: ST.profile });
  $w("me-brn").value = ST.profile.brn;
  flash("me-save", "저장됨 ✓", "저장");
  renderTasks();
}

async function saveNoti() {
  const nums = (id) => $w(id).value.split(",").map(Number).filter(n => n >= 0);
  ST.settings = {
    notify: $w("me-noti").checked,
    lead: { year: nums("me-lead-y"), month: nums("me-lead-m"), trial: WT.LEAD_DEFAULT.trial }
  };
  await chrome.storage.local.set({ settings: ST.settings });
  flash("me-noti-save", "저장됨 ✓", "저장");
}

/* ── 캘린더 파일 ──
   chrome.alarms는 브라우저가 떠 있을 때만 울린다. 노트북을 덮어 두면 알림이 안 간다.
   서버를 두면 해결되지만 그러면 "아무것도 전송하지 않는다"는 약속이 깨진다.
   그래서 파일 한 장으로 넘긴다 — 캘린더에 넣으면 그 뒤로는 휴대폰이 대신 알려 준다. */
function icsEscape(v) {
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}
/* iCalendar는 한 줄이 75옥텟을 넘으면 안 된다. 글자 수가 아니라 바이트 수다 —
   한글은 한 자에 3바이트라 글자로 세면 그대로 규격을 넘긴다.
   그리고 글자 중간에서 자르면 캘린더 앱이 깨진 글자를 보여 준다. */
function fold(line) {
  const size = (t) => new TextEncoder().encode(t).length;
  if (size(line) <= 73) return line;
  const parts = [];
  let cur = "", limit = 73;
  for (const ch of line) {
    if (size(cur + ch) > limit) { parts.push(cur); cur = ""; limit = 72; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts[0] + parts.slice(1).map(x => "\r\n " + x).join("");
}

function buildIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lead = (ST.settings && ST.settings.lead) || WT.LEAD_DEFAULT;
  const L = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//돈나가요//KR", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", "X-WR-CALNAME:해외 구독 결제일"
  ];
  let n = 0;
  for (const key of Object.keys(WATCH)) {
    const w = WATCH[key];
    if (!w || !w.due || !w.interval) continue;
    if (w.status !== WT.STATUS.ACTIVE && w.status !== WT.STATUS.PENDING) continue;
    const d = w.due.replace(/-/g, "");
    const amt = WT.amountText(w);
    const days = WT.alertDaysBefore(w, lead);

    L.push("BEGIN:VEVENT");
    L.push(`UID:svst-${encodeURIComponent(key)}-${d}@overseas-ai-subscription`);
    L.push(`DTSTAMP:${stamp}`);
    L.push(`DTSTART;VALUE=DATE:${d}`);
    L.push(`RRULE:FREQ=${w.interval === "year" ? "YEARLY" : "MONTHLY"};INTERVAL=1`);
    L.push(fold(`SUMMARY:${icsEscape(w.name + (amt ? " " + amt : "") +
      (w.kind === "trial" ? " 무료 체험 종료" : w.auto === false ? " 결제일" : " 자동 결제"))}`));
    L.push(fold(`DESCRIPTION:${icsEscape(
      (w.kind === "trial"
        ? "오늘 무료 체험이 끝나고 유료 결제가 시작됩니다. 계속 쓰지 않을 거면 오늘 안에 해지하세요."
        : w.auto === false
        ? "지난번 이맘때 결제하셨습니다. 이번에도 필요하신지 확인해 보세요."
        : "오늘 자동으로 빠져나갑니다. 해외 서비스는 결제 후 환불이 어렵습니다.") +
      (WT.cancelUrl(w) ? "\n해지·관리: " + WT.cancelUrl(w) : ""))}`));
    for (const day of days) {
      L.push("BEGIN:VALARM", "ACTION:DISPLAY",
        fold(`DESCRIPTION:${icsEscape(w.name + (day ? ` ${day}일 뒤 결제` : " 오늘 결제"))}`),
        `TRIGGER:-P${day}D`, "END:VALARM");
    }
    L.push("END:VEVENT");
    n++;
  }
  L.push("END:VCALENDAR");
  return { text: L.join("\r\n") + "\r\n", count: n };
}

function downloadIcs() {
  const { text, count } = buildIcs();
  if (!count) { $w("me-err").textContent = "캘린더에 넣을 구독이 아직 없습니다."; return; }
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `돈나가요_결제일_${todayISO()}.ics`;
  a.click();
  URL.revokeObjectURL(a.href);
  flash("me-ics", `${count}건 저장됨 ✓`, "캘린더에 넣기");
}

function bindWatch() {
  $w("tab-book").addEventListener("click", () => switchView("book"));
  $w("tab-watch").addEventListener("click", () => switchView("watch"));
  $w("w-cancel").addEventListener("click", closeForm);
  $w("w-save").addEventListener("click", saveWatch);
  $w("w-add").addEventListener("click", () => openForm(null));
  $w("w-enable").addEventListener("click", enableHere);
  $w("w-all").addEventListener("click", toggleAllSites);
  renderAllSites();
  $w("tab-me").addEventListener("click", () => switchView("me"));
  $w("me-save").addEventListener("click", saveMe);
  $w("me-noti-save").addEventListener("click", saveNoti);
  $w("me-ics").addEventListener("click", downloadIcs);
}

/* 환율을 못 받은 채 등록된 구독(온보딩 직후, 오프라인)은 원화가 비어 있다.
   환율이 오면 채워 넣는다. 사용자가 손으로 넣은 원화 금액은 건드리지 않는다. */
async function backfillKrw() {
  let touched = false;
  for (const k of Object.keys(WATCH)) {
    const w = WATCH[k];
    if (!w || w.amountKrw != null || w.amountOrig == null || !w.currency || w.currency === "KRW") continue;
    const krw = WT.estimateKrw(w.amountOrig, w.currency, ST.rates, { vat: vatApplies() });
    if (krw == null) continue;
    WATCH[k] = { ...w, amountKrw: krw };
    touched = true;
  }
  if (touched) { await chrome.storage.local.set({ watch: WATCH }); renderWatch(); }
}

function switchView(which) {
  for (const v of ["watch", "book", "me"]) {
    $w("tab-" + v).classList.toggle("on", which === v);
    $w("view-" + v).classList.toggle("on", which === v);
  }
  if (which === "watch") renderWatch();
  if (which === "me") renderMe();
}

async function init() {
  /* 툴바 팝업은 창 자체가 좁다. 새 탭으로 열렸을 때만 조금 넓힌다 —
     넓다고 가로를 다 쓰면 글줄이 길어져 오히려 못 읽는다. */
  if (window.innerWidth > 620) document.body.classList.add("wide");

  const st = await chrome.storage.local.get(["ledger", "subs", "stats", "tasks", "profile", "suppliers", "watch", "settings"]);
  ST.ledger = st.ledger || [];
  ST.subs = st.subs || {};
  ST.stats = st.stats || { saved: 0 };
  ST.tasks = st.tasks || [];
  ST.profile = st.profile || null;
  ST.suppliers = st.suppliers || {};
  WATCH = st.watch || {};
  ST.settings = {
    notify: !st.settings || st.settings.notify !== false,
    lead: { ...WT.LEAD_DEFAULT, ...((st.settings && st.settings.lead) || {}) }
  };
  chrome.runtime.sendMessage({ type: "getRates" }, (res) => {
    if (!res || !res.rates) return;
    ST.rates = res.rates; krwPreview(); backfillKrw();
  });
  bindWatch();
  bindForm();

  /* 사이드패널은 닫힐 때까지 살아 있다. 결제창에서 알림을 켜거나 다른 탭에서 등록해도
     여기서 새로고침 없이 바로 보이도록, 저장소가 바뀌면 그 부분만 다시 그린다. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.watch) { WATCH = changes.watch.newValue || {}; if (!$w("w-form").classList.contains("on")) renderWatch(); }
    if (changes.ledger) ST.ledger = changes.ledger.newValue || [];
    if (changes.subs) ST.subs = changes.subs.newValue || {};
    if (changes.tasks) ST.tasks = changes.tasks.newValue || [];
    if (changes.stats) ST.stats = changes.stats.newValue || { saved: 0 };
    if (changes.profile) ST.profile = changes.profile.newValue || null;
    if (changes.ledger || changes.subs || changes.tasks || changes.stats || changes.profile) render();
  });
  /* 첫 화면은 '구독 알림'이다. 결제 기록은 분기에 한 번 보면 되지만,
     알림은 이번 주에 무엇이 빠져나가는지를 말해 준다. 자주 보는 쪽이 먼저다. */
  renderWatch();

  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("on"));
    t.classList.add("on");
    QUARTER = t.dataset.q;
    render();
  }));
  document.getElementById("export").addEventListener("click", download);
  document.getElementById("copy").addEventListener("click", copyHandover);
  document.getElementById("backup").addEventListener("click", doBackup);
  document.getElementById("restore").addEventListener("click", () =>
    document.getElementById("restore-file").click());
  document.getElementById("restore-file").addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) doRestore(e.target.files[0]);
    e.target.value = "";
  });

  document.querySelectorAll("[data-tax]").forEach(b => b.addEventListener("click", async () => {
    ST.profile = { ...(ST.profile || { type: "solo" }), taxType: b.dataset.tax };
    await chrome.storage.local.set({ profile: ST.profile });
    document.getElementById("gate").classList.remove("on");
    if (pendingExport) { pendingExport = null; doDownload(); }
    render();
  }));

  render();
}
init();
