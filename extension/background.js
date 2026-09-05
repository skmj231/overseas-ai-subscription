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

/* ── 사이드패널 ──
   툴바 아이콘을 누르면 팝업 대신 오른쪽 사이드패널이 열린다(ChatGPT·Claude 확장과 같은 자리).
   팝업은 다른 곳을 클릭하면 사라져서, 결제창을 보면서 등록하거나 해지 화면으로 건너갔다 돌아오는
   흐름이 매번 끊겼다. 패널은 탭을 바꿔도 열려 있고, 저장소가 바뀌면 그 자리에서 다시 그린다.
   이 호출은 설정값을 덮어쓰는 것이라 서비스 워커가 깰 때마다 불러도 된다. */
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

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
  /* 점검 화면(test.html)이 상황을 만든 뒤 "지금 한 번 돌려 보라"고 부른다.
     알람은 12시간마다 깨어나므로, 손으로 확인할 때는 기다릴 수가 없다. */
  if (msg && msg.type === "runTick") {
    tick().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg && msg.type === "openBook") {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  }
  /* 결제창 패널이나 온보딩 화면의 버튼에서 온다. 클릭 직후에만 열 수 있고(브라우저 규칙),
     await를 한 번이라도 거치면 그 권한이 사라지므로 여기서 바로 연다. */
  if (msg && msg.type === "openPanel") {
    const windowId = sender && sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ windowId }).catch(() => {});
    }
  }
  /* 화면에서 실제로 읽은 금액이 들어온다. 알림 목록의 금액을 최신으로 맞추고,
     달라졌으면 그 사실만 한 번 알린다. 같으면 조용히 관측 시각만 갱신한다. */
  if (msg && msg.type === "observePrice" && msg.data) {
    (async () => {
      const d = msg.data;
      const { watch = {}, consent = null, stats = {} } =
        await chrome.storage.local.get(["watch", "consent", "stats"]);
      const w = watch[d.key];
      if (!consent || !w) return sendResponse({ ok: false });
      const today = todayISO();

      /* 구독관리 화면에서 '취소됨'이 보였다. 묻지 않고 해지로 처리한다. */
      if (d.canceled && w.status !== WATCH.STATUS.CANCELED) {
        const add = WATCH.savedByCancel(w);
        watch[d.key] = WATCH.applyAction(w, "canceled", today);
        const next = add > 0 ? { ...stats, canceledYear: Math.round((stats.canceledYear || 0) + add) } : stats;
        await chrome.storage.local.set({ watch, stats: next });
        return sendResponse({ ok: true, canceled: true });
      }

      const r = WATCH.recordPrice(w, d, today);
      watch[d.key] = { ...r.w, manageUrl: d.manageUrl || r.w.manageUrl };
      await chrome.storage.local.set({ watch });

      if (r.changed && r.before && r.before.amountOrig != null) {
        const fmt = (v, c) => (c && c !== "KRW" ? `${c} ${v}` : `₩${Math.round(v).toLocaleString("ko-KR")}`);
        notify(`svst-price-${d.key}-${today}`, `${w.name} 금액이 달라졌습니다`,
          `${fmt(r.before.amountOrig, r.before.currency)} → ${fmt(r.w.amountOrig, r.w.currency)}`, null);
      }
      sendResponse({ ok: true, changed: r.changed });
    })();
    return true;
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
            manageUrl: made.manageUrl || watch[key].manageUrl,
            sourceUrl: made.sourceUrl || watch[key].sourceUrl,
            status: made.status, misses: 0 }
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
const SET_DEFAULT = { notify: true, lead: WATCH.LEAD_DEFAULT };
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
 * 언제 알릴지는 watch.js의 LEAD_DEFAULT와 사용자 설정이 정한다.
 *   연 자동결제 → 30일 전, 7일 전, 1일 전   (금액이 크니 판단할 시간을 넉넉히)
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
  const { subs = {}, notified = {}, watch = {} } =
    await chrome.storage.local.get(["subs", "notified", "watch"]);
  const today = todayISO();
  const upcoming = [], overdue = [], trials = [];
  let touched = false;

  /* 같은 구독이 subs(세무 관측)와 watch(사용자가 켠 알림) 양쪽에 있을 수 있다.
     둘 다 결제 전 알림을 만들면 한 건에 알림이 두 번 간다. 문구도 서로 다르게 나간다.
     결제 전 알림은 watch 쪽이 금액을 언제 본 것인지까지 말하므로 그쪽에 넘기고,
     여기서는 영수증 확정과 무료 체험만 맡는다. */
  const watchedHere = (mkey) => {
    const w = watch[mkey];
    return !!w && (w.status === WATCH.STATUS.ACTIVE || w.status === WATCH.STATUS.PENDING);
  };

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
    /* 남은 날이 속한 가장 가까운 단계 하나만. (watch.js planTick과 같은 규칙) */
    const slot = watchedHere(mkey) ? null
      : alertDaysBefore({ interval: s.interval, auto }).filter(d => left >= 0 && left <= d).sort((a, b) => a - b)[0];
    if (slot != null) {
      const key = `pre-${mkey}-${next}-${slot}`;
      if (!notified[key]) {
        upcoming.push({ mkey, merchant: s.merchant || "구독", date: next, left, auto,
          amountKrw: s.amountKrw, currency: s.currency, amountOrig: s.amountOrig, key });
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
          `${amt}이 자동으로 빠져나갑니다. 해외 서비스는 결제되고 나면 환불이 어렵습니다.`)
      : notify(`svst-pre-${u.mkey}-${u.left}`, `${u.merchant} 결제하실 때가 됐어요`,
          `지난번 이맘때 ${amt}을 결제하셨습니다. 이번에도 필요하신가요?`);
    if (fired) { notified[u.key] = true; touched = true; }
  }

  if (trials.length) {
    const names = trials.map(d => d.merchant).join(", ");
    const t = notify(`svst-trial-${Date.now()}`, "무료 체험이 곧 유료로 바뀝니다",
      `${names}. 계속 쓰실 거면 지금 사업자번호를 등록하세요. 첫 결제부터 부가세가 빠집니다. ` +
      `안 쓰실 거면 오늘 안에 해지하시면 됩니다.`);
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
  const { watch = {}, notified = {}, notiMap = {}, ledger = [], consent = null } =
    await chrome.storage.local.get(["watch", "notified", "notiMap", "ledger", "consent"]);
  const today = todayISO();
  const { notifications, updates, records } = WATCH.planTick(watch, today, notified, SET.lead);
  if (!notifications.length && !Object.keys(updates).length && !(records || []).length) return;

  for (const n of notifications) {
    const m = WATCH.messageFor(n.kind, n.w, n.left, { fresh: n.fresh, ago: n.ago });
    const id = `svstw-${n.key}-${Date.now()}`;
    if (!notify(id, m.title, m.message, m.buttons)) continue;
    /* 해지하러 갈 주소는 채널을 본다. 앱스토어 결제를 사이트에서 해지하면 돈이 계속 나간다. */
    notiMap[id] = { key: n.key, actions: m.actions, url: WATCH.cancelUrl(n.w) };
    notified[n.nkey] = true;
  }
  for (const k of Object.keys(updates)) {
    if (watch[k]) watch[k] = { ...watch[k], ...updates[k] };
  }
  /* 동의 전에는 한 바이트도 쓰지 않는다. 추정 행도 예외가 아니다. */
  const next = consent ? addEstimated(ledger, records) : ledger;
  await chrome.storage.local.set({ watch, notified, notiMap, ledger: next });
}

/* 추정 행은 id가 결정적이라(구독키 + 날짜) 몇 번 돌아도 한 줄만 남는다. */
function addEstimated(ledger, records) {
  const out = ledger.slice();
  for (const r of (records || [])) {
    if (!out.some(x => x.id === r.id)) out.push(r);
  }
  return out;
}

/* 버튼을 누른 그 순간이 정보가 가장 정확한 시점이다. 나중에 물으면 기억이 흐려지고 답도 안 한다. */
chrome.notifications.onButtonClicked.addListener(async (id, idx) => {
  const { watch = {}, notiMap = {} } = await chrome.storage.local.get(["watch", "notiMap"]);
  const entry = notiMap[id];
  if (!entry || !watch[entry.key]) return;
  const action = (entry.actions || [])[idx];
  if (!action) return;

  const today = todayISO();
  const before = watch[entry.key];

  /* '금액 확인하기'는 상태를 바꾸지 않는다. 화면을 열어 줄 뿐이고,
     실제 갱신은 그 페이지에서 content.js가 숫자를 읽었을 때 일어난다.
     여기서 미리 "확인했다"고 표시해 버리면, 못 읽었을 때도 확인한 것이 된다. */
  if (action === "verify") {
    delete notiMap[id];
    await chrome.storage.local.set({ notiMap });
    chrome.notifications.clear(id);
    if (entry.url) chrome.tabs.create({ url: entry.url });
    return;
  }

  watch[entry.key] = WATCH.applyAction(before, action, today);

  const { ledger = [], stats = {}, consent = null } =
    await chrome.storage.local.get(["ledger", "stats", "consent"]);
  let nextLedger = ledger, nextStats = stats;

  /* '결제됐어요'는 결제가 일어났다는 가장 확실한 답이다. 그런데 그 화면은 못 봤다.
     기록함이 비는 걸 막기 위해 마지막으로 본 금액으로 추정 한 줄을 남긴다. */
  if (action === "paid" && consent) {
    const row = WATCH.estimatedRow(before, entry.key, before.due || today);
    if (row) nextLedger = addEstimated(ledger, [row]);
  }

  /* 해지로 1년에 안 나가게 된 돈을 센다. 부가세로 아낀 실제 금액과는 단위가 달라
     같은 숫자에 섞지 않고 따로 쌓는다. */
  if (action === "canceled" && consent) {
    const add = WATCH.savedByCancel(before);
    if (add > 0) {
      nextStats = { ...stats, canceledYear: Math.round((stats.canceledYear || 0) + add) };
      notify(`svst-cancel-${Date.now()}`,
        `${before.name} 해지하셨습니다`,
        `1년에 ₩${add.toLocaleString("ko-KR")}을 안 내도 됩니다.`, null);
    }
  }

  delete notiMap[id];
  await chrome.storage.local.set({ watch, notiMap, ledger: nextLedger, stats: nextStats });
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

// ---------- 월 1회 요약 ----------
/* 설치하고 두 주가 지나면 이 도구가 사용자에게 하는 말은 "돈 나간다"뿐이다.
   나쁜 소식만 오는 물건은 결국 꺼진다. 한 달에 한 번, 지금 상태를 한 줄로 알린다.
   새 권한도 서버도 필요 없다. 이미 가진 숫자를 더하는 것이 전부다. */
async function checkMonthly() {
  const { watch = {}, ledger = [], stats = {}, notified = {}, consent = null } =
    await chrome.storage.local.get(["watch", "ledger", "stats", "notified", "consent"]);
  if (!consent) return;

  const today = todayISO();
  const key = "mo-" + today.slice(0, 7);
  if (notified[key]) return;
  if (Number(today.slice(8, 10)) < 2) return;   // 달이 바뀌자마자 보내면 숫자가 빈다

  const live = Object.keys(watch).filter(k => {
    const w = watch[k];
    return w && (w.status === WATCH.STATUS.ACTIVE || w.status === WATCH.STATUS.PENDING);
  });
  if (!live.length) return;

  /* 월 환산 합계. 연 구독은 12로 나눈다. 금액을 모르는 건은 빼고 세고, 몇 건인지 밝힌다. */
  let monthly = 0, unknown = 0;
  for (const k of live) {
    const w = watch[k];
    if (w.amountKrw == null) { unknown++; continue; }
    monthly += w.interval === "year" ? w.amountKrw / 12 : w.amountKrw;
  }

  const stale = live.filter(k => WATCH.freshness(watch[k], today) === WATCH.FRESH.STALE).length;
  const review = ledger.filter(r => r.supplier === "unknown" || r.status === "estimated").length;
  const savedYear = stats.canceledYear || 0;
  const vatYear = WATCH.vatFreeYear(stats);

  const parts = [`구독 ${live.length}건 · 월 ₩${Math.round(monthly).toLocaleString("ko-KR")}`];
  if (unknown) parts.push(`금액 미확인 ${unknown}건`);
  if (stale) parts.push(`금액 확인할 때가 된 것 ${stale}건`);
  if (review) parts.push(`세무 확인 필요 ${review}건`);
  /* 둘 다 "앞으로 1년에 안 나갈 돈"이다. 이미 번 돈이 아니므로 그렇게 부르지 않는다. */
  if (vatYear > 0) parts.push(`부가세를 안 내도 되어 1년에 ₩${vatYear.toLocaleString("ko-KR")}`);
  if (savedYear > 0) parts.push(`해지해서 1년에 ₩${savedYear.toLocaleString("ko-KR")}`);

  if (!notify(`svst-mo-${key}`, `${today.slice(5, 7)}월 해외 구독 정리`, parts.join("\n"))) return;
  notified[key] = true;
  await chrome.storage.local.set({ notified });
}

async function tick() {
  await loadSettings();
  await checkRenewals();
  await checkWatch();
  await checkDeadlines();
  await checkMonthly();
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create("svst-daily", { periodInMinutes: 60 * 12 });
  tick();
  /* 업데이트 때마다 띄우면 기존 사용자를 방해한다. 처음 설치한 사람에게만
     예시 체험과 첫 구독 등록 화면을 연다. */
  if (details && details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
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
