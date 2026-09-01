/* 해외AI구독관리 · watch.js — 결제 전 알림 전용 로직
 *
 * 세무 판정(rules.js)과 완전히 분리되어 있다. 여기 들어오는 값은 우리가 관측한 것이 아니라
 * 사용자가 알려준 '일정'이다. 그래서 원장(ledger)에도, 분기 CSV에도, 세무대리인에게 가는
 * 어떤 파일에도 들어가지 않는다. 섞이면 안 되는 것이라 저장소부터 나눠 둔다.
 *
 * DOM도 chrome API도 쓰지 않는다 → node에서 그대로 테스트한다(tests/run.js).
 *
 * 이 파일에서 제일 중요한 건 알림을 보내는 규칙이 아니라 '멈추는 규칙'이다.
 * 끊은 구독을 매달 "곧 결제됩니다"라고 알리기 시작하면 사용자는 알림을 끄는 게 아니라
 * 확장을 지운다. 그러면 세무 기능까지 같이 사라진다.
 */
(function (root) {
  "use strict";

  const STATUS = {
    ACTIVE: "active",     // 예정대로 알린다
    PENDING: "pending",   // '해지하러 가기'를 눌렀다 — 결과는 아직 모른다
    CANCELED: "canceled", // 해지 확인됨. 알리지 않는다
    STALE: "stale",       // 두 주기 무응답. 알리지 않고 '확인 필요'로만 남긴다
    PAUSED: "paused"      // 사용자가 이 구독 알림만 껐다
  };

  const GRACE_DAYS = 7;   // 물어본 뒤 이만큼 기다린다
  const MAX_MISSES = 2;   // 이만큼 연속으로 답이 없으면 조용해진다

  // ---------- 날짜 ----------
  function addInterval(dateStr, interval) {
    const [y, m, day] = String(dateStr).split("-").map(Number);
    let ny = y, nm = m;
    if (interval === "year") ny += 1;
    else { nm += 1; if (nm > 12) { nm = 1; ny += 1; } }
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  }
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400e3);

  /* 예정일이 이미 여러 주기 지나 있어도 오늘 기준으로 한 번에 끌어온다.
     확장을 오래 안 켠 사람에게 지난 알림을 몰아서 쏘지 않기 위해서다. */
  function dueFrom(anchor, interval, today) {
    if (!anchor || !interval) return null;
    let d = anchor;
    let guard = 0;
    while (d < today && guard++ < 200) d = addInterval(d, interval);
    return d;
  }

  // ---------- 언제 알릴 것인가 ----------
  /* rules.js의 규칙과 같은 값이지만 여기서 다시 정의한다.
     세무 쪽 규칙이 바뀌어도 알림이 따라 흔들리면 안 되기 때문이다. */
  /* 며칠 전에 알릴지. 기본값은 연 14·3일, 월 5·1일이지만
     '내 정보'에서 사용자가 바꿀 수 있다. 알림은 사람마다 적당한 간격이 다르고,
     너무 잦으면 꺼 버리기 때문에 고정해 두면 안 되는 값이다. */
  const LEAD_DEFAULT = { year: [14, 3], month: [5, 1] };

  function alertDaysBefore(w, lead) {
    if (!w || !w.interval) return [];
    if (w.auto === false) return [0];
    const key = w.interval === "year" ? "year" : "month";
    const picked = lead && Array.isArray(lead[key]) && lead[key].length ? lead[key] : LEAD_DEFAULT[key];
    return picked.slice().sort((a, b) => b - a);
  }

  // ---------- 새 구독 ----------
  function makeWatch(input, today) {
    const interval = input.interval === "year" ? "year" : "month";
    const anchor = input.nextDue || (input.lastPaid ? addInterval(input.lastPaid, interval) : null);
    return {
      name: (input.name || "").trim() || "이름 없는 구독",
      amountOrig: input.amountOrig != null ? Number(input.amountOrig) : null,
      currency: input.currency || "KRW",
      amountKrw: input.amountKrw != null ? Number(input.amountKrw) : null,
      interval,
      auto: input.auto !== false,
      lastPaid: input.lastPaid || null,
      due: dueFrom(anchor, interval, today),
      manageUrl: input.manageUrl || null,
      source: input.source || "manual",
      status: STATUS.ACTIVE,
      misses: 0,
      ackedFor: null,
      createdAt: today
    };
  }

  // ---------- 알림 문구 ----------
  const won = (n) => n == null ? "" : "₩" + Math.round(n).toLocaleString("ko-KR");
  function amountText(w) {
    if (w.currency && w.currency !== "KRW" && w.amountOrig != null) {
      return w.amountKrw != null
        ? `${w.currency} ${w.amountOrig} (약 ${won(w.amountKrw)})`
        : `${w.currency} ${w.amountOrig}`;
    }
    return won(w.amountKrw != null ? w.amountKrw : w.amountOrig);
  }

  function messageFor(kind, w, left) {
    /* 금액을 못 읽은 채로 등록된 구독이 있다. 처음 보는 결제창에서 알림만 건 경우다.
       그때 금액 자리를 비워 두면 "이 자동으로 빠져나갑니다" 같은 문장이 된다.
       빈칸을 남기지 말고 문장 자체를 바꾼다. */
    const amt = amountText(w);
    if (kind === "pre" && w.auto !== false) {
      return {
        title: left === 0 ? `${w.name} · 오늘 자동 결제` : `${w.name} · ${left}일 뒤 자동 결제`,
        message: (amt ? `${amt}이 자동으로 빠져나갑니다. ` : "자동으로 결제됩니다. ") +
                 `안 쓰실 거면 지금이 마지막 기회입니다. 해외 서비스는 결제 후 환불이 어렵습니다.`,
        buttons: ["해지하러 가기", "계속 씁니다"],
        actions: ["cancel-go", "keep"]
      };
    }
    if (kind === "pre") {
      return {
        title: `${w.name} · 결제하실 때가 됐어요`,
        message: amt ? `지난번 이맘때 ${amt}을 결제하셨습니다. 이번에도 필요하신가요?`
                     : `지난번 이맘때 결제하셨습니다. 이번에도 필요하신가요?`,
        buttons: ["이번엔 안 할래요", "결제할게요"],
        actions: ["canceled", "keep"]
      };
    }
    if (kind === "ask-pending") {
      return {
        title: `${w.name}, 해지 완료됐나요?`,
        message: `해지하러 가신 뒤 예정일이 지났습니다. 알려 주시면 더 이상 알리지 않겠습니다.`,
        buttons: ["해지했어요", "아직 쓰고 있어요"],
        actions: ["canceled", "paid"]
      };
    }
    return {
      title: `${w.name}, 결제됐나요?`,
      message: `예정일이 지났습니다. 알려 주시면 다음 알림을 정확하게 맞출 수 있습니다.`,
      buttons: ["결제됐어요", "해지했어요"],
      actions: ["paid", "canceled"]
    };
  }

  // ---------- 한 번의 점검 ----------
  /* 순수 함수다. 무엇을 알릴지와 무엇을 고칠지만 돌려주고, 저장은 부르는 쪽이 한다. */
  function planTick(watch, today, notified, lead) {
    const notifications = [];
    const updates = {};
    watch = watch || {}; notified = notified || {};

    for (const key of Object.keys(watch)) {
      const w = watch[key];
      if (!w || !w.due || !w.interval) continue;
      if (w.status !== STATUS.ACTIVE && w.status !== STATUS.PENDING) continue;

      const left = daysBetween(today, w.due);

      if (left >= 0) {
        // ── 결제 전
        if (w.status === STATUS.PENDING) continue;   // 해지하러 간 사람을 재촉하지 않는다
        if (w.ackedFor === w.due) continue;          // 이번 주기는 이미 "계속 쓴다"고 답했다
        for (const d of alertDaysBefore(w, lead)) {
          const nkey = `w-pre-${key}-${w.due}-${d}`;
          if (left <= d && !notified[nkey]) {
            notifications.push({ kind: "pre", nkey, key, w, left });
            break;
          }
        }
        continue;
      }

      // ── 예정일이 지났다
      if (w.ackedFor === w.due) {
        // "계속 씁니다"라고 답했으니 결제된 것으로 보고 조용히 넘긴다
        updates[key] = { due: addInterval(w.due, w.interval), ackedFor: null, misses: 0,
                         lastPaid: w.due };
        continue;
      }

      const askKey = `w-ask-${key}-${w.due}`;
      if (!notified[askKey]) {
        notifications.push({
          kind: w.status === STATUS.PENDING ? "ask-pending" : "ask",
          nkey: askKey, key, w, left
        });
        continue;
      }

      // 물어봤는데 답이 없다 — 기다릴 만큼 기다렸으면 조용해진다
      if (-left >= GRACE_DAYS) {
        const misses = (w.misses || 0) + 1;
        updates[key] = misses >= MAX_MISSES
          ? { status: STATUS.STALE, misses }
          : { due: addInterval(w.due, w.interval), misses };
      }
    }
    return { notifications, updates };
  }

  // ---------- 사용자가 버튼을 눌렀을 때 ----------
  function applyAction(w, action, today) {
    if (!w) return w;
    switch (action) {
      case "cancel-go":                       // 해지하러 갔다 — 결과는 아직 모른다
        return { ...w, status: STATUS.PENDING, pendingSince: today };
      case "keep":                            // 이번 주기는 계속 쓴다
        return { ...w, status: STATUS.ACTIVE, ackedFor: w.due, misses: 0 };
      case "paid":                            // 결제됐다 → 다음 주기로
        return { ...w, status: STATUS.ACTIVE, lastPaid: w.due,
                 due: addInterval(w.due, w.interval), ackedFor: null, misses: 0 };
      case "canceled":
        return { ...w, status: STATUS.CANCELED, canceledAt: today };
      case "resume":                          // 되살리기
        return { ...w, status: STATUS.ACTIVE, misses: 0, ackedFor: null,
                 due: dueFrom(w.due || w.lastPaid, w.interval, today) };
      case "pause":
        return { ...w, status: STATUS.PAUSED };
      default:
        return w;
    }
  }

  /* Stripe 구독관리 화면에서 '취소됨'이 보이면 묻지 않고 해지로 처리한다.
     이미 권한이 있는 페이지라 공짜로 얻는 정확도다. Stripe 구독에만 해당된다. */
  const RE_CANCELED = /(취소됨|해지됨|구독이\s*취소|Canceled|Cancelled|will not renew|갱신되지\s*않습니다|기간\s*종료\s*후\s*해지)/i;
  function looksCanceled(pageText) { return RE_CANCELED.test(String(pageText || "")); }

  // ---------- 페이지에서 읽어오기 ----------
  /* 사용자가 툴바 아이콘을 누른 그 페이지에서만 읽는다(activeTab).
     못 읽은 칸은 비워서 돌려준다 — 추측해서 채우지 않는다. */
  const RE_DATE = [
    /(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/,
    /(20\d{2})-(\d{2})-(\d{2})/
  ];
  const MONTHS = ["january","february","march","april","may","june",
                  "july","august","september","october","november","december"];

  function findDate(text) {
    for (const re of RE_DATE) {
      const m = text.match(re);
      if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    }
    const en = text.match(/([A-Z][a-z]+)\s+(\d{1,2}),?\s+(20\d{2})/);
    if (en) {
      const mi = MONTHS.indexOf(en[1].toLowerCase());
      if (mi >= 0) return `${en[3]}-${String(mi + 1).padStart(2, "0")}-${String(en[2]).padStart(2, "0")}`;
    }
    return null;
  }

  const RE_NEXT = /(다음\s*(결제|청구|갱신)|next\s*(billing|payment|charge|invoice|renewal)|갱신일|renews?\s+on)/i;

  function parsePage(pageText, title, url, R) {
    const text = String(pageText || "");
    const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
    const out = { name: null, amountOrig: null, currency: null,
                  interval: null, auto: null, nextDue: null, manageUrl: url || null };

    // 서비스명 — 도메인을 먼저 믿는다. 페이지 제목은 잡음이 많다.
    if (url) {
      try {
        const h = new URL(url).hostname.replace(/^www\./, "");
        const core = h.split(".")[0];
        if (core && core.length > 1) out.name = core.charAt(0).toUpperCase() + core.slice(1);
      } catch (e) { /* 주소가 이상하면 제목으로 간다 */ }
    }
    if (!out.name && title) out.name = String(title).split(/[·|\-–—]/)[0].trim().slice(0, 40) || null;

    // 금액 — '다음 결제' 같은 말 근처를 우선한다
    if (R && R.parseMoney) {
      let picked = null;
      for (let i = 0; i < lines.length; i++) {
        if (!RE_NEXT.test(lines[i])) continue;
        picked = R.parseMoney(lines[i]) || (lines[i + 1] ? R.parseMoney(lines[i + 1]) : null);
        if (picked) break;
      }
      if (!picked) {
        for (const ln of lines) { picked = R.parseMoney(ln); if (picked) break; }
      }
      if (picked) { out.currency = picked.cur; out.amountOrig = picked.val; }
    }

    // 주기 — rules.js의 판독기를 그대로 쓴다(연간 권유 줄에 안 걸리는 그것)
    if (R && R.detectInterval) out.interval = R.detectInterval(lines);

    // 다음 결제일 — '다음 결제' 근처의 날짜만 본다. 아무 날짜나 주우면 틀린다.
    for (let i = 0; i < lines.length; i++) {
      if (!RE_NEXT.test(lines[i])) continue;
      out.nextDue = findDate(lines[i]) || (lines[i + 1] ? findDate(lines[i + 1]) : null);
      if (out.nextDue) break;
    }

    if (/(취소할\s*때까지|until you cancel|자동\s*갱신|auto[- ]renew)/i.test(text)) out.auto = true;
    if (/(1회\s*결제|one[- ]?time|자동\s*갱신\s*(없음|안\s*함))/i.test(text)) out.auto = false;
    return out;
  }

  // ============================================================
  root.SVSTWatch = {
    STATUS, GRACE_DAYS, MAX_MISSES,
    addInterval, daysBetween, dueFrom, alertDaysBefore, LEAD_DEFAULT,
    makeWatch, messageFor, amountText,
    planTick, applyAction, looksCanceled, parsePage
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SVSTWatch;
})(typeof self !== "undefined" ? self : globalThis);
