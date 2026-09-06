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
    list.innerHTML = `<div class="card empty-book"><b>${bare ? "아직 기록이 없어요" : "이 분기에는 결제가 없어요"}</b>
      해외 결제창을 열면 금액과 부가세를 자동으로 읽어 여기에 쌓아 둡니다.
      <span class="then">분기가 끝나면 결제일 · 서비스명 · 금액 · 부가세가 정리된 CSV를 내려받아 세무대리인께 보내면 됩니다.</span></div>`;
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

/* 파일 저장. 앵커를 문서에 붙이고 URL 해제를 미룬다 —
   붙이지 않거나 click 직후 곧바로 revokeObjectURL을 부르면 다운로드가 시작되기 전에
   블롭이 사라져 사이드패널에서 조용히 아무 일도 일어나지 않는다. */
function saveFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener"; a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

function doDownload() {
  const q = QUARTER === "all" ? { label: "전체" } : quarterRange(QUARTER);
  saveFile(`savestripe_${q.label}.csv`, toCsv(), "text/csv;charset=utf-8");
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
  saveFile(`Donna_백업_${todayISO()}.json`, JSON.stringify(payload, null, 2), "application/json");
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

const PS = self.SVSTPresets;
const PL = self.SVSTPlan;
const $w = (id) => document.getElementById(id);
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const koDate = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-").map(Number); return `${m}월 ${d}일 ${DOW[new Date(y, m - 1, d).getDay()]}요일`; };
const mdText = (iso) => { if (!iso) return ""; const [, m, d] = iso.split("-").map(Number); return `${m}월 ${d}일`; };

/* 서비스 로고. 프리셋에서 왔으면 그 색과 로고, 아니면 이름 첫 글자. */
function presetOf(w) { return (w && w.presetId && PS.LIST.find(x => x.id === w.presetId)) || (w && PS.find(w.name)) || null; }
function avatarOf(w, size) {
  return PS.avatarHtml(presetOf(w) || { name: w && w.name, color: "#8A8A91" }, size);
}

/* 오른쪽 금액: 원화를 크게, 원래 통화를 작게. 둘 다 모르면 비운다. */
function amountCell(w) {
  if (w.amountOrig == null && w.amountKrw == null) return "";
  const krw = w.amountKrw != null ? won(w.amountKrw) : (!w.currency || w.currency === "KRW" ? won(w.amountOrig) : "");
  const orig = w.currency && w.currency !== "KRW" && w.amountOrig != null
    ? `${esc(w.currency)} ${w.amountOrig}${w.interval === "year" ? " / 년" : ""}` : "";
  return `<div class="amt"><div class="krw">${krw}</div>${orig ? `<div class="orig">${orig}</div>` : ""}</div>`;
}

/* 상태: 색 필 + 짧은 말. 초록=예정대로, 주황=곧 나간다. */
function statusOf(w, today) {
  const cyc = w.interval === "year" ? "매년" : "매달";
  const chan = w.channel && w.channel !== "web" && PS.CHANNEL[w.channel] ? PS.CHANNEL[w.channel].label : "";
  if (w.status === WT.STATUS.CANCELED) return { tag: `<span class="tag soft">해지함</span>`, text: cyc + " 자동결제" };
  if (w.status === WT.STATUS.PAUSED) return { tag: `<span class="tag soft">알림 끔</span>`, text: cyc + " 자동결제" };
  if (w.status === WT.STATUS.STALE) return { tag: `<span class="tag soft">확인 필요</span>`, text: "결제 여부를 몰라 멈췄어요" };
  if (!w.interval || !w.due || w.status === WT.STATUS.NEEDS_INFO) return { tag: "", text: "결제일을 알려주면 알림이 시작돼요", needs: true };
  const left = WT.daysBetween(today, w.due);
  const when = left < 0 ? "예정일 지남" : left === 0 ? "오늘" : `${left}일 뒤`;
  if (w.kind === "trial") {
    const hot = left >= 0 && left <= 2;
    return { tag: `<span class="tag ${hot ? "orange" : "yellow"}">${when} 종료</span>`, text: ["무료 체험", chan].filter(Boolean).join(" · "), hot, left, sub: "끝나면 바로 결제돼요" };
  }
  /* 마지막 알림 단계에 들어오면 카드가 펼쳐진다 — 지금 결정해야 하는 것이라서. */
  const lead = WT.alertDaysBefore(w, ST.settings && ST.settings.lead).filter(d => d > 0);
  const hot = left >= 0 && left <= (lead.length ? Math.min(...lead) : 1);
  return { tag: `<span class="tag ${left <= (w.interval === "year" ? 30 : 7) ? "green" : "soft"}">${when}</span>`,
    text: [cyc + (w.auto === false ? " 직접 결제" : " 자동결제"), chan].filter(Boolean).join(" · "), hot, left, sub: `${koDate(w.due)}에 빠져나가요` };
}

/* 진행 바: 시작 → 알림 단계들 → 결제. 지난 단계는 색을 채운다. */
function stepsHtml(w, today, hot, longLabels) {
  if (!w.due || !w.interval) return "";
  const days = WT.alertDaysBefore(w, ST.settings && ST.settings.lead).filter(d => d > 0);
  const left = WT.daysBetween(today, w.due);
  const first = w.kind === "trial" ? (longLabels ? "시작" : "등록") : "지난 결제";
  const last = w.kind === "trial" ? (longLabels ? "종료일" : "종료") : (longLabels ? "결제일" : "결제");
  const labels = [first, ...days.map(d => `${d}일 전${longLabels ? " 알림" : ""}`), last];
  const passed = [true, ...days.map(d => left <= d), left <= 0];
  return `<div class="steps"><div class="bars">${passed.map(p => `<i class="${p ? "on" : ""}${p && hot ? " hot" : ""}"></i>`).join("")}</div>
    <div class="lbl">${labels.map((l, i) => `<span class="${passed[i] ? "on" : ""}">${l}</span>`).join("")}</div></div>`;
}

/* ── 히어로 위젯. 화면의 첫 문장은 "앞으로 30일 안에 나갈 돈"이다. */
function renderHero() {
  const box = document.getElementById("hero");
  const today = todayISO();
  const live = Object.keys(WATCH).filter(k => WT.isLive(WATCH[k]));
  if (!live.length) {
    box.innerHTML = `<div class="row"><span class="k">결제 전 알림</span></div>
      <div class="v text">카드 문자보다<br>먼저 알려드려요</div>
      <div class="sub">등록하면 결제 며칠 전에 원화 예상액과 함께 알림이 와요.</div>`;
    return;
  }
  const up = WT.upcoming(WATCH, today, 30);
  const sum = up.reduce((a, u) => a + (u.w.amountKrw || 0), 0);
  const unknownUp = up.filter(u => u.w.amountKrw == null).length;
  const mt = WT.monthlyTotal(WATCH);
  /* 바: 30일 안의 결제 중 이미 답한 것(계속 씁니다·해지)의 비율. 아무것도 안 했으면 0. */
  const done = up.filter(u => u.w.ackedFor === u.w.due).length;
  const pct = up.length ? Math.round(done / up.length * 100) : 0;
  const end = WT.addInterval(today, "month");
  box.innerHTML = `<div class="row"><span class="k">앞으로 30일</span><span class="cnt">구독 ${mt.count}개</span></div>
    <div class="v">${won(sum)}${unknownUp ? `<small>+ 미확인 ${unknownUp}건</small>` : ""}</div>
    <div class="sub">이 돈이 카드에서 빠져나가요 · 월 환산 ${won(mt.monthly)}</div>
    <div class="bar"><div class="track"><i style="width:${pct}%"></i></div><span>${mdText(today)} → ${mdText(end)}</span></div>`;
}

function renderWatch() {
  const box = document.getElementById("w-list");
  const keys = Object.keys(WATCH);
  renderHero();
  if (!keys.length) {
    box.innerHTML = `<div class="empty"><b>쓰고 있는 서비스를 눌러 주세요</b>
      <div class="tiles" id="w-empty-chips">${PS.search("", 7).map(p =>
        `<button type="button" data-preset="${esc(p.id)}">${PS.avatarHtml(p, 56)}<span>${esc(p.name.split(" ")[0])}</span></button>`).join("")}
        <button type="button" class="plus" id="w-empty-add"><span class="avatar">+</span><span>직접 입력</span></button></div></div>`;
    document.getElementById("w-empty-add").addEventListener("click", () => openForm(null, null, true));
    box.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => openForm(null, b.dataset.preset)));
    return;
  }
  const today = todayISO();
  const rank = { active: 0, pending: 1, "needs-info": 2, stale: 3, paused: 4, canceled: 5 };
  keys.sort((a, b) => ((rank[WATCH[a].status] ?? 2) - (rank[WATCH[b].status] ?? 2))
    || String(WATCH[a].due || "").localeCompare(String(WATCH[b].due || "")));

  box.innerHTML = keys.map(k => {
    const w = WATCH[k];
    const st = statusOf(w, today);
    const live = w.status === WT.STATUS.ACTIVE || w.status === WT.STATUS.PENDING;
    if (st.needs) {
      return `<div class="wc needs" data-open="${esc(k)}">
        <div class="t"><span class="avatar ghost">${esc(String(w.name || "?").charAt(0).toUpperCase())}</span>
          <div class="m"><div class="nm">${esc(w.name)}</div><div class="st">${esc(st.text)}</div></div>
          <button class="pill gray" style="height:34px;padding:0 12px;font-size:13px" data-w="edit" data-k="${esc(k)}">날짜 넣기</button></div></div>`;
    }
    /* 곧 결제되는 카드는 상태 줄·진행 바·버튼까지 펼쳐서 보여 준다 — 지금 결정해야 하는 것이라서. */
    if (st.hot && live) {
      return `<div class="wc card hot" data-open="${esc(k)}">
        <div class="t">${avatarOf(w, 44)}
          <div class="m"><div class="st">${esc(st.text)}</div><div class="nm">${esc(w.name)}</div></div>${amountCell(w)}</div>
        <div class="line">${st.tag}<span>${esc(st.sub)}</span></div>
        ${stepsHtml(w, today, true)}
        <div class="btns">
          ${WT.cancelUrl(w) ? `<button class="pill black" data-w="open" data-k="${esc(k)}">해지하러 가기</button>` : ""}
          <button class="pill gray" data-w="keep" data-k="${esc(k)}">계속 쓸래요</button>
        </div></div>`;
    }
    return `<div class="wc card" data-open="${esc(k)}">
      <div class="t">${avatarOf(w, 44)}
        <div class="m"><div class="st">${st.tag}<span>${esc(st.text)}</span></div><div class="nm">${esc(w.name)}</div></div>${amountCell(w)}</div></div>`;
  }).join("");

  box.querySelectorAll("[data-open]").forEach(el => el.addEventListener("click", (e) => {
    if (e.target.closest("[data-w]")) return;
    openDetail(el.dataset.open);
  }));
  bindActions(box);
}

/* 카드·상세 화면의 버튼 처리. 한 곳에서. */
function bindActions(root) {
  root.querySelectorAll("[data-w]").forEach(b => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const k = b.dataset.k, act = b.dataset.w;
    if (!WATCH[k]) return;
    if (act === "edit") return openForm(k);
    if (act === "site") { const u = WATCH[k].manageUrl || WATCH[k].sourceUrl; if (u) chrome.tabs.create({ url: u }); return; }
    if (act === "refund") { if (WATCH[k].refundUrl) chrome.tabs.create({ url: WATCH[k].refundUrl }); return; }
    if (act === "open") { const u = WT.cancelUrl(WATCH[k]); if (u) chrome.tabs.create({ url: u });
      WATCH[k] = WT.applyAction(WATCH[k], "cancel-go", todayISO()); }
    else if (act === "del") { delete WATCH[k]; }
    else { WATCH[k] = WT.applyAction(WATCH[k], act, todayISO()); }
    await chrome.storage.local.set({ watch: WATCH });
    if (VIEW === "detail" && WATCH[k]) renderDetail(k); else switchView("watch");
  }));
}

// ---------- 상세 화면 (시안 Detail) ----------
let DETAIL_KEY = null;
function openDetail(k) { DETAIL_KEY = k; switchView("detail"); }
function renderDetail(k) {
  const w = WATCH[k]; if (!w) return switchView("watch");
  const today = todayISO();
  const st = statusOf(w, today);
  const live = w.status === WT.STATUS.ACTIVE || w.status === WT.STATUS.PENDING;
  const chan = w.channel && PS.CHANNEL[w.channel] ? PS.CHANNEL[w.channel].label : "웹사이트";
  const cyc = w.interval === "year" ? "매년" : w.interval === "month" ? "매달" : "주기 미정";
  $w("dt-title").textContent = w.name;
  const krw = w.amountKrw != null ? won(w.amountKrw) : (!w.currency || w.currency === "KRW" ? won(w.amountOrig) : "");
  const orig = w.currency && w.currency !== "KRW" && w.amountOrig != null ? `${esc(w.currency)} ${w.amountOrig}` : "";
  $w("dt-main").innerHTML = `<div class="head">${avatarOf(w, 56)}<div><div class="s">${esc(w.kind === "trial" ? "무료 체험" : cyc + (w.auto === false ? " 직접 결제" : " 자동결제"))} · ${esc(chan)}</div><div class="nm">${esc(w.name)}</div></div></div>
    ${krw || orig ? `<div class="big"><span class="krw">${krw || orig}</span>${krw && orig ? `<span class="orig">${orig}</span>` : ""}</div>` : ""}
    ${st.needs ? `<div class="when"><span>${esc(st.text)}</span></div>` : `<div class="when">${st.tag}<span>${esc(st.sub || "")}</span></div>`}
    ${live ? stepsHtml(w, today, !!st.hot, true) : ""}
    <div class="btns">
      ${live && WT.cancelUrl(w) ? `<button class="pill black" data-w="open" data-k="${esc(k)}">해지하러 가기</button>` : ""}
      ${live && w.status === WT.STATUS.PENDING ? `<button class="pill gray" data-w="canceled" data-k="${esc(k)}">해지했어요</button>` : live ? `<button class="pill gray" data-w="keep" data-k="${esc(k)}">계속 쓸래요</button>` : ""}
      ${!live && w.status !== WT.STATUS.NEEDS_INFO ? `<button class="pill black" data-w="resume" data-k="${esc(k)}">알림 다시 받기</button>` : ""}
      ${st.needs ? `<button class="pill black" data-w="edit" data-k="${esc(k)}">날짜 넣기</button>` : ""}
    </div>`;
  const rows = [];
  if (w.refundNote) rows.push(`<div class="r"><span>환불</span><b class="${w.refundUrl ? "lnk" : ""}" ${w.refundUrl ? `data-w="refund" data-k="${esc(k)}"` : ""}>${esc(w.refundNote)}</b></div>`);
  const url = w.manageUrl || w.sourceUrl;
  if (url) { let host = url; try { host = new URL(url).host.replace(/^www\./, "") + new URL(url).pathname.replace(/\/$/, ""); } catch (e) { /* 그대로 */ }
    rows.push(`<div class="r"><span>해지 화면</span><b class="lnk" data-w="site" data-k="${esc(k)}">${esc(host)} ↗</b></div>`); }
  if (w.channel && w.channel !== "web" && PS.CHANNEL[w.channel]) rows.push(`<div class="r"><span>해지 방법</span><b>${esc(PS.CHANNEL[w.channel].cancelHint)}</b></div>`);
  if (w.lastPaid) rows.push(`<div class="r"><span>지난 결제</span><b>${esc(mdText(w.lastPaid))}${w.amountKrw != null ? " · " + won(w.amountKrw) : ""}</b></div>`);
  if (w.priceLog && w.priceLog.length) { const l = w.priceLog[w.priceLog.length - 1]; rows.push(`<div class="r"><span>확인한 금액</span><b>${esc(mdText(l.d))} · ${esc(l.currency)} ${l.amountOrig}</b></div>`); }
  $w("dt-info").innerHTML = rows.join("<hr>");
  $w("dt-info").style.display = rows.length ? "" : "none";
  $w("dt-acts").innerHTML = `<button class="pill" data-w="edit" data-k="${esc(k)}">수정</button>
    ${live ? `<button class="pill" data-w="pause" data-k="${esc(k)}">알림 끄기</button>` : w.status === WT.STATUS.PAUSED ? `<button class="pill" data-w="resume" data-k="${esc(k)}">알림 켜기</button>` : ""}
    <button class="pill danger" data-w="del" data-k="${esc(k)}">삭제</button>`;
  bindActions($w("view-detail"));
}

// ---------- 등록·수정 시트 (시안 Register) ----------
/* 로고 하나로 금액·주기·해지 화면이 채워지고, 사용자는 날짜 하나만 고른다.
   금액·주기를 고치고 싶으면 요약 줄을 누른다. 모르는 값을 추측해서 알림으로 만들지는 않는다. */
let EDIT_KEY = null;
const F = { kind: "sub", interval: "", channel: "web", preset: null, due: "" };

function segSet(id, v) {
  F[{ "w-kind": "kind", "w-int": "interval", "w-channel": "channel" }[id]] = v;
  $w(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  if (id === "w-kind") $w("w-due-label").textContent = v === "trial" ? "무료 체험이 끝나는 날" : "다음 결제일";
  renderPicked(); saveLabel();
}

/* 사업자번호를 넣은 사람은 결제창에서 부가세가 빠진다. 그 외에는 10%가 붙는 것이 기본이다. */
function vatApplies() { return !(ST.profile && ST.profile.brn); }

function currentKrw() {
  const amt = parseFloat(String($w("w-amt").value).replace(/[^\d.]/g, ""));
  if (isNaN(amt)) return null;
  return WT.estimateKrw(amt, $w("w-cur").value, ST.rates, { vat: vatApplies() });
}

function krwPreview() {
  const amt = parseFloat(String($w("w-amt").value).replace(/[^\d.]/g, ""));
  const cur = $w("w-cur").value;
  const krw = currentKrw();
  $w("w-krw").innerHTML = isNaN(amt) || cur === "KRW" ? "" : krw == null ? "환율을 아직 못 받았어요. 원화는 나중에 채워집니다."
    : `카드에는 약 <b>${won(krw)}</b> · 환율·해외수수료${vatApplies() ? "·부가세 10%" : ""} 포함`;
  renderPicked();
}

/* 요약 한 줄: 로고 · 이름 · 기본 요금 · 원화. 이름이 없으면 상자 전체를 숨긴다. */
function renderPicked() {
  const name = $w("w-name").value.trim();
  const box = $w("w-picked");
  if (!name) { box.style.display = "none"; return; }
  box.style.display = "";
  const p = F.preset ? PS.LIST.find(x => x.id === F.preset) : null;
  const amt = parseFloat(String($w("w-amt").value).replace(/[^\d.]/g, ""));
  const cur = $w("w-cur").value;
  const krw = currentKrw();
  const cyc = F.interval === "year" ? "매년" : F.interval === "month" ? "매달" : "주기 미정";
  $w("w-picked-row").innerHTML = `${PS.avatarHtml(p || { name, color: "#8A8A91" }, 44)}
    <div class="m"><div class="nm">${esc(name)}</div><div class="s">${isNaN(amt) ? "금액 미정" : `${esc(cur)} ${amt}`} · ${cyc}${p ? " · 기본 요금" : ""}</div></div>
    <div class="krw">${krw != null ? `<b>≈ ${won(krw)}</b><small>환율·수수료${vatApplies() ? "·부가세" : ""} 포함</small>` : `<small>눌러서 금액 입력</small>`}</div>`;
}

/* 등록 버튼 글자에 "언제 알릴지"를 미리 적는다. 누르기 전에 결과를 안다. */
function saveLabel() {
  const due = F.due;
  const t = $w("w-save-text");
  if (EDIT_KEY && (!due || !F.interval)) { t.textContent = "저장"; return; }
  if (!due || !F.interval) { t.textContent = F.kind === "trial" && !due ? "종료일을 골라 주세요" : "등록하기"; return; }
  const days = WT.alertDaysBefore({ interval: F.interval, kind: F.kind, auto: $w("w-auto").checked }, ST.settings && ST.settings.lead);
  const words = days.map(x => x === 0 ? "당일" : `${x}일 전`);
  const when = words.length > 1 ? words.slice(0, -1).join(", ") + "과 " + words[words.length - 1] : words[0];
  t.textContent = `${mdText(due)} ${F.kind === "trial" ? "종료" : "결제"} · ${when}에 알림`;
}

/* 날짜 띠: 오늘이 있는 주부터 12주. 가로로 넘긴다. */
function renderWeeks() {
  const box = $w("w-week");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(today.getDate() - today.getDay());
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const tIso = iso(today);
  let html = "";
  for (let wk = 0; wk < 12; wk++) {
    html += `<div class="w7">${DOW.map((d, i) => `<div class="dow ${i === 0 ? "sun" : ""}">${d}</div>`).join("")}`;
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + wk * 7 + i);
      const v = iso(d);
      const past = v < tIso;
      html += `<button type="button" class="d ${v === F.due ? "on" : ""} ${past ? "past" : ""} ${v === tIso ? "today" : ""}" data-d="${v}" ${past ? "disabled" : ""}>${d.getDate()}</button>`;
    }
    html += `</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-d]").forEach(b => b.addEventListener("click", () => setDue(b.dataset.d)));
  /* 고른 날이 있으면 그 주로 넘긴다 */
  const sel = box.querySelector(".d.on");
  if (sel) box.scrollLeft = sel.closest(".w7").offsetLeft - box.offsetLeft;
}
function setDue(v) {
  F.due = v || "";
  $w("w-due").value = F.due;
  $w("w-due-text").textContent = F.due ? koDate(F.due) : "달력에서 고르기";
  $w("w-week").querySelectorAll("[data-d]").forEach(b => b.classList.toggle("on", b.dataset.d === F.due));
  saveLabel();
}

function applyPreset(p) {
  F.preset = p ? p.id : null;
  $w("w-sugg").querySelectorAll("button").forEach(b => b.classList.toggle("on", !!p && b.dataset.preset === p.id));
  if (!p) { renderPicked(); return; }
  $w("w-name").value = p.name;
  $w("w-amt").value = p.amount;
  $w("w-cur").value = p.currency;
  segSet("w-int", p.interval);
  if (!$w("w-url").value) $w("w-url").value = p.manageUrl || "";
  $w("w-name-wrap").classList.remove("on");
  krwPreview();
}

function renderSugg(q) {
  const list = PS.search(q, 7);
  $w("w-sugg").innerHTML = list.map(p =>
    `<button type="button" data-preset="${esc(p.id)}" class="${F.preset === p.id ? "on" : ""}">${PS.avatarHtml(p, 56)}<span>${esc(p.name.split(" ")[0])}</span></button>`).join("")
    + `<button type="button" class="plus" id="w-plus"><span class="avatar">+</span><span>직접 입력</span></button>`;
  $w("w-sugg").querySelectorAll("[data-preset]").forEach(b =>
    b.addEventListener("click", () => applyPreset(PS.LIST.find(x => x.id === b.dataset.preset))));
  $w("w-plus").addEventListener("click", () => {
    F.preset = null; $w("w-sugg").querySelectorAll("button").forEach(b => b.classList.remove("on"));
    $w("w-name").value = ""; $w("w-amt").value = ""; $w("w-url").value = ""; segSet("w-int", "");
    $w("w-name-wrap").classList.add("on"); $w("w-adv").classList.add("on"); renderPicked(); $w("w-name").focus();
  });
}

/* 무료 한도. 수정은 언제나 되고, 새로 만들 때만 센다. */
function gateOk(key) {
  const g = PL.canAdd(WATCH, ST.plan, key);
  if (g.ok) return true;
  openPlus(g);
  return false;
}
let PLUS_NEXT = null; // Plus 확인 뒤 이어서 열 등록 폼 인자
function openPlus(g, next) {
  PLUS_NEXT = next || null;
  const n = g && g.count != null ? g.count : PL.activeCount(WATCH);
  $w("plus-lead").textContent = ST.plan && ST.plan.status === "past_due"
    ? "Plus 결제가 실패해 추가 등록이 멈췄어요. 등록해 둔 구독과 알림은 그대로입니다."
    : `지금 ${n}개를 등록해 두셨어요. 네 번째부터는 Donna Plus가 필요해요. 등록해 둔 구독은 그대로입니다.`;
  $w("plus-err").textContent = "";
  $w("plus-sheet").classList.add("on");
  $w("sheet-bg").classList.add("on");
}
function closePlus() { $w("plus-sheet").classList.remove("on"); $w("sheet-bg").classList.remove("on"); }
async function recheckPlus() {
  $w("plus-err").textContent = "";
  $w("plus-recheck").textContent = "확인하는 중…";
  const res = await new Promise(r => chrome.runtime.sendMessage({ type: "checkLicense" }, r));
  $w("plus-recheck").textContent = "이미 결제했어요 · 상태 다시 확인";
  if (res && res.plan) ST.plan = res.plan;
  if (PL.isPlus(ST.plan)) {
    closePlus(); renderMe();
    grabNote("Plus가 켜졌습니다. 이제 개수 제한 없이 등록할 수 있어요.");
    if (PLUS_NEXT) { const a = PLUS_NEXT; PLUS_NEXT = null; openForm(a.key, a.presetId, a.manual); }
  } else {
    $w("plus-err").textContent = res && res.ok
      ? "아직 Plus 결제가 확인되지 않았어요. 결제 후 1분쯤 지나 다시 눌러 주세요."
      : "지금은 확인할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.";
  }
}

function openForm(key, presetId, manual) {
  if (!key && !PL.canAdd(WATCH, ST.plan, null).ok) { openPlus(PL.canAdd(WATCH, ST.plan, null), { key, presetId, manual }); return; }
  EDIT_KEY = key || null;
  const w = key ? WATCH[key] : null;
  $w("w-form-title").textContent = w ? "구독 수정" : "무엇을 쓰고 있나요?";
  $w("w-form-lead").textContent = w ? "아는 내용만 고쳐 주세요." : "이름을 누르면 금액과 주기는 채워 드려요.";
  $w("w-err").textContent = "";
  $w("w-name").value = w ? (w.name || "") : "";
  $w("w-amt").value = w && w.amountOrig != null ? w.amountOrig : "";
  $w("w-cur").value = (w && w.currency) || "USD";
  $w("w-auto").checked = !w || w.auto !== false;
  $w("w-url").value = (w && w.manageUrl) || "";
  $w("w-name-wrap").classList.toggle("on", !!manual || (!!w && !presetOf(w)));
  $w("w-adv").classList.toggle("on", !!manual);
  F.preset = (w && w.presetId) || (w && presetOf(w) ? presetOf(w).id : null);
  segSet("w-kind", (w && w.kind) || "sub");
  segSet("w-int", (w && w.interval) || "");
  segSet("w-channel", (w && w.channel) || "web");
  F.due = (w && w.due) || "";
  renderSugg("");
  renderWeeks();
  setDue(F.due);
  krwPreview();
  $w("w-form").classList.add("on");
  $w("sheet-bg").classList.add("on");
  if (presetId) applyPreset(PS.LIST.find(x => x.id === presetId));
}
function closeForm() { EDIT_KEY = null; $w("w-form").classList.remove("on"); $w("sheet-bg").classList.remove("on"); }

function bindForm() {
  ["w-kind", "w-int", "w-channel"].forEach(id => $w(id).addEventListener("click", e => {
    const b = e.target.closest("button[data-v]"); if (b) segSet(id, b.dataset.v);
  }));
  $w("w-name").addEventListener("input", () => {
    const q = $w("w-name").value;
    if (F.preset) { const p = PS.LIST.find(x => x.id === F.preset); if (p && p.name !== q.trim()) F.preset = null; }
    renderPicked();
  });
  $w("w-picked-row").addEventListener("click", () => $w("w-adv").classList.toggle("on"));
  $w("w-amt").addEventListener("input", krwPreview);
  $w("w-cur").addEventListener("change", krwPreview);
  $w("w-auto").addEventListener("change", saveLabel);
  $w("w-due").addEventListener("input", () => setDue($w("w-due").value));
  $w("w-due-text").addEventListener("click", () => { try { $w("w-due").showPicker(); } catch (e) { $w("w-due").focus(); } });
  $w("sheet-bg").addEventListener("click", closeForm);
  $w("w-fab").addEventListener("click", () => openForm(null));
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
  $w("w-all-state").textContent = on ? "켜짐 · 끄기" : "끔";
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
    if (!gateOk(null)) return;

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
  const due = F.due;
  if (!name) { $w("w-err").textContent = "서비스를 누르거나 이름을 적어 주세요."; return; }
  if (F.kind === "trial" && !due) { $w("w-err").textContent = "무료 체험이 끝나는 날을 골라 주세요. 그날부터 돈이 나갑니다."; return; }
  const amt = parseFloat(String($w("w-amt").value).replace(/[^\d.\-]/g, ""));
  const cur = $w("w-cur").value;
  const krw = isNaN(amt) ? null : WT.estimateKrw(amt, cur, ST.rates, { vat: vatApplies() });
  const preset = F.preset ? PS.LIST.find(x => x.id === F.preset) : null;
  const key = EDIT_KEY || ("w" + Date.now().toString(36));
  if (!EDIT_KEY && !gateOk(null)) return;
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
  switchView("watch");
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
function renderPlan() {
  const plus = PL.isPlus(ST.plan);
  $w("me-plan-state").textContent = PL.statusText(ST.plan, WATCH);
  const btn = $w("me-plan-btn");
  btn.textContent = plus ? "관리" : (ST.plan && ST.plan.status === "past_due" ? "결제 수단 바꾸기" : "Plus 시작");
  $w("me-plan-hint").textContent = plus
    ? "해지해도 결제한 기간이 끝날 때까지 쓰고, 등록한 구독은 지워지지 않습니다."
    : "구독 3개까지 무료. 네 번째부터 3개월 6,000원. 결제는 donna.co.kr에서 합니다.";
}
function renderMe() {
  renderPlan();
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
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Donna//KR", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", "X-WR-CALNAME:해외 구독 결제일"
  ];
  let n = 0;
  for (const key of Object.keys(WATCH)) {
    const w = WATCH[key];
    if (!w || !w.due) continue;   // 주기를 몰라도 날짜만 있으면 1회성 일정으로 넣는다
    if (w.status !== WT.STATUS.ACTIVE && w.status !== WT.STATUS.PENDING) continue;
    const d = w.due.replace(/-/g, "");
    const amt = WT.amountText(w);
    const days = WT.alertDaysBefore(w, lead);

    L.push("BEGIN:VEVENT");
    L.push(`UID:svst-${encodeURIComponent(key)}-${d}@overseas-ai-subscription`);
    L.push(`DTSTAMP:${stamp}`);
    L.push(`DTSTART;VALUE=DATE:${d}`);
    if (w.interval) L.push(`RRULE:FREQ=${w.interval === "year" ? "YEARLY" : "MONTHLY"};INTERVAL=1`);
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
  if (!count) { $w("me-err").textContent = "캘린더에 넣을 구독이 없습니다. 다음 결제일이 있는 구독만 들어갑니다."; return; }
  $w("me-err").textContent = "";
  saveFile(`Donna_결제일_${todayISO()}.ics`, text, "text/calendar;charset=utf-8");
  flash("me-ics", `${count}건 저장됨 ✓`, "캘린더에 넣기");
}

function bindWatch() {
  $w("w-cancel").addEventListener("click", closeForm);
  $w("plus-cancel").addEventListener("click", closePlus);
  $w("plus-recheck").addEventListener("click", recheckPlus);
  $w("plus-go").addEventListener("click", () => chrome.tabs.create({ url: PL.plusUrl(ST.installId, "gate") }));
  $w("me-plan-btn").addEventListener("click", () => {
    const plus = PL.isPlus(ST.plan);
    const url = plus && ST.plan.manageUrl ? ST.plan.manageUrl + "&install=" + encodeURIComponent(ST.installId || "") : PL.plusUrl(ST.installId, plus ? "manage" : "settings");
    chrome.tabs.create({ url });
  });
  $w("me-plan-recheck").addEventListener("click", () => {
    const b = $w("me-plan-recheck"); b.textContent = "확인 중…";
    chrome.runtime.sendMessage({ type: "checkLicense" }, res => { if (res && res.plan) { ST.plan = res.plan; renderPlan(); } b.textContent = "상태 다시 확인"; });
  });
  $w("w-save").addEventListener("click", saveWatch);
  $w("w-enable").addEventListener("click", enableHere);
  $w("w-all").addEventListener("click", toggleAllSites);
  renderAllSites();
  $w("tab-me").addEventListener("click", () => switchView("me"));
  $w("me-back").addEventListener("click", () => switchView("watch"));
  $w("dt-back").addEventListener("click", () => switchView("watch"));
  $w("book-back").addEventListener("click", () => switchView("me"));
  $w("go-book").addEventListener("click", () => switchView("book"));
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

let VIEW = "watch";
function switchView(which) {
  VIEW = which;
  for (const v of ["watch", "detail", "me", "book"]) $w("view-" + v).classList.toggle("on", which === v);
  $w("fab").hidden = which !== "watch";
  if (which === "watch") renderWatch();
  if (which === "detail") renderDetail(DETAIL_KEY);
  if (which === "me") renderMe();
  if (which === "book") render();
  scrollTo(0, 0);
}

async function init() {
  /* 툴바 팝업은 창 자체가 좁다. 새 탭으로 열렸을 때만 조금 넓힌다 —
     넓다고 가로를 다 쓰면 글줄이 길어져 오히려 못 읽는다. */
  if (window.innerWidth > 620) document.body.classList.add("wide");

  const st = await chrome.storage.local.get(["ledger", "subs", "stats", "tasks", "profile", "suppliers", "watch", "settings", "plan", "installId"]);
  ST.plan = st.plan || null;
  ST.installId = st.installId || null;
  if (!ST.installId) chrome.runtime.sendMessage({ type: "checkLicense" }, res => { if (res && res.plan) { ST.plan = res.plan; } chrome.storage.local.get("installId").then(x => { ST.installId = x.installId || null; }); });
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
    if (changes.plan) { ST.plan = changes.plan.newValue || null; if (VIEW === "me") renderPlan(); }
    if (changes.installId) ST.installId = changes.installId.newValue || null;
    if (changes.watch) { WATCH = changes.watch.newValue || {}; if (!$w("w-form").classList.contains("on")) { if (VIEW === "detail") renderDetail(DETAIL_KEY); else if (VIEW === "watch") renderWatch(); } }
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
