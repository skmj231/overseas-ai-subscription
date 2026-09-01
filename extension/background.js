/* 해외AI구독관리 background — 환율 + 자동갱신 팔로업 + 신고 마감 알림 + 결제 전 알림
 *
 * 자동갱신 문제: 갱신 결제는 브라우저 밖에서 일어나 확장이 직접 볼 수 없다.
 * 대신 구독 원장(subs)으로 갱신 예정일을 계산해 두고, 그날이 지나면 알람이 깨어나
 * "영수증 메일 링크를 열어주세요"라고 알린다. 링크를 열면 content.js가 실제 금액으로 확정한다.
 */

/* 결제 전 알림(watch)은 세무 기능과 저장소부터 분리되어 있다.
   subs = Stripe에서 관측한 결제(세무 자료로 나감)
   watch = 사용자가 알려준 구독 일정(알림 전용, 어떤 파일로도 나가지 않음)
   아래 두 루프는 서로를 건드리지 않는다. */
importScripts("watch.js");
const WATCH = self.SVSTWatch;

// ---------- 환율 ----------
/* USD 기준 전체 rates를 통째로 캐시한다. EUR·GBP·JPY 결제도 환산해야 하기 때문. */
async function getRates() {
  const { fxCache } = await chrome.storage.local.get("fxCache");
  const now = Date.now();
  if (fxCache && fxCache.rates && now - fxCache.ts < 12 * 3600 * 1000) return fxCache.rates;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const j = await r.json();
    if (j && j.rates && j.rates.KRW) {
      await chrome.storage.local.set({ fxCache: { rates: j.rates, ts: now } });
      return j.rates;
    }
  } catch (e) { /* 네트워크 실패 — 캐시라도 쓴다 */ }
  return (fxCache && fxCache.rates) || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.type === "getRates" || msg.type === "getUsdKrw")) {
    getRates().then(rates => sendResponse({ rates, rate: rates ? rates.KRW : null }));
    return true;
  }
  if (msg && msg.type === "openBook") {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  }
  /* 결제창에서 켠 알림. 같은 서비스를 두 번 등록하면 목록이 지저분해지고 알림도 두 번 간다.
     그래서 키가 같으면 새로 만들지 않고 금액·주기만 최신으로 고친다. */
  if (msg && msg.type === "addWatch" && msg.data) {
    (async () => {
      const d = msg.data;
      const key = String(d.key || "").slice(0, 40) || "sub" + Date.now();
      const { watch = {} } = await chrome.storage.local.get("watch");
      const made = WATCH.makeWatch(d, todayISO());
      watch[key] = watch[key]
        ? { ...watch[key], name: made.name, amountOrig: made.amountOrig, currency: made.currency,
            amountKrw: made.amountKrw, interval: made.interval, due: made.due,
            manageUrl: made.manageUrl || watch[key].manageUrl, status: WATCH.STATUS.ACTIVE, misses: 0 }
        : made;
      await chrome.storage.local.set({ watch });
      sendResponse({ ok: true, key });
    })();
    return true;
  }
});

// ---------- 날짜 ----------
function addInterval(dateStr, interval) {
  const [y, m, day] = String(dateStr).split("-").map(Number);
  let ny = y, nm = m;
  if (interval === "year") ny += 1; else { nm += 1; if (nm > 12) { nm = 1; ny += 1; } }
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}
/* UTC 날짜를 쓰면 한국에서는 자정부터 오전 9시까지 '어제'로 계산된다.
   알림은 사용자의 현지 날짜를 기준으로 해야 결제일까지 남은 날이 맞다. */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400e3);

/* ── 알림 설정 ──
   전체를 끌 수 있어야 하고, 며칠 전에 받을지도 고를 수 있어야 한다.
   고정해 두면 성가신 사람은 확장을 지우지 알림만 끄지 않는다. */
const SET_DEFAULT = { notify: true, lead: { year: [14, 3], month: [5, 1] } };
let SET = SET_DEFAULT;

async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  SET = {
    notify: !settings || settings.notify !== false,
    lead: (settings && settings.lead) || SET_DEFAULT.lead
  };
  return SET;
}

function notify(id, title, message, buttons) {
  if (SET.notify === false) return false;   // 한 곳에서만 막는다 — 기록과 상태는 그대로 돈다
  try {
    const opt = { type: "basic", iconUrl: "icon128.png", title, message, priority: 1 };
    if (buttons && buttons.length) opt.buttons = buttons.map(t => ({ title: t }));
    chrome.notifications.create(id, opt);
    return true;
  } catch (e) { /* 알림이 막혀 있어도 기록함의 '추정' 행은 그대로 남는다 */ }
  return false;
}

// ---------- 결제 예정 알림 ----------
/* 이 알림이 이 제품에서 가장 값싸고 가장 고마운 기능이다.
 *
 * 해외 툴은 결제된 뒤에 환불받기가 대단히 어렵다. 대부분 안 된다.
 * 그래서 "결제됐습니다"는 늦은 소식이고, "곧 결제됩니다"가 진짜 도움이다.
 * 안 쓸 구독이면 그 며칠 사이에 해지하면 되고, 그건 부가세 절감보다 큰 돈이다.
 *
 * 언제 알릴지는 rules.js의 alertDaysBefore가 정한다.
 *   연 자동결제 → 14일 전, 3일 전   (금액이 크니 판단할 시간을 넉넉히)
 *   월 자동결제 → 5일 전, 1일 전
 *   수동 반복   → 결제하던 날 당일 ("이번 달도 필요하신가요")
 */
const won = (n) => n == null ? "" : "₩" + Math.round(n).toLocaleString("ko-KR");

function alertDaysBefore(billing) {
  if (!billing || !billing.interval) return [];
  if (!billing.auto) return [0];
  const key = billing.interval === "year" ? "year" : "month";
  const picked = SET.lead && Array.isArray(SET.lead[key]) && SET.lead[key].length
    ? SET.lead[key] : SET_DEFAULT.lead[key];
  return picked.slice().sort((a, b) => b - a);
}

async function checkRenewals() {
  const { subs = {}, notified = {} } = await chrome.storage.local.get(["subs", "notified"]);
  const today = todayISO();
  const upcoming = [], overdue = [], trials = [];
  let touched = false;

  for (const mkey of Object.keys(subs)) {
    const s = subs[mkey];
    if (!s.lastPaid || !s.interval) continue;
    const next = addInterval(s.lastPaid, s.interval);
    const left = daysBetween(today, next);
    const auto = s.auto !== false;

    if (s.trial) {
      if (left >= 0 && left <= 3 && notified["trial-" + mkey] !== next) {
        trials.push({ mkey, merchant: s.merchant || "구독", date: next, left });
      }
      continue;
    }

    /* 결제 전 — 판단할 시간을 준다.
       'left === d' 로 정확히 맞추면 그날 브라우저를 안 켠 사람은 영영 못 받는다.
       'left <= d' 로 두고 키로 중복만 막으면, 늦게라도 반드시 한 번은 간다. */
    for (const d of alertDaysBefore({ interval: s.interval, auto })) {
      const key = `pre-${mkey}-${next}-${d}`;
      if (left >= 0 && left <= d && !notified[key]) {
        upcoming.push({ mkey, merchant: s.merchant || "구독", date: next, left, auto,
          amountKrw: s.amountKrw, currency: s.currency, amountOrig: s.amountOrig, key });
        break;
      }
    }

    // 결제일이 지났는데 영수증이 아직 안 잡힘 — 기록을 확정해야 한다
    if (next <= today && notified[mkey] !== next) {
      overdue.push({ mkey, merchant: s.merchant || "구독", date: next });
    }
  }

  for (const u of upcoming) {
    const amt = u.currency && u.currency !== "KRW"
      ? `${u.currency} ${u.amountOrig} (약 ${won(u.amountKrw)})`
      : won(u.amountKrw);
    const fired = u.auto
      ? notify(`svst-pre-${u.mkey}-${u.left}`,
          u.left === 0 ? `${u.merchant} 오늘 자동 결제됩니다` : `${u.merchant} ${u.left}일 뒤 자동 결제`,
          `${amt}이 자동으로 빠져나갑니다. 계속 쓰실 거면 그냥 두시면 되고, ` +
          `안 쓰실 거면 지금 해지하세요. 해외 서비스는 결제 후 환불이 어렵습니다.`)
      : notify(`svst-pre-${u.mkey}-${u.left}`, `${u.merchant} 결제하실 때가 됐어요`,
          `지난번 이맘때 ${amt}을 결제하셨습니다. 이번에도 필요하신가요?`);
    if (fired) { notified[u.key] = true; touched = true; }
  }

  if (trials.length) {
    const names = trials.map(d => d.merchant).join(", ");
    const t = notify(`svst-trial-${Date.now()}`, "무료 체험이 곧 유료로 바뀝니다",
      `${names} — 계속 쓰실 거면 지금 사업자번호를 등록하세요. 첫 결제부터 부가세가 빠집니다. ` +
      `안 쓰실 거면 지금이 해지할 마지막 기회입니다.`);
    if (t) { trials.forEach(d => { notified["trial-" + d.mkey] = d.date; }); touched = true; }
  }

  if (overdue.length) {
    const names = overdue.map(d => d.merchant).join(", ");
    const o = notify(`svst-renew-${Date.now()}`, "결제 기록을 확정해 주세요",
      overdue.length === 1
        ? `${names} 결제일이 지났어요. 영수증 메일의 링크를 한 번 열면 실제 금액으로 기록됩니다.`
        : `${names} 등 ${overdue.length}건의 결제일이 지났어요. 영수증 메일 링크를 열면 기록됩니다.`);
    if (o) { overdue.forEach(d => { notified[d.mkey] = d.date; }); touched = true; }
  }

  if (touched) await chrome.storage.local.set({ notified });
}

// ---------- 결제 전 알림 (결제 수단 무관) ----------
/* 여기서 중요한 건 알리는 규칙이 아니라 멈추는 규칙이다.
   끊은 구독을 계속 알리면 사용자는 알림을 끄는 게 아니라 확장을 지운다.
   판정은 전부 watch.js의 순수 함수가 하고, 여기서는 저장과 발송만 한다. */
async function checkWatch() {
  const { watch = {}, notified = {}, notiMap = {} } = await chrome.storage.local.get(
    ["watch", "notified", "notiMap"]);
  const today = todayISO();
  const { notifications, updates } = WATCH.planTick(watch, today, notified, SET.lead);
  if (!notifications.length && !Object.keys(updates).length) return;

  for (const n of notifications) {
    const m = WATCH.messageFor(n.kind, n.w, n.left);
    const id = `svstw-${n.key}-${Date.now()}`;
    if (!notify(id, m.title, m.message, m.buttons)) continue;
    notiMap[id] = { key: n.key, actions: m.actions, url: n.w.manageUrl || null };
    notified[n.nkey] = true;
  }
  for (const k of Object.keys(updates)) {
    if (watch[k]) watch[k] = { ...watch[k], ...updates[k] };
  }
  await chrome.storage.local.set({ watch, notified, notiMap });
}

/* 버튼을 누른 그 순간이 정보가 가장 정확한 시점이다. 나중에 물으면 기억이 흐려지고 답도 안 한다. */
chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  const { watch = {}, notiMap = {} } = await chrome.storage.local.get(["watch", "notiMap"]);
  const entry = notiMap[id];
  if (!entry || !watch[entry.key]) return;
  const action = (entry.actions || [])[idx];
  if (!action) return;

  watch[entry.key] = WATCH.applyAction(watch[entry.key], action, todayISO());
  delete notiMap[id];
  await chrome.storage.local.set({ watch, notiMap });
  chrome.notifications.clear(id);

  // '해지하러 가기'는 말만 하고 끝나면 안 된다. 실제로 그 화면을 열어 준다.
  if (action === "cancel-go" && entry.url) chrome.tabs.create({ url: entry.url });
});

// ---------- 신고 마감 알림 ----------
/* 부가세 1/25·7/25(개인 확정), 4/25·10/25(예정), 종합소득세 5/31.
   마감 2주 전에 "지금 내보내서 세무사에게 보내세요"라고 한 번만 알린다. */
const DEADLINES = [
  { mmdd: "01-25", label: "부가가치세 2기 확정신고" },
  { mmdd: "04-25", label: "부가가치세 1기 예정신고" },
  { mmdd: "05-31", label: "종합소득세 신고" },
  { mmdd: "07-25", label: "부가가치세 1기 확정신고" },
  { mmdd: "10-25", label: "부가가치세 2기 예정신고" }
];

async function checkDeadlines() {
  const { ledger = [], notified = {} } = await chrome.storage.local.get(["ledger", "notified"]);
  if (!ledger.length) return;
  const today = todayISO();
  const y = Number(today.slice(0, 4));

  for (const d of DEADLINES) {
    for (const yy of [y, y + 1]) {
      const date = `${yy}-${d.mmdd}`;
      const left = daysBetween(today, date);
      const key = `dl-${date}`;
      if (left >= 10 && left <= 14 && notified[key] !== date) {
        if (!notify(`svst-dl-${date}`, `${d.label} ${left}일 전`,
          "기록함에서 분기 자료를 내려받아 세무대리인께 보내세요. 미확인 항목이 있으면 함께 표시됩니다.")) return;
        notified[key] = date;
        await chrome.storage.local.set({ notified });
        return;
      }
    }
  }
}

async function tick() { await loadSettings(); await checkRenewals(); await checkWatch(); await checkDeadlines(); }

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("svst-daily", { periodInMinutes: 60 * 12 });
  tick();
});
chrome.runtime.onStartup.addListener(tick);
chrome.alarms.onAlarm.addListener(a => { if (a.name === "svst-daily") tick(); });

/* 업데이트나 브라우저 복구 뒤 알람이 사라져도 서비스 워커가 깨어날 때 복구한다. */
chrome.alarms.get("svst-daily").then(alarm => {
  if (!alarm) chrome.alarms.create("svst-daily", { periodInMinutes: 60 * 12 });
});

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});
