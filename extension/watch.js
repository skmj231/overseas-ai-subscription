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
    PAUSED: "paused",     // 사용자가 이 구독 알림만 껐다
    NEEDS_INFO: "needs-info" // 서비스는 기억하지만 주기·날짜를 아직 모른다
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
  /* 연 구독은 금액이 크고 "잊고 있다가 1년치가 나갔다"가 가장 아픈 사고라 30·7·1일 세 번.
     무료 체험은 종료일이 곧 첫 결제일이라 2일 전과 당일에 묻는다. */
  const LEAD_DEFAULT = { year: [30, 7, 1], month: [5, 1], trial: [2, 0] };

  function alertDaysBefore(w, lead) {
    if (!w || !w.interval) return [];
    if (w.kind === "trial") {
      const t = lead && Array.isArray(lead.trial) && lead.trial.length ? lead.trial : LEAD_DEFAULT.trial;
      return t.slice().sort((a, b) => b - a);
    }
    if (w.auto === false) return [0];
    const key = w.interval === "year" ? "year" : "month";
    const picked = lead && Array.isArray(lead[key]) && lead[key].length ? lead[key] : LEAD_DEFAULT[key];
    return picked.slice().sort((a, b) => b - a);
  }

  // ---------- 원화로 얼마 나가나 ----------
  /* 카드 문자에 찍히는 금액은 화면의 달러와 다르다. 환율에 해외 이용 수수료가 붙고,
     사업자번호를 넣지 않은 개인에게는 부가세 10%가 더 붙는다. 이 셋을 다 곱해야
     "이번 달 실제로 빠져나갈 돈"이 된다. 환율을 모르면 모른다고 돌려준다. */
  const CARD_FEE = 0.013;
  const VAT = 0.10;

  function estimateKrw(amountOrig, currency, rates, opts) {
    if (amountOrig == null || isNaN(amountOrig)) return null;
    const o = opts || {};
    const cur = currency || "KRW";
    if (cur === "KRW") return Math.round(Number(amountOrig));
    if (!rates || !rates.KRW || (cur !== "USD" && !rates[cur])) return null;
    const per = cur === "USD" ? 1 : rates[cur];
    let krw = Number(amountOrig) * (rates.KRW / per) * (1 + (o.fee != null ? o.fee : CARD_FEE));
    if (o.vat) krw *= 1 + VAT;
    return Math.round(krw);
  }

  /* 살아 있는 구독의 월 환산 합계. 연 구독은 12로 나눈다.
     금액을 모르는 건은 더하지 않고 몇 건인지만 센다 — 모르는 것을 0으로 더하면 합계가 거짓말이 된다. */
  const isLive = (w) => !!w && (w.status === STATUS.ACTIVE || w.status === STATUS.PENDING);

  function monthlyTotal(watch) {
    let monthly = 0, count = 0, unknown = 0;
    for (const k of Object.keys(watch || {})) {
      const w = watch[k];
      if (!isLive(w)) continue;
      count++;
      if (w.amountKrw == null) { unknown++; continue; }
      monthly += w.interval === "year" ? w.amountKrw / 12 : w.amountKrw;
    }
    return { monthly: Math.round(monthly), count, unknown };
  }

  /* 앞으로 n일 안에 빠져나갈 것들. 화면 맨 위 "이번 달 나갈 돈"이 이걸 쓴다. */
  function upcoming(watch, today, days) {
    const out = [];
    for (const k of Object.keys(watch || {})) {
      const w = watch[k];
      if (!isLive(w) || !w.due) continue;
      const left = daysBetween(today, w.due);
      if (left < 0 || left > (days == null ? 30 : days)) continue;
      out.push({ key: k, w, left });
    }
    out.sort((a, b) => a.left - b.left);
    return out;
  }

  /* 해지하러 갈 곳. 앱스토어·플레이로 결제한 구독은 사이트에서 해지해도 결제가 계속된다.
     그래서 채널이 그쪽이면 사이트 주소가 있어도 스토어 구독 화면을 먼저 연다. */
  const CHANNEL_URL = {
    appstore: "https://apps.apple.com/account/subscriptions",
    play: "https://play.google.com/store/account/subscriptions"
  };
  function cancelUrl(w) {
    if (!w) return null;
    if (w.channel && CHANNEL_URL[w.channel]) return CHANNEL_URL[w.channel];
    return w.manageUrl || null;
  }

  // ---------- 금액의 신선도 ----------
  /* 자동 결제는 브라우저에 화면을 남기지 않는다. 저쪽 서버에서 카드로 빠져나갈 뿐이다.
     그래서 우리가 아는 금액은 늘 "마지막으로 눈으로 본 금액"이고, 가입할 때 본 값이
     1년째 그대로 남아 있는 경우가 대부분이다.
     날짜를 세는 대신 그 사이에 결제가 몇 번 지나갔는지를 세고, 아는 만큼만 말한다. */
  const CYCLE_DAYS = { month: 30, year: 365 };
  const FRESH = { SEEN: "seen", LIKELY: "likely", STALE: "stale" };

  function cyclesSince(w, today) {
    const from = w && (w.seenAt || w.createdAt);
    if (!from || !w || !w.interval) return null;
    const days = daysBetween(from, today);
    if (days < 0) return 0;
    return Math.floor(days / (CYCLE_DAYS[w.interval] || 30));
  }

  function freshness(w, today) {
    const c = cyclesSince(w, today);
    if (c == null) return FRESH.STALE;      // 언제 본 값인지 모르면 모른다고 한다
    return c <= 0 ? FRESH.SEEN : c === 1 ? FRESH.LIKELY : FRESH.STALE;
  }

  /* "7개월 전"처럼 사람이 읽는 시점. 정확한 날짜는 팝업에서 본다. */
  function seenAgo(w, today) {
    const from = w && w.seenAt;
    if (!from) return "";
    const months = Math.floor(daysBetween(from, today) / 30);
    if (months < 1) return "이번 달";
    if (months < 12) return months + "개월 전";
    return Math.floor(months / 12) + "년 전";
  }

  /* 화면에서 실제로 숫자를 읽었을 때만 부른다. 사용자가 버튼을 눌러 답한 것은 여기 오지 않는다.
     "계속 씁니다"는 결제 여부에 대한 답이지 금액을 본 게 아니기 때문이다. */
  function recordPrice(w, obs, today) {
    if (!w || !obs || obs.amountOrig == null) return { w, changed: false, before: null };
    const cur = obs.currency || w.currency;
    const same = w.amountOrig != null && w.currency === cur
      && Math.abs(Number(w.amountOrig) - Number(obs.amountOrig)) < 0.01;
    const log = (w.priceLog || []).slice();
    if (!same) {
      log.push({ d: today, amountOrig: Number(obs.amountOrig), currency: cur });
      while (log.length > 6) log.shift();
    }
    return {
      w: { ...w,
        amountOrig: Number(obs.amountOrig),
        currency: cur,
        amountKrw: obs.amountKrw != null ? Number(obs.amountKrw) : w.amountKrw,
        interval: obs.interval || w.interval,
        seenAt: today,
        seenBy: obs.by || "portal",
        priceLog: log },
      changed: !same,
      before: same ? null : { amountOrig: w.amountOrig, currency: w.currency, amountKrw: w.amountKrw }
    };
  }

  /* 부가세가 안 붙게 된 서비스들. 여기서 조심할 게 두 가지다.
     하나, 서비스마다 결제 주기가 다르다. 월 구독의 부가세와 연 구독의 부가세를 한 숫자에
     그냥 더하면 그 합계가 무엇을 뜻하는지 말할 수 없다. 전부 1년 기준으로 맞춰 더한다.
     둘, 이건 "이미 아낀 돈"이 아니라 "앞으로 안 붙는 돈"이다. 등록을 마친 시점의 사실이고,
     그 결제를 지금 끝냈는지와는 별개다. 그래서 과거형으로 부르지 않는다. */
  function vatFreeYear(stats) {
    const m = (stats && stats.vatFree) || {};
    let sum = 0;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (!v || !(Number(v.vat) > 0)) continue;
      sum += v.interval === "year" ? Number(v.vat) : Number(v.vat) * 12;
    }
    return Math.round(sum);
  }

  function vatFreeCount(stats) {
    const m = (stats && stats.vatFree) || {};
    return Object.keys(m).filter(k => m[k] && Number(m[k].vat) > 0).length;
  }

  /* 해지로 1년에 안 나가게 된 돈. 부가세로 아낀 실제 금액과는 단위가 달라서 따로 센다.
     둘을 한 숫자에 섞으면 "아낀 돈"이 무엇을 뜻하는지 아무도 모르게 된다. */
  function savedByCancel(w) {
    const krw = w && w.amountKrw;
    if (krw == null || !(krw > 0)) return 0;
    return Math.round(w.interval === "year" ? krw : krw * 12);
  }

  /* 자동 갱신은 화면을 안 남기므로 기록함이 빈다. 주기가 지나간 것이 확실할 때
     마지막으로 본 금액으로 한 줄을 남긴다. 관측이 아니므로 '추정'으로 표시하고,
     부가세는 비운다. 모르는 것을 지어내지 않는다. */
  function estimatedRow(w, key, date) {
    if (!w || w.amountOrig == null) return null;
    return {
      id: "e-" + String(key || "sub") + "-" + date,   // 같은 날 같은 구독은 한 줄뿐
      date,
      merchant: w.name || "해외 서비스",
      mkey: String(key || ""),
      desc: "",
      currency: w.currency || "KRW",
      amountOrig: Number(w.amountOrig),
      amountKrw: w.amountKrw != null ? Number(w.amountKrw) : null,
      krwBasis: "estimate",
      fxRate: null,
      fxNote: "",
      vatKrw: null,
      supplier: "unknown",
      supplierWhy: "자동 갱신이라 화면을 보지 못했음",
      charge: "renewal",
      vatCsv: "",
      vatReview: false,
      interval: w.interval,
      auto: w.auto !== false,
      billingSource: "assumed",
      status: "estimated",
      source: "watch"
    };
  }

  // ---------- 새 구독 ----------
  function makeWatch(input, today) {
    const interval = input.interval === "year" ? "year"
      : input.interval === "month" ? "month" : null;
    const kind = input.kind === "trial" ? "trial" : "sub";
    /* 무료 체험은 '다음 결제일'이 곧 체험 종료일이다. 종료일이 지나면 유료 구독으로 바뀌므로
       그 뒤로는 보통 구독과 같은 주기로 돈다. 그래서 due에 종료일을 그대로 넣는다. */
    const anchor = input.nextDue || input.trialEnd
      || (input.lastPaid ? addInterval(input.lastPaid, interval) : null);
    const due = kind === "trial" && anchor && anchor >= today ? anchor : dueFrom(anchor, interval, today);
    return {
      name: (input.name || "").trim() || "이름 없는 구독",
      amountOrig: input.amountOrig != null ? Number(input.amountOrig) : null,
      currency: input.currency || "KRW",
      amountKrw: input.amountKrw != null ? Number(input.amountKrw) : null,
      interval,
      kind,                                  // 'sub' | 'trial'
      channel: input.channel || "web",       // 'web' | 'appstore' | 'play' — 해지 경로가 다르다
      presetId: input.presetId || null,
      refundUrl: input.refundUrl || null,
      refundNote: input.refundNote || null,
      auto: input.auto !== false,
      lastPaid: input.lastPaid || null,
      due,
      manageUrl: input.manageUrl || null,
      sourceUrl: input.sourceUrl || null,   // 등록할 때 보고 있던 화면
      source: input.source || "manual",
      status: interval && due ? STATUS.ACTIVE : STATUS.NEEDS_INFO,
      misses: 0,
      ackedFor: null,
      createdAt: today,
      /* 결제창·영수증·빌링 화면에서 실제로 숫자를 읽고 온 경우에만 관측으로 인정한다.
         손으로 입력한 것은 관측이 아니다. */
      seenAt: input.amountOrig != null && input.source && input.source !== "manual" ? today : null,
      seenBy: input.source && input.source !== "manual" ? (input.seenBy || "checkout") : null,
      priceLog: []
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

  function messageFor(kind, w, left, meta) {
    /* 금액을 못 읽은 채로 등록된 구독이 있다. 처음 보는 결제창에서 알림만 건 경우다.
       그때 금액 자리를 비워 두면 "이 자동으로 빠져나갑니다" 같은 문장이 된다.
       빈칸을 남기지 말고 문장 자체를 바꾼다. */
    const amt = amountText(w);
    /* 무료 체험: 종료일이 곧 첫 결제일이다. "체험이 끝난다"가 아니라 "돈이 나가기 시작한다"로 말한다.
       한 번 유료로 넘어가면 대부분 환불이 안 되니, 끊을 곳을 바로 열어 준다. */
    if (kind === "pre" && w.kind === "trial") {
      const cyc = w.interval === "year" ? "매년" : "매달";
      return {
        title: left === 0 ? `${w.name} · 오늘 무료 체험이 끝나요` : `${w.name} · ${left}일 뒤 무료 체험이 끝나요`,
        message: (amt ? `그 뒤로 ${cyc} ${amt}이 자동으로 빠져나갑니다.` : `그 뒤로 ${cyc} 자동으로 결제됩니다.`)
          + " 계속 쓰지 않을 거면 지금 끊는 게 안전합니다.",
        buttons: ["해지하러 가기", "계속 쓸래요"],
        actions: ["cancel-go", "keep"]
      };
    }
    if (kind === "pre" && w.auto !== false) {
      /* 제목은 날짜를 말하고 본문은 금액을 말한다. 날짜는 확실하지만 금액은 아닐 수 있다.
         그 차이를 금액 표현 자체에 담는다. meta가 없으면 예전처럼 확실하게 말한다. */
      const fresh = (meta && meta.fresh) || FRESH.SEEN;
      const ago = (meta && meta.ago) || "";
      /* 확인할 주소가 없으면 확인 버튼을 띄우지 않는다. 눌렀는데 아무 일도 없는 게 제일 나쁘다. */
      const verifiable = fresh === FRESH.STALE && !!amt && !!w.manageUrl;

      let line;
      if (!amt) line = "자동으로 결제됩니다.";
      else if (fresh === FRESH.LIKELY) line = `지난번과 같다면 ${amt}이 빠져나갑니다.`;
      else if (fresh === FRESH.STALE)
        line = `마지막으로 본 금액은 ${amt}${ago ? ", " + ago + " 기준" : ""}입니다. 그 사이 올랐을 수 있습니다.`;
      else line = `${amt}이 자동으로 빠져나갑니다.`;

      return {
        title: left === 0 ? `${w.name} · 오늘 자동 결제` : `${w.name} · ${left}일 뒤 자동 결제`,
        message: line + " 해외 서비스는 결제되고 나면 환불이 어렵습니다.",
        buttons: verifiable ? ["금액 확인하기", "계속 쓸래요"] : ["해지하러 가기", "계속 쓸래요"],
        actions: verifiable ? ["verify", "keep"] : ["cancel-go", "keep"]
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
    const records = [];      // 자동 갱신이라 화면을 못 본 결제를 '추정'으로 남긴다
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
        /* 30·7·1일처럼 단계가 여럿이면 '남은 날이 속한 가장 가까운 단계' 하나만 쏜다.
           'left <= d'인 첫 단계를 잡으면 30일 단계를 보낸 뒤 같은 날 7일 단계가 또 나간다.
           단계를 놓친 사람(그날 브라우저를 안 켠 사람)에게는 다음 단계에서 늦게라도 한 번 간다. */
        const days = alertDaysBefore(w, lead);
        const slot = days.filter(d => left <= d).sort((a, b) => a - b)[0];
        if (slot != null) {
          const nkey = `w-pre-${key}-${w.due}-${slot}`;
          if (!notified[nkey]) {
            notifications.push({ kind: "pre", nkey, key, w, left,
                                 fresh: freshness(w, today), ago: seenAgo(w, today) });
          }
        }
        continue;
      }

      // ── 예정일이 지났다
      if (w.ackedFor === w.due) {
        /* "계속 씁니다"라고 답했으니 결제된 것으로 보고 넘긴다.
           그 결제는 브라우저에 화면을 남기지 않았으므로 기록함에도 안 들어간다.
           분기 자료가 비는 걸 막기 위해 마지막으로 본 금액으로 한 줄 남긴다. 추정이다. */
        updates[key] = { due: addInterval(w.due, w.interval), ackedFor: null, misses: 0,
                         lastPaid: w.due, kind: "sub" };   // 체험이었다면 이제 유료 구독이다
        const row = estimatedRow(w, key, w.due);
        if (row) records.push(row);
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
        /* 답이 없다. 결제가 됐는지 안 됐는지 모르므로 기록을 남기지 않는다.
           모르는 것을 추정으로라도 적어 두면 세무 자료가 조용히 오염된다. */
        const misses = (w.misses || 0) + 1;
        updates[key] = misses >= MAX_MISSES
          ? { status: STATUS.STALE, misses }
          : { due: addInterval(w.due, w.interval), misses };
      }
    }
    return { notifications, updates, records };
  }

  // ---------- 사용자가 버튼을 눌렀을 때 ----------
  function applyAction(w, action, today) {
    if (!w) return w;
    switch (action) {
      case "cancel-go":                       // 해지하러 갔다 — 결과는 아직 모른다
        return { ...w, status: STATUS.PENDING, pendingSince: today };
      case "keep":                            // 이번 주기는 계속 쓴다
        return { ...w, status: STATUS.ACTIVE, ackedFor: w.due, misses: 0 };
      case "paid":                            // 결제됐다 → 다음 주기로 (체험이었다면 이제 유료 구독)
        return { ...w, status: STATUS.ACTIVE, lastPaid: w.due, kind: "sub",
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
    CARD_FEE, VAT, estimateKrw, monthlyTotal, upcoming, isLive, cancelUrl, CHANNEL_URL,
    makeWatch, messageFor, amountText,
    FRESH, CYCLE_DAYS, cyclesSince, freshness, seenAgo,
    recordPrice, savedByCancel, estimatedRow, vatFreeYear, vatFreeCount,
    planTick, applyAction, looksCanceled, parsePage
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SVSTWatch;
})(typeof self !== "undefined" ? self : globalThis);
