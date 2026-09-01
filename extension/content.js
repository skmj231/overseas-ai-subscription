/* 해외AI구독관리 v1.0 — content script
 *
 * v0.8까지는 시나리오마다 if를 늘렸다. v0.9는 그걸 버렸다.
 * 관측(scan) → 판정(rules.js) → 화면 선택(render) 세 단계로만 움직인다.
 * 새 시나리오가 생기면 화면을 늘리는 게 아니라 판정 규칙 한 줄을 늘린다.
 *
 * 판정 규칙: rules.js · 여정 스펙: JOURNEY-SOLO.md · 내보내기: EXPORT-SPEC.md
 */
(() => {
  if (window.__SVST_LOADED__) return;
  window.__SVST_LOADED__ = true;

  /* all_frames로 들어가기 때문에 카드번호 칸이나 3DS 인증창처럼 손톱만 한 iframe에도
     이 스크립트가 실린다. 거기에 패널을 그리면 상자 안에 갇혀 아무도 못 읽는다.
     사람이 읽을 수 있는 크기의 화면에서만 그린다. */
  if (window.top !== window.self &&
      (window.innerWidth < 360 || window.innerHeight < 420)) return;

  const R = self.SVST;
  const { TAX_TYPE: T, SUPPLIER: SUP, CHARGE: CH, ACTION: ACT } = R;

  // ---------- 상태 ----------
  const S = {
    profile: null,   // {type:'solo'|'corp'|'personal', taxType, brn, taxHandling}
    stats: { saved: 0 },
    pending: {},     // 다음 결제부터 면제 예약: { mkey: {merchant, vat, ts} }
    suppliers: {},   // 사용자가 한 번 답한 공급자 소재: { mkey: 'overseas'|'domestic' }
    ledger: [],
    subs: {},
    rates: null,
    scan: null,
    dec: null,
    cardOpen: false,
    lastSig: "",
    filledOnce: false,
    captured: false,
    consent: null,   // {v, ts} — 동의 전에는 아무것도 저장하지 않는다
    shown: {},       // 화면 종류별 1회 자동 열기
    flow: null,      // {asked: {mkey: 'on'|'off'}} — 서비스별로 알림을 물었는지. 한 번 물으면 다시 안 묻는다
    view: null,      // null | 'settings' | 'tax' — 사용자가 직접 들어간 화면
    ready: false     // 읽을 값이 확정됐는가. 이게 참이 되기 전에는 카드가 스스로 열리지 않는다
  };

  const CONSENT_VERSION = 1;

  /* 결제 시스템 판별.
     화면을 읽는 방식(글자 스캔)은 어느 결제창에서나 같다 — Stripe가 클래스명을 숨기는 바람에
     처음부터 구조에 기대지 않았기 때문이다. 그래서 Paddle·LemonSqueezy에서도 그대로 동작한다.
     사업자번호 자동 입력은 화면에 칸이 실제로 보일 때만 한다 — 그건 눈으로 확인되는 사실이다.
     '다음 결제부터 빠진다'는 갱신 때 동작을 확인한 Stripe에서만 말한다.
     세무 자료(기록함·분기 CSV)도 Stripe 결제창에서 관측한 것만 담는다. */
  const PROCESSOR = R.processorOf([location.host]) || "other";

  const IS_STRIPE = PROCESSOR === "stripe";

  /* 도메인만 보고 "여기는 결제창"이라고 단정해도 되는 곳은, 결제 말고는 아무것도 안 하는 곳뿐이다.
     paypal.com이나 squareup.com은 로그인·설정·고객센터가 다 같은 도메인에 있다.
     그런 곳에서는 도메인을 근거로 쓰지 않고 화면을 보고 판단한다(카드칸 + 금액). */
  const HOSTED_ONLY =
    /^(checkout|buy|invoice|billing|pay)\.stripe\.com$/i.test(location.host) ||
    /(^|\.)(paddle\.com|lemonsqueezy\.com|onfastspring\.com)$/i.test(location.host);

  /* Envato·Movavi·Artlist처럼 결제 화면을 직접 만들어 쓰는 곳이 많다.
     이런 데는 도메인만 봐서는 알 수 없으므로, 여기까지 스크립트가 실행됐다는 것 자체를
     신호로 삼는다 — 목록에 있는 도메인이거나, 사용자가 직접 켠 페이지거나 둘 중 하나다. */
  const PAGE =
    /checkout\.stripe\.com|buy\.stripe\.com/.test(location.host) ? "checkout" :
    /invoice\.stripe\.com/.test(location.host) ? "invoice" :
    /billing\.stripe\.com/.test(location.host) ? "portal" :
    /pay\.stripe\.com/.test(location.host) ? "receipt" : "checkout";

  // ---------- 유틸 ----------
  const won = (n) => n == null ? "-" : "₩" + Math.round(n).toLocaleString("ko-KR");
  const money = (t) => !t ? "-" : (t.cur === "KRW" ? won(t.val)
    : (R.ZERO_DECIMAL.has(t.cur) ? "" : "") + t.cur + " " + t.val.toLocaleString("en-US"));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const mkeyOf = (name) => (name || "unknown").toLowerCase().replace(/[^a-z0-9가-힣]/g, "").slice(0, 40);

  function copyText(t) {
    try { navigator.clipboard.writeText(t); } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove();
    }
  }

  // ---------- 관측 ----------
  /* Stripe는 클래스명을 난독화한다. 그래서 DOM 구조가 아니라 화면에 보이는 글자를 읽는다.
     이 함수는 판단하지 않는다. 보이는 것만 담는다. */
  const RATE_RE = /1\s*USD\s*=\s*([\d,]+(?:\.\d+)?)\s*KRW/i;

  /* 이 페이지가 어느 결제사를 쓰는지는 iframe·script 출처가 말해 준다.
     판매자가 자기 사이트에서 결제를 받아도 카드칸만은 결제사가 내려주기 때문이다.
     처음 보는 사이트에서도 "여기는 결제창이다"를 알아보는 근거가 된다. */
  function embeddedHosts() {
    const out = [location.host];
    try {
      document.querySelectorAll("iframe[src], script[src], form[action]").forEach(el => {
        const v = el.getAttribute("src") || el.getAttribute("action");
        if (!v) return;
        try { out.push(new URL(v, location.href).host); } catch (e) { /* 상대 경로 */ }
      });
    } catch (e) { /* 아직 DOM이 없다 */ }
    return out;
  }

  /* ─────────────────────────────────────────────────────────────────
     여기서 하는 일은 "카드 입력칸이 화면에 있는가" 예/아니오 한 글자를 얻는 것뿐이다.
     그 칸에 무엇이 적혀 있는지는 보지 않는다.

     규칙(어기면 안 된다): 이 아래 어떤 코드도 input의 .value 를 읽지 않는다.
     읽는 것은 이름표뿐이다 — name, id, placeholder, autocomplete, aria-label,
     data-testid, 그리고 바깥 <label>의 글자. 전부 페이지가 공개해 둔 표시이고,
     사람이 무엇을 치기 전에 이미 화면에 있는 것들이다.

     이 예/아니오는 오직 한 곳에만 쓰인다: "이 화면이 결제창인가"를 판단할 때
     세 신호 중 하나로. 저장되지도, 전송되지도, 기록에 남지도 않는다.
     tests/privacy.js 가 매번 이걸 실측으로 확인한다.
     ───────────────────────────────────────────────────────────────── */
  const CARDFIELD_RE = /(cc-?num|card-?num|cardnumber|creditcard|카드\s*(번호|정보)|card\s*(number|details|information))/i;

  /* 결제창 절반은 입력칸 자체에 아무 표시가 없고, 이름이 바깥 <label>에만 적혀 있다.
     속성만 읽으면 거기서 '카드칸이 없다'고 잘못 결론 낸다. 라벨과 칸의 생김새까지 본다. */
  const CARDMASK_RE = /^[\s\d•*·xX·\u2022-]{12,}$/;   // 1234 1234 1234 1234 / •••• •••• •••• ••••

  function labelTextOf(el) {
    const out = [];
    try {
      if (el.id && window.CSS && CSS.escape) {
        const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) out.push(l.textContent);
      }
      const wrap = el.closest("label");
      if (wrap) out.push(wrap.textContent);
      const prev = el.previousElementSibling;
      if (prev && /^(LABEL|SPAN|DIV|P)$/.test(prev.tagName)) out.push(prev.textContent);
      const up = el.parentElement && el.parentElement.previousElementSibling;
      if (up && /^(LABEL|SPAN|DIV|P)$/.test(up.tagName)) out.push(up.textContent);
    } catch (e) { /* 선택자로 못 쓰는 id */ }
    return out.join(" ").slice(0, 200);
  }

  function hasCardField(root) {
    return Array.from(root.querySelectorAll("input")).some(el => {
      if (el.type === "hidden" || el.disabled) return false;
      const a = [el.name, el.id, el.placeholder, el.autocomplete, el.getAttribute("aria-label"),
                 el.getAttribute("data-testid"), labelTextOf(el)].filter(Boolean).join(" ");
      if (CARDFIELD_RE.test(a)) return true;
      /* 표시가 하나도 없어도 '1234 1234 1234 1234' 같은 자리표시자는 카드칸 말고 없다.
         전화번호(11자리)나 날짜에 걸리지 않도록 12자리 이상만 인정한다. */
      const ph = (el.placeholder || "").trim();
      if (ph.length < 12 || !CARDMASK_RE.test(ph)) return false;
      return ph.replace(/\D/g, "").length >= 12 || /[•*·\u2022]{4}/.test(ph);
    });
  }
  const SUCCESS_RE = /(결제가 완료|결제 완료|Payment successful|Thanks for (your|subscribing)|paid successfully|영수증 보내기)/i;

  /* 나중에 "지금 얼마인지" 다시 볼 주소다. 결제창에 이 링크가 있는 곳이 꽤 있는데,
     그때 안 주워 두면 나중에 열 곳이 없어서 확인 자체를 못 한다. */
  const MANAGE_RE = /(구독\s*관리|결제\s*관리|청구\s*정보|Manage\s+(subscription|billing|plan)|Billing\s*(portal|settings)?|Manage\s*your\s*subscription)/i;
  function findManageLink(root) {
    try {
      const el = Array.from(root.querySelectorAll("a[href]"))
        .find(a => MANAGE_RE.test((a.textContent || "").trim().slice(0, 60)));
      if (!el) return null;
      const u = new URL(el.getAttribute("href"), location.href);
      return u.protocol === "https:" ? u.href : null;
    } catch (e) { return null; }   // 상대 경로가 깨져 있어도 조용히 넘어간다
  }

  function scanPage() {
    const text = document.body ? document.body.innerText : "";
    const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
    const r = {
      pageText: text, pageKind: PAGE,
      vat: null, total: null, stripeRate: null,
      amountSure: false, amountVerified: false,
      processor: null, checkoutLike: false, hasCard: false,
      merchant: null, desc: "", interval: null, paidDate: null,
      success: SUCCESS_RE.test(text),
      hasTaxField: false, hasBizToggle: false,
      taxField: null, bizToggle: null
    };

    const m = text.match(RATE_RE);
    if (m) r.stripeRate = parseFloat(m[1].replace(/,/g, ""));

    /* 단어가 후보를 찾고 산수가 검증한다. 규칙은 rules.js에 있다 —
       여기서는 읽은 결과를 담기만 한다. */
    const amt = R.readAmounts(lines);
    r.total = amt.total;
    r.amountSure = amt.sure;
    r.amountVerified = amt.verified;
    if (amt.vat) {
      r.vat = amt.vat.cur === "KRW" ? amt.vat.val
        : (r.stripeRate ? amt.vat.val * r.stripeRate : amt.vat.val);
    }

    const t = (document.title || "").replace(/\s*[-|·]\s*Stripe.*/i, "").trim();
    if (t) r.merchant = t;
    const sub = lines.find(l => /구독하기|Subscribe to/i.test(l));
    if (sub) {
      r.desc = sub.replace(/구독하기|Subscribe to/gi, "").trim();
      const name = (r.desc || "").replace(/-?\s*(annual|monthly|plus|pro|yearly|premium)/gi, "").trim();
      if (name) r.merchant = name;
    }

    // 판정은 rules.js가 한다. 여기서는 보이는 줄만 넘긴다.
    r.interval = R.detectInterval(lines);

    const dm = text.match(/(\d{4})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/);
    if (dm) r.paidDate = `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}`;

    /* 우리 패널은 documentElement에 붙어 있다(body 밖). 그래서 body로 좁혀 찾는다.
       이걸 안 하면 온보딩의 #svst-brn 입력칸을 '결제창의 사업자번호칸'으로 착각한다. */
    const root = document.body || document;
    const inputs = Array.from(root.querySelectorAll("input, select"));

    /* 칸 이름은 속성에만 있는 게 아니다. Envato는 바깥에 <label>VAT Number</label>를 두고
       input에는 아무 표시도 남기지 않는다. 속성만 보면 '칸이 없다'고 결론 내리고,
       사용자는 바로 옆에 있는 칸을 못 본 채 부가세를 그냥 낸다. 그래서 라벨도 같이 읽는다. */
    const labelOf = (el) => {
      let byFor = "";
      try { if (el.id) { const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); byFor = l ? l.innerText : ""; } }
      catch (e) { /* id에 이상한 문자가 있으면 그냥 넘어간다 */ }
      const wrap = el.closest("label");
      const prev = el.previousElementSibling;
      const par = el.parentElement;
      return [byFor, wrap && wrap.innerText, prev && prev.innerText,
              par && par.firstElementChild !== el && par.firstElementChild && par.firstElementChild.innerText]
        .filter(Boolean).join(" ").slice(0, 120);
    };
    const TAXFIELD_RE = /(tax\s*(id|number)?|사업자|brn|vat|business\s*(number|registration))/i;

    r.taxField = inputs.find(el => {
      if (el.type === "checkbox" || el.type === "radio" || el.type === "hidden") return false;
      const attrs = [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete]
        .filter(Boolean).join(" ");
      return TAXFIELD_RE.test(attrs) || TAXFIELD_RE.test(labelOf(el));
    }) || null;
    r.bizToggle = Array.from(root.querySelectorAll("input[type='checkbox']")).find(cb => {
      const label = cb.closest("label") || (cb.id && root.querySelector(`label[for="${cb.id}"]`));
      const s = ((label && label.innerText) || (cb.parentElement && cb.parentElement.innerText) || "").toLowerCase();
      return /(기업|사업체|사업자|business)/.test(s);
    }) || null;

    /* Stripe는 선택 입력칸을 접어 둔다. 이 화면의 '프로모션 코드 추가'가 바로 그 형태다.
       사업자번호칸도 같은 방식으로 접혀 있을 수 있다. input만 찾으면 '칸이 없다'고
       잘못 결론 내고, 사용자는 지금 뺄 수 있었던 부가세를 그냥 낸다.
       그래서 '펼치는 버튼'도 칸이 있는 것으로 센다. */
    r.taxTrigger = Array.from(root.querySelectorAll("button, a, summary, [role='button']")).find(el => {
      const s = (el.innerText || el.textContent || "").trim();
      if (!s || s.length > 40) return false;
      return /(세금\s*ID|사업자\s*(등록)?\s*번호|tax\s*id|vat\s*(번호|number|id)|business\s*(number|id))/i.test(s);
    }) || null;

    /* 결제사 지문 · 카드칸 · 총액 단어. 둘 이상 맞으면 결제창으로 본다.
       도메인 목록에 있는 곳은 이미 결제창이므로 그대로 인정한다. */
    r.processor = R.processorOf(embeddedHosts());
    r.hasCard = hasCardField(root);
    r.manageLink = PAGE === "portal" ? location.href : findManageLink(root);
    r.checkoutLike = HOSTED_ONLY || R.looksLikeCheckout({
      processor: r.processor, hasCardField: r.hasCard, hasTotalWord: r.amountSure
    });

    r.hasTaxField = !!r.taxField;
    r.hasBizToggle = !!r.bizToggle;
    r.hasTaxTrigger = !!r.taxTrigger;

    return r;
  }

  /* 서비스 이름은 페이지 글자에서 읽는다. 그래서 페이지가 그려지는 동안 흔들린다 —
     처음엔 문서 제목("Stripe"), 잠시 뒤 "Suno Pro 구독하기", 요금제를 바꾸면 또 달라진다.
     우리는 이 이름으로 "이 구독은 이미 물어봤다"를 기억하는데, 이름이 바뀌면 키가 바뀌어서
     방금 답한 질문이 다시 튀어나온다. 사용자 눈에는 두 화면이 무작위로 번갈아 뜨는 것처럼 보인다.
     그래서 한 페이지에서 처음 제대로 읽은 이름을 잠가 두고, 그 뒤로는 바꾸지 않는다. */
  function lockMerchant(scan) {
    const raw = (scan.merchant || "").trim();
    if (!S.merchantLock) {
      if (raw && raw.length > 1 && !/^stripe$/i.test(raw)) S.merchantLock = raw;
    }
    if (S.merchantLock) scan.merchant = S.merchantLock;
    /* 사용자가 고른 주기는 화면에서 읽은 값보다 앞선다.
       예전에는 못 읽었을 때만 이 값을 썼는데, 그러면 잘못 읽은 것을 사용자가 고쳐도
       다음 스캔에서 원래대로 돌아갔다. 화면 글자보다 사람이 아는 것이 정확하다.
       다른 결제창으로 옮겨 가면 그 답은 더 이상 근거가 아니므로 함께 버린다. */
    if (S.cycleLock && S.cycleLock.mkey && S.cycleLock.mkey !== mkeyOf(scan.merchant)) {
      S.cycleLock = null;
    }
    if (S.cycleLock) scan.interval = S.cycleLock.interval || S.cycleLock;
    return scan;
  }

  /* 금액을 확신하는가. 단어로 찾은 총액이 있을 때만 참이다.
     확신 없이 숫자를 내보이면 그 순간부터 이 도구의 말은 믿을 수 없는 것이 된다. */
  const knowsAmount = (scan) => !!(scan.total && scan.total.val > 0 && scan.amountSure);

  // ---------- 판정 ----------
  function decide(scan) {
    const mk = mkeyOf(scan.merchant);
    return R.buildDecision(scan, S.profile || { taxType: T.NONE }, S.rates, {
      supplierAnswer: S.suppliers[mk],
      knownSub: !!S.subs[mk],
      alreadyPending: !!S.pending[mk],
      observed: PAGE === "receipt" || PAGE === "invoice" || scan.success
    });
  }

  // ---------- 자동 입력 ----------
  function setNativeValue(el, value) {
    const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  async function fillTaxId() {
    let scan = scanPage();
    if (!scan.taxField && scan.bizToggle && !scan.bizToggle.checked) {
      scan.bizToggle.click();
      await new Promise(res => setTimeout(res, 600));
      scan = scanPage();
    }
    // 접혀 있으면 먼저 펼친다
    if (!scan.taxField && scan.taxTrigger) {
      scan.taxTrigger.click();
      await new Promise(res => setTimeout(res, 600));
      scan = scanPage();
    }
    if (scan.taxField && S.profile && S.profile.brn) {
      scan.taxField.focus();
      setNativeValue(scan.taxField, S.profile.brn);
      S.filledOnce = true;
      return true;
    }
    return false;
  }

  // ---------- 기록 ----------
  async function addRecord(rec) {
    if (!S.consent) return false;   // 동의 전에는 한 바이트도 쓰지 않는다
    if (S.ledger.some(r => R.sameRecord(r, rec))) return false;
    S.ledger.push(rec);
    await chrome.storage.local.set({ ledger: S.ledger });
    return true;
  }

  async function upsertSub(mkey, data) {
    if (!S.consent) return;
    S.subs[mkey] = { ...(S.subs[mkey] || {}), ...data };
    await chrome.storage.local.set({ subs: S.subs });
  }

  /* 기록 한 건 = 판정 결과를 그대로 얼려 둔 것.
     나중에 규칙이 바뀌어도 그때 무엇을 근거로 그렇게 적었는지 남아야 한다. */
  function buildRecord(scan, dec, source, dateOverride) {
    const total = scan.total || { cur: "KRW", val: 0 };
    return {
      id: "r" + Date.now() + Math.floor(performance.now() % 1000),
      date: dateOverride || scan.paidDate || todayISO(),
      merchant: scan.merchant || "해외 서비스",
      mkey: mkeyOf(scan.merchant),
      desc: scan.desc || scan.merchant || "",
      currency: total.cur,
      amountOrig: total.val,          // 외화 원금 — 유일하게 확실한 값
      amountKrw: dec.fx.krw,          // null일 수 있다. 0으로 채우지 않는다.
      krwBasis: dec.fx.basis,
      fxRate: dec.fx.rate,
      fxNote: dec.fx.note,
      vatKrw: scan.vat == null ? null : Math.round(scan.vat),
      supplier: dec.supplier,
      supplierWhy: dec.supplierWhy,
      charge: dec.charge,
      vatCsv: dec.vat.csv,
      vatReview: dec.vat.review,
      interval: (dec.billing && dec.billing.interval) || scan.interval,
      auto: dec.billing ? dec.billing.auto : true,
      billingSource: dec.billing ? dec.billing.source : "none",
      status: "confirmed",
      source
    };
  }

  async function stashDraft(scan) {
    if (!S.consent || !scan.total) return;
    await chrome.storage.local.set({
      draftSub: {
        mkey: mkeyOf(scan.merchant), merchant: scan.merchant, desc: scan.desc || "",
        interval: scan.interval, total: scan.total, vat: scan.vat,
        stripeRate: scan.stripeRate, ts: Date.now()
      }
    });
  }

  async function commitPayment(scan, dec) {
    if (S.captured || !dec.recordable) return;
    S.captured = true;
    const { draftSub } = await chrome.storage.local.get("draftSub");
    const d = (draftSub && Date.now() - draftSub.ts < 3600e3) ? draftSub : null;
    const eff = d ? {
      ...scan, merchant: d.merchant || scan.merchant, desc: d.desc || scan.desc,
      total: d.total || scan.total, vat: d.vat ?? scan.vat,
      interval: d.interval || scan.interval, stripeRate: d.stripeRate || scan.stripeRate
    } : scan;
    const dec2 = decide(eff);
    const rec = buildRecord(eff, dec2, "checkout");
    if (rec.amountOrig > 0 || rec.charge === CH.REFUND) {
      await addRecord(rec);
      if (eff.interval) {
        await upsertSub(rec.mkey, {
          merchant: rec.merchant, desc: rec.desc,
          interval: rec.interval, auto: rec.auto, billingSource: rec.billingSource,
          currency: rec.currency, amountOrig: rec.amountOrig, amountKrw: rec.amountKrw,
          vatKrw: rec.vatKrw, supplier: rec.supplier, lastPaid: rec.date
        });
      }
      await chrome.storage.local.remove("draftSub");
    }
  }

  async function captureReceipt(scan, dec) {
    if (S.captured || !dec.recordable) return;
    S.captured = true;
    const rec = buildRecord(scan, dec, "receipt");
    const added = await addRecord(rec);
    const sub = S.subs[rec.mkey];
    if (sub && (!sub.lastPaid || rec.date > sub.lastPaid)) {
      await upsertSub(rec.mkey, {
        lastPaid: rec.date, amountKrw: rec.amountKrw, vatKrw: rec.vatKrw, supplier: rec.supplier
      });
    }
    // 영수증에서 공급자를 확정했으면 그 지식을 서비스 단위로 저장한다 — 다시 안 묻기 위해
    if (rec.supplier !== SUP.UNKNOWN && !S.suppliers[rec.mkey]) {
      S.suppliers[rec.mkey] = rec.supplier;
      await chrome.storage.local.set({ suppliers: S.suppliers });
    }
    S.receiptSaved = added;
  }

  // ---------- UI 뼈대 ----------
  function ensureUI() {
    if (document.getElementById("svst-badge")) return;
    const badge = document.createElement("div");
    badge.id = "svst-badge";
    const brandIcon = chrome.runtime.getURL("icon48.png");
    /* 배지는 두 장이 겹쳐 있다. 앞장은 "이번에 아낄 돈", 뒷장은 "부가세로 아낀 돈".
       한 번에 하나만 보이고 서서히 바뀐다 — 둘을 나란히 쓰면 어느 쪽이 이번 건인지 헷갈린다. */
    badge.innerHTML =
      `<span class="svst-face svst-on"><span class="svst-plate-label"><img class="svst-bell" src="${brandIcon}" alt="">돈나가요</span>` +
      `<span class="svst-plate-val"></span></span>` +
      `<span class="svst-face svst-alt"><span class="svst-plate-label"></span>` +
      `<span class="svst-plate-val"></span></span>`;
    badge.addEventListener("click", () => { stick(); toggleCard(); });
    const card = document.createElement("div");
    card.id = "svst-card";
    card.addEventListener("mouseenter", stick);
    card.addEventListener("click", stick);
    document.documentElement.appendChild(badge);
    document.documentElement.appendChild(card);
  }

  function toggleCard(force) {
    const card = document.getElementById("svst-card");
    if (!card) return;
    S.cardOpen = force !== undefined ? force : !S.cardOpen;
    card.classList.toggle("svst-open", S.cardOpen);
    if (S.cardOpen) { S.stale = false; render(); } else clearTimeout(S.autoHide);
  }

  /* 카드는 결제창을 가린다. 그래서 스스로 먼저 열되, 할 말을 하고는 물러난다.
     사용자가 카드에 손을 대는 순간 이 타이머는 죽고 다시 살아나지 않는다.

     그리고 페이지가 뜨자마자는 열지 않는다. 그 시점에는 주소도 카드도 안 들어가 있어서
     부가세도 총액도 화면에 없다. 아직 아무것도 못 읽은 채로 카드부터 펼치면
     사용자는 읽을 게 없는 화면을 먼저 만나고, 우리가 할 줄 아는 게 없다고 결론 내린다.
     그래서 값이 확정될 때까지는 배지만 두고, 확정되는 순간 배지를 한 번 밝힌 뒤 연다. */
  function openBriefly(ms) {
    if (S.stickOpen || !S.ready) return;
    toggleCard(true);
    clearTimeout(S.autoHide);
    S.autoHide = setTimeout(() => { if (!S.stickOpen) toggleCard(false); }, ms || 9000);
  }
  function stick() { S.stickOpen = true; clearTimeout(S.autoHide); }

  /* 읽을 값이 생겼는가.
     결제 페이지를 연 순간에는 금액만 있고 나머지는 전부 미정이다. 부가세가 붙을지, 사업자번호
     칸이 있을지, 면제가 먹을지 — 주소나 카드가 들어가야 화면에 나타난다. 그 전에 카드를 펼치면
     "확인 중입니다"만 잔뜩 말하게 되고, 사용자는 그게 이 도구의 전부라고 생각한다.
     그래서 셋 중 하나가 있어야 연다: 부가세가 계산됐거나, 결제가 끝났거나,
     사용자가 뭔가 입력하기 시작했거나(또는 그만큼 시간이 지났거나). */
  const DWELL_MS = 15000;
  function hasSignal(scan, dec) {
    if (scan.success) return true;
    if (scan.vat > 0) return true;
    if (!(scan.total && scan.total.val > 0)) return false;
    if (!(S.typed || S.dwelt)) return false;      // 아직 아무것도 안 건드린 상태 — 조용히 있는다
    if (!watchState(scan)) return true;           // 아직 물어보지 않은 게 있다: 이 구독 알림
    return dec.action !== ACT.WAIT_ADDRESS;       // 세무 이야기는 부가세가 실제로 보일 때만
  }

  /* 자동으로 여는 것은 화면 한 종류당 한 번뿐이다.
     아직 열 때가 아니면 '봤다'고 표시하지 않는다 — 표시해 버리면 정작 값이 확정된 뒤에 못 연다. */
  function announce(key) {
    if (S.shown[key] || !S.ready) return;
    S.shown[key] = true;
    openBriefly();
  }

  /* 배지를 한 번 은은하게 밝힌다. 소리도 이동도 없이, 여기 뭔가 생겼다는 것만 알린다. */
  function glowBadge() {
    const b = document.getElementById("svst-badge");
    if (!b || S.glowed) return;
    S.glowed = true;
    b.classList.add("svst-ready");
    setTimeout(() => b.classList.remove("svst-ready"), 5200);
  }

  function setBadge(mode, label, value) {
    const b = document.getElementById("svst-badge");
    if (!b) return;
    /* 금액을 확신하지 못할 때가 있다. 그때는 숫자 없이 물음 한 줄만 띄운다 —
       비어 있는 배지보다는 낫고, 틀린 숫자보다는 훨씬 낫다. */
    const on = !!(value || label);
    b.classList.toggle("svst-pill", on);
    b.classList.toggle("svst-orange", on && (mode === "setup" || mode === "action" || mode === "ask" || mode === "due"));
    b.classList.toggle("svst-mint", on && mode === "done");
    b.classList.toggle("svst-dot", mode === "setup" || mode === "ask");

    const face = b.querySelector(".svst-face");
    face.querySelector(".svst-plate-label").textContent = on ? label : "돈나가요";
    face.querySelector(".svst-plate-val").textContent = value || "";

    /* 누적 절감액은 "이 도구를 계속 켜 둘 이유"다. 하지만 이번 결제 금액과 같은 자리에
       나란히 쓰면 어느 쪽이 지금 이야기인지 흐려진다. 그래서 자리를 나누지 않고 시간을 나눈다.
       확정된 절감이 아직 없으면 뒷장은 아예 만들지 않는다 — 0원을 자랑할 이유가 없다. */
    /* 이 숫자는 "이미 아낀 돈"이 아니다. 사업자번호 등록이 끝나 이제 부가세가 안 붙게 된
       서비스들의, 1년치 부가세 합계다. 과거형으로 부르면 지금 당장 그만큼 벌었다고 읽힌다. */
    const W = self.SVSTWatch;
    const vatYear = W ? W.vatFreeYear(S.stats) : 0;
    const alt = b.querySelector(".svst-alt");
    const twoFaced = on && vatYear > 0;
    if (twoFaced) {
      alt.querySelector(".svst-plate-label").textContent = "안 낼 수 있는 부가세";
      alt.querySelector(".svst-plate-val").textContent = "연 " + won(vatYear);
    }
    b.classList.toggle("svst-two", twoFaced);
    if (twoFaced) startFlip(b); else stopFlip(b);
  }

  /* 4초에 한 번, 0.5초에 걸쳐 바뀐다. 더 빠르면 읽기 전에 사라지고,
     더 느리면 두 번째 장이 있다는 걸 눈치채지 못한다. */
  function startFlip(b) {
    if (S.flipTimer) return;
    S.flipTimer = setInterval(() => {
      const faces = b.querySelectorAll(".svst-face");
      if (faces.length < 2 || !b.classList.contains("svst-two")) return;
      const showingFirst = faces[0].classList.contains("svst-on");
      faces[0].classList.toggle("svst-on", !showingFirst);
      faces[1].classList.toggle("svst-on", showingFirst);
    }, 4000);
  }
  function stopFlip(b) {
    clearInterval(S.flipTimer); S.flipTimer = null;
    const faces = b.querySelectorAll(".svst-face");
    if (faces.length > 1) { faces[0].classList.add("svst-on"); faces[1].classList.remove("svst-on"); }
  }

  function html(strings, ...vals) { return strings.map((s, i) => s + (vals[i] ?? "")).join(""); }

  /* 서비스명은 결제 페이지의 글자에서 읽은 것이다. 우리가 쓴 글이 아니므로
     화면에 넣기 전에 중화한다. 클립보드·CSV로 나가는 문장에는 쓰지 않는다 —
     거기서는 &amp; 같은 것이 그대로 보이면 오히려 틀린 값이 된다. */
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // ---------- 문구 조각 ----------
  const laterWord = (i) => i === "year" ? "내년 갱신부터" : i === "month" ? "다음 달부터" : "다음 결제부터";
  const everyWord = (i) => i === "year" ? "매년" : i === "month" ? "매달" : "매번";
  const cycleWord = (i) => i === "year" ? "매년 " : i === "month" ? "매달 " : "";
  const planWord = (i) => i === "year" ? "연 구독" : i === "month" ? "월 구독" : "반복 결제";

  /* 다음 결제일. 말일 넘침을 조심한다 — 1월 31일의 한 달 뒤는 2월 31일이 아니다. */
  function addInterval(iso, interval) {
    const [y, m, d] = String(iso).split("-").map(Number);
    let ny = y, nm = m;
    if (interval === "year") ny += 1; else { nm += 1; if (nm > 12) { nm = 1; ny += 1; } }
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  }
  const dateKo = (iso) => {
    const [y, m, d] = String(iso).split("-").map(Number);
    return `${y}년 ${m}월 ${d}일`;
  };
  const leadWord = (i) => i === "year" ? "14일" : "5일";

  /* 뒤로 가기. 화면을 되돌리는 것뿐이라 저장된 것은 건드리지 않는다 —
     사업자등록번호는 저장 버튼을 누른 순간에만 쓰이고, 그 뒤로는 어떤 화면 이동으로도 지워지지 않는다. */
  /* 알림은 서비스마다 따로 묻는다. 한 번 '괜찮습니다'를 눌렀다고 다음 구독까지 안 물으면
     정작 막고 싶었던 결제를 놓친다. 반대로 매번 다시 물으면 성가시다. 그래서 서비스 단위로 기억한다. */
  const watchState = (scan) => (S.flow && S.flow.asked && S.flow.asked[mkeyOf(scan.merchant)]) || null;
  async function setWatchState(scan, v) {
    S.flow = { asked: { ...((S.flow && S.flow.asked) || {}), [mkeyOf(scan.merchant)]: v } };
    await chrome.storage.local.set({ flow: S.flow });
  }

  function compareBlock(scan, nowLabel, laterLabel) {
    if (!scan.total || scan.total.cur !== "KRW" || !scan.vat) return "";
    return `<div class="svst-compare">
      <div class="svst-now"><span>${nowLabel}</span><b>${won(scan.total.val)}</b></div>
      <div class="svst-later"><span>${laterLabel}</span><b>${won(scan.total.val - scan.vat)}</b></div>
    </div>`;
  }

  function fxTipLine(scan) {
    if (!(scan.stripeRate && S.rates && S.rates.KRW && scan.total && scan.total.cur === "KRW")) return "";
    const usd = scan.total.val / scan.stripeRate;
    const diff = Math.round(scan.total.val - usd * S.rates.KRW * (1 + R.CARD_FEE));
    if (diff > 1000) return html`<div class="svst-tip">USD로 결제하면 약 <b>${won(diff)}</b> 저렴할 수 있습니다 · 카드사마다 다릅니다</div>`;
    if (diff < -1000) return html`<div class="svst-tip">이 결제는 원화가 유리합니다</div>`;
    return "";
  }

  function memoFor(scan, dec) {
    const amt = money(scan.total);
    if (dec.supplier === SUP.DOMESTIC) {
      return `${scan.merchant || "(서비스명)"} ${amt} 결제. 국내 사업자 거래로 세금계산서 수취 대상입니다. 발급 요청해 두었습니다.`;
    }
    if (dec.supplier === SUP.UNKNOWN) {
      return `${scan.merchant || "(서비스명)"} ${amt} 결제. 공급자가 국내인지 해외인지 확인되지 않아 부가세 처리는 비워 둡니다. 확인 부탁드립니다.`;
    }
    return `해외 서비스 ${scan.merchant || "(서비스명)"} ${amt} 결제. ` + dec.vat.note;
  }

  /* '기록함'과 '설정'은 우리 머릿속 이름이었다. 처음 보는 사람에게는
     무엇이 열리는지 알 수 없는 말이라, 열리는 것의 이름을 그대로 쓴다. */
  const FOOT = `<div class="svst-foot">
    <span class="svst-flink" data-svst="open-book">구독 목록</span>
    <span class="svst-fdot">·</span>
    <span class="svst-flink" data-svst="settings">내 정보</span></div>`;

  // ---------- 화면 ----------
  /* 화면은 종류가 스물이 넘지만 모양은 하나다.
   *
   *   [상황 한 줄]  [이름표]      ← 높이 고정
   *   [숫자 또는 제목]            ← 높이 고정
   *   [본문 한 줄]
   *   …빈 자리…
   *   [버튼]                      ← 언제나 카드 맨 아래
   *   [기록함 · 설정]
   *
   * 자리를 고정하면 화면이 바뀌어도 눈이 숫자를 다시 찾지 않는다.
   * 그리고 칸이 하나씩뿐이라 문장을 늘릴 자리가 없다 — 그게 이 함수의 진짜 역할이다.
   */
  /* ── 지금 어디에 있는가 ──
     "1 / 2"만으로는 무엇의 1인지 알 수 없다. 무슨 단계인지 이름을 대고,
     뒤에 무엇이 더 남았는지도 같이 보여 준다. 그래야 지금 답하는 것이 무엇을 위한
     질문인지 알고, 끝났는데 또 뭔가 남았나 하는 불안도 없다.
     단계가 하나뿐인 화면에서는 번호를 붙이지 않는다 — 번호가 붙으면 없는 다음 단계를 기다린다. */
  function railHtml(rail) {
    if (!rail || !rail.steps || !rail.steps.length) return "";
    const one = rail.steps.length === 1;
    return `<div class="svst-rail">` + rail.steps.map((name, i) =>
      (i ? `<span class="svst-mid">·</span>` : "") +
      `<span class="${i === rail.at ? "svst-now" : ""}">${one ? "" : (i + 1) + " "}${name}</span>`
    ).join("") + `</div>`;
  }

  /* 부가세 단계는 사업자에게만, 그것도 부가세 줄이 실제로 보일 때만 존재한다.
     없는 단계를 지도에 그려 두면 "2번은 왜 안 나오지"가 된다. */
  function railFor(scan, at, single) {
    if (single) return { steps: [single], at: 0 };
    const two = IS_STRIPE && (at === 1 || (scan && scan.vat > 0));
    return { steps: two ? ["결제 알림", "부가세"] : ["결제 알림"], at: two ? at : 0 };
  }

  function screen(o) {
    const tone = o.tone === "hot" ? "" : o.tone === "ok" ? " svst-ok" : " svst-plain";
    /* 뒤로는 제목 자리에 들어간다. 줄을 따로 만들면 그 화면만 아래로 밀려
       숫자와 본문의 높이가 어긋난다 — 고정하려던 것이 바로 그것이다. */
    return `<div class="svst-head">
        ${o.back
          ? `<span class="svst-back" data-svst="back-${o.back}">← 뒤로</span>`
          : `<span class="svst-title svst-brand"><img src="${chrome.runtime.getURL("icon48.png")}" alt=""><span>돈나가요<small>donna.co.kr</small></span></span>`}
        <span class="svst-close" id="svst-x">✕</span>
      </div>
      <div class="svst-top">
        ${railHtml(o.rail)}
        ${o.ctx ? `<div class="svst-ctx">${o.ctx}</div>` : ""}
        ${o.label ? `<div class="svst-eyebrow${tone}">${o.label}</div>` : ""}
      </div>
      <div class="svst-hero">${o.big ? `<div class="svst-big">${o.big}</div>`
        : o.msg ? `<div class="svst-msg">${o.msg}</div>` : ""}</div>
      ${o.body ? `<p class="svst-body">${o.body}</p>` : ""}
      ${o.extra || ""}
      ${o.note ? `<div class="svst-quiet">${o.note}</div>` : ""}
      <div class="svst-acts">${o.acts || ""}</div>
      <div class="svst-tail">
        ${o.fine ? `<div class="svst-fine">${o.fine}</div>` : ""}
        ${o.foot === false ? "" : FOOT}
      </div>`;
  }

  const cycSeg = (v, t, cur) =>
    `<button class="svst-seg-b${cur === v ? " on" : ""}" data-svst="cyc-${v}">${t}</button>`;
  const btn = (a, t) => `<button class="svst-btn" data-svst="${a}">${t}</button>`;
  const ghost = (a, t) => `<button class="svst-btn svst-ghost" data-svst="${a}">${t}</button>`;

  function render() {
    const card = document.getElementById("svst-card");
    if (!card) return;
    const scan = S.scan || lockMerchant(scanPage());
    const dec = S.dec || decide(scan);

    /* ── 첫 실행: 동의. 금액을 먼저 보여주고(그게 이 도구를 켤 이유니까),
       무엇이 저장되고 무엇을 안 하는지 말한다. 동의 전에는 한 바이트도 저장하지 않는다. */
    if (!S.consent) {
      const hasAmt = scan.total && scan.total.val > 0;
      card.innerHTML = screen({
        rail: railFor(scan, 0, "시작하기"),
        tone: hasAmt ? "hot" : "plain",
        label: hasAmt ? `${everyWord(scan.interval)} 빠져나갈 금액` : "시작하기",
        big: hasAmt ? money(scan.total) : "",
        msg: hasAmt ? "" : "해외 결제를 챙겨 드립니다.",
        body: `해외 툴은 결제되고 나면 환불이 거의 안 됩니다.
          그래서 <b>빠져나가기 며칠 전에 미리 알려 드립니다.</b>`,
        extra: `<div class="svst-later">읽은 내용은 이 브라우저 밖으로 나가지 않습니다.
          회원가입도, 카드번호를 보는 일도 없습니다.</div>`,
        acts: btn("consent", "시작하기"),
        foot: false
      });
      return bind(card, scan, dec);
    }

    /* ── 설정.
       예전에는 '설정'을 누르면 프로필을 지웠다. 열어 봤을 뿐인데 번호가 사라졌다.
       지우는 것은 지우겠다고 말한 뒤에만 한다. */
    if (S.view === "settings") {
      const p = S.profile;
      const typeName = !p ? "아직 설정 안 함"
        : p.type === "solo" ? "개인사업자" : p.type === "corp" ? "법인" : "사업자 아님";
      card.innerHTML = screen({
        rail: railFor(scan, 0, "내 정보"),
        back: "main",
        label: "설정",
        msg: "저장된 것",
        body: `<b>${typeName}</b>${p && p.brn ? ` · ${esc(p.brn)}` : ""}. 이 브라우저에만 있습니다.`,
        extra: `<div class="svst-err" id="svst-wipe-note"></div>`,
        acts: (p && p.type !== "personal"
          ? ghost("edit-brn", p.brn ? "사업자번호 바꾸기" : "사업자번호 입력하기")
          : ghost("go-tax", "사업자로 설정하기")) + ghost("wipe", "저장된 것 지우기"),
        foot: false
      });
      return bind(card, scan, dec);
    }

    /* ── 1순위: 구독 알림.
       부가세는 사업자만, 그것도 부가세 줄이 보일 때만 쓸모가 있다.
       '나도 모르게 또 빠져나갔다'는 모두에게 해당한다. 그래서 이걸 먼저 묻는다.
       사업자등록번호를 묻지 않고 여기까지 끝난다. */
    if (!watchState(scan) && !scan.success && (knowsAmount(scan) || scan.checkoutLike)) {
      const known = knowsAmount(scan);

      /* 주기를 모르면 다음 결제일을 계산할 수 없다. 여기서 한 번만 묻는다 —
         사용자는 확실히 아는 정보고, 탭 한 번이면 끝난다.
         모르는 채로 '월'이라고 가정하면 틀린 날짜로 알림이 가는데, 그건 안 가느니만 못하다. */
      if (!scan.interval) {
        card.innerHTML = screen({
          rail: railFor(scan, 0),
          ctx: esc(scan.merchant || "이 서비스"),
          tone: "plain",
          label: "결제 주기",
          big: known ? money(scan.total) : "",
          msg: known ? "" : "이 구독은 얼마마다 결제되나요?",
          body: known ? "이 금액이 얼마마다 빠져나가나요?"
                      : "다음 결제일을 계산하려면 이것만 알면 됩니다.",
          acts: btn("cyc-month", "매달") + ghost("cyc-year", "매년"),
          fine: "이 브라우저에만 저장됩니다"
        });
        return bind(card, scan, dec);
      }

      card.innerHTML = screen({
        rail: railFor(scan, 0),
        back: S.cycleLock ? "cycle" : "",
        /* 주기는 화면을 읽어 맞히지만 틀릴 때가 있다. 플랜 고르는 칸에 다른 주기가 같이
           떠 있는 결제창이 흔하기 때문이다(연 결제인데 위쪽에 '/month'가 보이는 식).
           틀린 주기는 틀린 날짜가 되고, 틀린 날짜로 가는 알림은 안 가느니만 못하다.
           그래서 주기가 적힌 바로 그 자리에서 한 번에 바꿀 수 있게 둔다.
           줄을 새로 만들지 않아 카드 높이는 다른 화면과 그대로 같다. */
        ctx: `${esc(scan.merchant || "이 서비스")}
          <span class="svst-seg">${cycSeg("month", "매달", scan.interval)}${cycSeg("year", "매년", scan.interval)}</span>`,
        tone: known ? "hot" : "plain",
        label: known ? `${everyWord(scan.interval)} 빠져나갈 금액` : "결제 전 알림",
        big: known ? money(scan.total) : "",
        msg: known ? "" : "빠져나가기 전에 알려 드릴게요.",
        extra: (() => {
          const today = todayISO();
          const next = addInterval(today, scan.interval);
          return `<div class="svst-dl">
              <div><span>오늘 결제</span><b>${dateKo(today)}</b></div>
              <div><span>다음 결제</span><b>${dateKo(next)}</b></div>
            </div>
            <div class="svst-later">결제 <b>${leadWord(scan.interval)} 전</b>에 알려 드릴게요.
              ${known ? "그때 계속 쓸지 정하시면 됩니다."
                      : "금액은 읽지 못해 비워 뒀고, 구독 목록에서 채우실 수 있습니다."}</div>`;
        })(),
        acts: btn("watch-on", "결제 전에 알려주세요") + ghost("watch-skip", "괜찮습니다")
      });
      return bind(card, scan, dec);
    }

    /* ── 2순위: 부가세. 아낄 게 눈에 보일 때만 사업자 여부를 묻는다 —
       부가세 줄이 없는 화면에서 물으면 그게 왜 필요한 질문인지 알 수가 없다. */
    if (!S.profile) {
      const wantTax = IS_STRIPE && (S.view === "tax" || scan.vat > 0);
      if (!wantTax) {
        const on = watchState(scan) === "on";
        card.innerHTML = screen({
          rail: railFor(scan, 0),
          back: "watch",
          tone: on ? "ok" : "plain",
          label: on ? "알림 켜짐" : "확인 완료",
          msg: "지금 하실 일은 없습니다.",
          body: on ? "결제일 전에 알려 드릴게요." : "금액과 주기는 읽어 두었습니다.",
          extra: IS_STRIPE
            ? `<div class="svst-later">사업자시면 이 결제의 <b>부가세 10%</b>를 돌려받을 수 있습니다.</div>` : "",
          acts: btn("close", "저장하고 닫기") + (IS_STRIPE ? ghost("go-tax", "부가세도 챙기기") : "")
        });
        return bind(card, scan, dec);
      }
      const hasVat = scan.vat > 0;
      card.innerHTML = screen({
        rail: railFor(scan, 1),
        back: S.view === "tax" ? "main" : "watch",
        tone: hasVat ? "hot" : "plain",
        label: hasVat ? `${cycleWord(scan.interval)}붙는 부가세` : "부가세 설정",
        big: hasVat ? won(scan.vat) : "",
        msg: hasVat ? "" : "해외 결제의 부가세를 챙깁니다.",
        body: "사업자번호를 넣으면 안 낼 수 있습니다.",
        acts: btn("type-solo", "개인사업자입니다") + ghost("type-corp", "법인입니다")
          + ghost("type-personal", "사업자가 아닙니다"),
        fine: "이 브라우저에만 저장됩니다",
        foot: false
      });
      return bind(card, scan, dec);
    }
    if (S.profile.pendingBrn) {
      card.innerHTML = screen({
        rail: railFor(scan, 1),
        back: "type",
        label: "사업자등록번호",
        msg: "번호를 넣으면 부가세가 빠집니다.",
        extra: `<input type="text" id="svst-brn" placeholder="000-00-00000" inputmode="numeric"
            autocomplete="off" value="${esc(S.profile.brn || "")}" />
          <div class="svst-err" id="svst-brn-err"></div>`,
        acts: btn("save-brn", "번호 저장하기"),
        fine: "국세청 검증을 통과한 번호만 저장합니다",
        foot: false
      });
      return bind(card, scan, dec);
    }

    const isBiz = S.profile.type !== "personal";
    let body;

    // ── 1) 결제 완료
    if (scan.success) {
      if (!isBiz) {
        body = screen({ rail: railFor(scan, 0, "결제 완료"), tone: "ok", label: "결제 완료", msg: "영수증은 메일로 갑니다.",
          acts: btn("close", "닫기") });
      } else if (dec.charge === CH.REFUND) {
        body = screen({ rail: railFor(scan, 0, "기록"), label: "환불", msg: "환불로 기록했습니다.",
          body: "분기 자료에서 빼 드립니다.", acts: btn("close", "닫기") });
      } else if (dec.unknowns.includes("supplier")) {
        body = screen({
          rail: railFor(scan, 0, "기록"),
          back: "supplier", tone: "ok", label: "기록 완료", msg: "한 가지만 알려주세요.",
          body: `${esc(scan.merchant || "이 서비스")}에서 <b>세금계산서</b>를 받을 수 있나요?`,
          acts: supplierButtons()
        });
      } else {
        body = screen({
          rail: railFor(scan, 0, "기록"),
          tone: "ok", label: "기록 완료", msg: "더 하실 일은 없습니다.",
          body: "분기 자료에 담았습니다.",
          acts: btn("close", "저장하고 닫기") + ghost("copy-memo", "전달용 메모 복사")
        });
      }
    }
    // ── 2) 결제 직전 / 구독 관리
    else if (PAGE === "checkout" || PAGE === "portal") {
      body = checkoutBody(scan, dec, isBiz);
    }
    // ── 3) 영수증 · 인보이스
    else {
      body = screen({
        rail: railFor(scan, 0, "증빙"),
        tone: "ok", label: S.receiptSaved ? "기록 완료" : "증빙",
        msg: S.receiptSaved ? "기록함에 저장했습니다." : "이 페이지가 증빙입니다.",
        body: dec.supplier === SUP.DOMESTIC
          ? "국내 거래입니다. 세금계산서를 요청하세요."
          : "PDF도 내려받아 두면 좋습니다.",
        acts: btn("close", "저장하고 닫기") + (isBiz ? ghost("copy-memo", "전달용 메모 복사") : "")
      });
    }

    card.innerHTML = body;
    bind(card, scan, dec);
  }

  function supplierButtons() {
    return btn("sup-domestic", "세금계산서를 받을 수 있어요")
      + ghost("sup-overseas", "해외 서비스라 못 받아요")
      + ghost("sup-skip", "모르겠어요");
  }

  /* Stripe가 아닌 결제창.
     금액·주기·다음 결제일까지는 똑같이 읽는다. 안 하는 것은 부가세 처리 하나다.
     못 하는 걸 조용히 넘어가면 사용자는 됐다고 믿는다. 그래서 안 한다고 적어 둔다. */
  function watchStatusBody(scan) {
    const on = watchState(scan) === "on";
    return screen({
      rail: railFor(scan, 0),
      back: "watch",
      ctx: `${esc(scan.merchant || "이 서비스")} · ${planWord(scan.interval)}`,
      tone: on ? "ok" : "plain",
      label: on ? "알림 켜짐" : "확인 완료",
      msg: on ? "결제 전에 알려 드릴게요." : "지금 하실 일은 없습니다.",
      body: on ? `다음 결제 <b>${leadWord(scan.interval)} 전</b>에 한 번 뜹니다.`
        : "금액과 주기는 읽어 두었습니다.",
      extra: `<div class="svst-later">세무 자료로 쌓는 것은 Stripe 결제창에서만 합니다.
        영수증은 따로 보관해 두세요.</div>`,
      acts: on ? btn("close", "저장하고 닫기") : btn("watch-on", "결제 전에 알려주세요")
    });
  }

  /* 결제창 화면은 판정 결과(action) 하나로 고른다. 시나리오별 if가 아니다. */
  function checkoutBody(scan, dec, isBiz) {
    /* Stripe가 아닌 자체 결제창.
       여기서도 사업자번호 칸이 화면에 보이고 부가세 줄도 보이면, 그건 지금 눈으로 확인되는
       사실이다. 그래서 '넣으면 이 결제에서 빠진다'까지는 말한다.
       말하지 않는 것은 '다음 결제부터 빠진다' 쪽이다 — 그건 갱신 때 어떻게 되는지
       확인하지 못했고, 확인 못 한 걸 된다고 하면 사용자는 다음 해에 그대로 낸다. */
    if (!IS_STRIPE) {
      const canFill = isBiz && S.profile && S.profile.brn && scan.vat > 0
        && (scan.hasTaxField || scan.hasTaxTrigger);
      if (!canFill) return watchStatusBody(scan);
      return screen({
        rail: railFor(scan, 1),
        ctx: "이 결제창에 <b>사업자번호 칸</b>이 있습니다.",
        tone: "hot", label: "지금 뺄 수 있는 부가세", big: won(scan.vat),
        body: "번호를 넣으면 <b>이 결제부터</b> 빠집니다.",
        extra: compareBlock(scan, "지금", "번호 넣으면"),
        note: S.filledOnce
          ? "부가세 줄이 사라졌는지 보세요. 그대로면 <b>국가·주소</b>를 먼저 채워야 합니다." : "",
        acts: btn("fill", `사업자번호 넣고 ${won(scan.vat)} 빼기`)
      });
    }
    if (!isBiz) {
      return screen({ rail: railFor(scan, 1), back: "type", label: "확인 완료", msg: "정상 결제입니다.",
        body: "개인 구매는 부가세가 붙는 게 맞습니다.", extra: fxTipLine(scan),
        acts: btn("close", "저장하고 닫기") });
    }
    if (dec.charge === CH.FAILED) {
      return screen({ rail: railFor(scan, 1), back: "type", label: "결제 실패", msg: "기록하지 않았습니다.",
        body: "성공한 결제만 자료에 들어갑니다.", acts: btn("close", "닫기") });
    }
    if (dec.charge === CH.TRIAL) {
      return screen({ rail: railFor(scan, 1), back: "type", label: "무료 체험", msg: "지금은 0원입니다.",
        body: "유료로 바뀌는 날 알려 드릴게요.",
        acts: ghost("watch-trial", "전환일에 알림받기") });
    }

    switch (dec.action) {
      case ACT.ASK_SUPPLIER:
        return screen({
          rail: railFor(scan, 1),
          back: "type",
          tone: "hot", label: `${cycleWord(scan.interval)}붙는 부가세`, big: won(scan.vat),
          body: `${esc(scan.merchant || "이 서비스")}에서 <b>세금계산서</b>를 받을 수 있나요?`,
          acts: supplierButtons()
        });

      case ACT.ADVISOR:
        return screen({
          rail: railFor(scan, 1),
          back: "type",
          label: "면세사업자", big: won(scan.vat),
          body: "번호를 넣어 부가세를 빼면 <b>대신 납부</b>하게 될 수 있습니다(부가세법 §52).",
          note: "기록해 두고 <b>세무대리인 확인 필요</b>로 표시합니다.",
          acts: btn("close", "저장하고 닫기")
        });

      case ACT.FILL_NOW:
        return screen({
          rail: railFor(scan, 1),
          back: "type",
          ctx: "이 결제창에 <b>사업자번호 칸</b>이 있습니다.",
          tone: "hot", label: "지금 뺄 수 있는 부가세", big: won(scan.vat),
          body: "번호를 넣으면 <b>이 결제부터</b> 빠집니다.",
          extra: compareBlock(scan, "지금", "번호 넣으면"),
          note: S.filledOnce
            ? "부가세 줄이 사라졌는지 보세요. 그대로면 <b>국가·주소</b>를 먼저 채워야 합니다." : "",
          acts: btn("fill", `사업자번호 넣고 ${won(scan.vat)} 빼기`)
        });

      case ACT.REGISTER_LATER:
        return screen({
          rail: railFor(scan, 1),
          back: "type",
          ctx: "이 결제창에는 <b>사업자번호 칸이 없습니다.</b>",
          tone: "hot", label: `${everyWord(scan.interval)} 반복되는 부가세`, big: won(scan.vat),
          body: "오늘 결제분은 그대로 나갑니다.",
          extra: compareBlock(scan, "오늘 결제", laterWord(scan.interval)),
          acts: btn("save-todo", `${laterWord(scan.interval)} ${won(scan.vat)} 아끼기`)
        });

      case ACT.ALREADY_EXEMPT: {
        const mk = mkeyOf(scan.merchant);
        if (S.pending[mk]) {
          return screen({ rail: railFor(scan, 1), back: "type", tone: "ok", label: "면제 적용됨", big: won(S.pending[mk].vat),
            body: "갱신될 때마다 이 금액을 아낍니다." });
        }
        return screen({ rail: railFor(scan, 1), back: "type", label: "확인 완료", msg: "부가세 0원",
          body: "면제가 적용됐습니다. 그대로 결제하세요.", extra: fxTipLine(scan),
          acts: btn("close", "저장하고 닫기") });
      }

      case ACT.WAIT_ADDRESS:
        return screen({ rail: railFor(scan, 1), back: "type", label: "확인 중", msg: "부가세가 아직 안 보입니다.",
          body: "주소를 넣으면 다시 확인해 드릴게요.", extra: fxTipLine(scan),
          acts: btn("close", "저장하고 닫기") });

      default: {
        // 국내 공급자 / 이미 예약됨 / 할 일 없음
        if (dec.supplier === SUP.DOMESTIC) {
          return screen({
            rail: railFor(scan, 1),
            back: "supplier", tone: "ok", label: "국내 사업자", msg: "세금계산서를 받으세요.",
            body: "번호를 넣는 게 아니라 <b>매입세액공제</b>를 받는 쪽입니다.",
            note: "구독 목록에 할 일로 남겼습니다.",
            acts: btn("close", "저장하고 닫기")
          });
        }
        const mk = mkeyOf(scan.merchant);
        if (S.pending[mk]) {
          return screen({
            rail: railFor(scan, 1),
            back: "type", tone: "ok", label: `${laterWord(scan.interval)} 적용`, msg: "그대로 결제하세요.",
            body: `그때부터 ${everyWord(scan.interval)} <b>${won(S.pending[mk].vat)}</b>을 아낍니다.`,
            acts: PAGE === "portal"
              ? btn("fill", "지금 자동 입력") + ghost("copy-brn", "번호 복사")
                + ghost("done-todo", "등록 완료") : ""
          });
        }
        if (PAGE === "portal") {
          return screen({
            rail: railFor(scan, 1, "구독 관리"),
            back: "type", label: "구독 관리", msg: "부가세를 0원으로.",
            body: "<b>'세금 ID 추가'</b>가 보이면 아래를 누르세요.",
            acts: btn("fill", "자동 입력") + ghost("copy-brn", "번호 복사")
          });
        }
        return screen({ rail: railFor(scan, 1), back: "type", label: "확인 완료", msg: "지금 하실 일은 없습니다.",
          body: "결제를 마치면 자동으로 기록합니다.", extra: fxTipLine(scan),
          acts: btn("close", "저장하고 닫기") });
      }
    }
  }

  // ---------- 이벤트 ----------
  function bind(card, scan, dec) {
    card.querySelector("#svst-x")?.addEventListener("click", () => toggleCard(false));
    const mk = mkeyOf(scan.merchant);

    card.querySelectorAll("[data-svst]").forEach(el => {
      el.addEventListener("click", async () => {
        const a = el.getAttribute("data-svst");

        if (a === "consent") {
          S.consent = { v: CONSENT_VERSION, ts: Date.now() };
          await chrome.storage.local.set({ consent: S.consent });
          return render();
        }
        /* 뒤로. 화면만 되돌린다. 저장된 것은 하나도 건드리지 않는다.
           사업자 유형은 '저장' 이전이라 메모리에만 있고, 번호는 저장된 뒤라면 그대로 남는다. */
        /* 할 일이 없는 화면은 '확인'으로 끝난다. 끝났는데 카드가 남아 있으면
           사용자는 뭘 더 해야 하나 계속 들여다본다. */
        if (a === "close") { S.stickOpen = false; return toggleCard(false); }
        if (a === "back-main") { S.view = null; return render(); }

        /* 처음 쓰는 사람은 뭐가 뭔지 모르니 일단 눌러 보고, 아니다 싶으면 되돌린다.
           그래서 답을 하고 나면 반드시 그 답을 되돌릴 자리가 있어야 한다.
           되돌린다는 것은 답을 지우는 것이지 다른 화면으로 넘어가는 게 아니다. */
        if (a === "back-watch") {
          const asked = { ...((S.flow && S.flow.asked) || {}) };
          delete asked[mk];
          S.flow = { asked };
          await chrome.storage.local.set({ flow: S.flow });
          S.view = null;
          return render();
        }
        if (a === "back-cycle") {
          S.cycleLock = null;
          const asked = { ...((S.flow && S.flow.asked) || {}) };
          delete asked[mk];
          S.flow = { asked };
          await chrome.storage.local.set({ flow: S.flow });
          S.scan = null; S.dec = null;
          return render();
        }
        if (a === "back-supplier") {
          delete S.suppliers[mk];
          await chrome.storage.local.set({ suppliers: S.suppliers });
          S.dec = decide(scan);
          return render();
        }
        if (a === "back-type") {
          if (S.profile && S.profile.brn) {
            // 이미 저장된 번호를 고치던 중이었다 — 고치기를 그만두는 것이지 지우는 게 아니다
            delete S.profile.pendingBrn;
            S.view = "settings";
          } else {
            S.profile = null;                      // 아직 저장 전 — 유형 선택으로
            S.view = IS_STRIPE ? "tax" : null;
          }
          return render();
        }
        if (a === "go-tax") { S.view = "tax"; return render(); }

        /* 구독 알림 — 사업자등록번호를 묻지 않고 여기까지 끝난다.
           세무 쪽 저장소(subs)와 섞지 않는다. 알림은 알림 목록(watch)에만 들어간다. */
        if (a === "watch-on") {
          const ok = await registerWatch(scan);
          await setWatchState(scan, ok ? "on" : "off");
          return render();
        }
        if (a === "watch-skip") { await setWatchState(scan, "off"); return render(); }
        if (a === "cyc-month" || a === "cyc-year") {
          S.cycleLock = { interval: a === "cyc-year" ? "year" : "month",
                          mkey: mkeyOf((S.scan && S.scan.merchant) || "") };
          S.scan = lockMerchant(scanPage());
          S.dec = decide(S.scan);
          return render();
        }

        if (a === "edit-brn") { S.profile = { ...S.profile, pendingBrn: true }; S.view = null; return render(); }
        if (a === "wipe") {
          const note = card.querySelector("#svst-wipe-note");
          if (el.dataset.armed !== "1") {
            el.dataset.armed = "1";
            el.textContent = "정말 지웁니다 · 한 번 더";
            if (note) note.textContent = "사업자번호·기록·알림이 모두 사라집니다. 되돌릴 수 없습니다.";
            return;
          }
          await chrome.storage.local.clear();
          S.profile = null; S.consent = null; S.flow = null; S.pending = {};
          S.ledger = []; S.subs = {}; S.suppliers = {}; S.view = null;
          return render();
        }

        if (a === "type-solo") { S.profile = { type: "solo", pendingBrn: true }; return render(); }
        if (a === "type-corp") { S.profile = { type: "corp", pendingBrn: true }; return render(); }
        if (a === "type-personal") { S.profile = { type: "personal", taxType: T.NONE }; await saveProfile(); S.view = null; return render(); }

        if (a === "save-brn") {
          const input = card.querySelector("#svst-brn");
          const err = card.querySelector("#svst-brn-err");
          if (!R.validBrn(input.value)) {
            err.textContent = input.value.replace(/\D/g, "").length === 10
              ? "국세청 검증에서 걸립니다. 숫자를 다시 확인해 주세요."
              : "10자리 숫자로 입력해 주세요.";
            input.classList.add("svst-bad");
            return;
          }
          S.profile.brn = R.fmtBrn(input.value);
          S.profile.taxType = S.profile.taxType || T.UNKNOWN;  // 과세유형은 CSV 만들 때 묻는다
          delete S.profile.pendingBrn;
          await saveProfile();
          S.view = null;
          return render();
        }

        if (a === "sup-domestic" || a === "sup-overseas") {
          S.suppliers[mk] = a === "sup-domestic" ? SUP.DOMESTIC : SUP.OVERSEAS;
          await chrome.storage.local.set({ suppliers: S.suppliers });
          if (a === "sup-domestic") await addTask(mk, scan.merchant, "invoice");
          S.dec = null; S.scan = lockMerchant(scanPage()); S.dec = decide(S.scan);
          return render();
        }
        if (a === "sup-skip") {
          await addTask(mk, scan.merchant, "supplier");
          el.textContent = "기록함에 남겼습니다";
          return;
        }

        if (a === "fill") { await fillTaxId(); S.scan = lockMerchant(scanPage()); S.dec = decide(S.scan); return render(); }

        if (a === "save-todo") {
          S.pending[mk] = { merchant: scan.merchant || "이 서비스", vat: scan.vat || 0, ts: Date.now() };
          await chrome.storage.local.set({ pending: S.pending });
          await addTask(mk, scan.merchant, "register");
          S.dec = decide(scan);
          return render();
        }
        if (a === "done-todo") {
          delete S.pending[mk];
          await chrome.storage.local.set({ pending: S.pending });
          await clearTask(mk, "register");
          return render();
        }
        if (a === "watch-trial") {
          await upsertSub(mk, { merchant: scan.merchant, interval: scan.interval || "month",
            lastPaid: todayISO(), amountOrig: 0, amountKrw: 0, trial: true });
          el.textContent = "알림 예약됨";
          return;
        }

        // 확장 페이지를 web_accessible_resources로 노출하지 않기 위해 백그라운드에 연다
        if (a === "open-book") return chrome.runtime.sendMessage({ type: "openBook" });
        if (a === "settings") { S.view = "settings"; return render(); }
        if (a === "copy-brn") { copyText(S.profile.brn); el.textContent = "복사됨"; return; }
        if (a === "copy-memo") { copyText(memoFor(scan, dec)); el.textContent = "복사됨"; return; }
      });
    });
  }

  // ---------- 할 일 ----------
  /* 사용자가 나중에 해야 하는 일은 전부 여기 모인다.
     "구독 관리에서 번호 등록", "세금계산서 요청", "공급자 확인" — 종류가 달라도 한 목록이다. */
  async function addTask(mkey, merchant, kind) {
    if (!S.consent) return;
    const { tasks = [] } = await chrome.storage.local.get("tasks");
    if (tasks.some(t => t.mkey === mkey && t.kind === kind && !t.done)) return;
    tasks.push({ id: `${kind}-${mkey}-${Date.now()}`, mkey, merchant: merchant || "이 서비스", kind, ts: Date.now(), done: false });
    await chrome.storage.local.set({ tasks });
  }
  async function clearTask(mkey, kind) {
    const { tasks = [] } = await chrome.storage.local.get("tasks");
    tasks.forEach(t => { if (t.mkey === mkey && t.kind === kind) t.done = true; });
    await chrome.storage.local.set({ tasks });
  }

  async function saveProfile() { await chrome.storage.local.set({ profile: S.profile }); }

  /* 알림 등록. 이 목록(watch)은 세무 자료로 나가지 않는다 —
     알림은 '결제되기 전에 멈출 기회'를 주는 일이고, 세무 자료는 '이미 나간 돈'을 적는 일이다.
     둘을 한 저장소에 섞으면 알림을 껐다고 세무 기록이 사라지는 사고가 난다. */
  /* 금액을 못 읽어도 알림은 건다.
     이 둘을 한 몸으로 묶어 두면, 처음 보는 결제창에서 금액 파싱이 실패하는 순간
     부가세뿐 아니라 알림까지 통째로 사라진다. 정작 사람들이 더 자주 고마워하는 건 알림 쪽이다.
     다만 주기는 있어야 한다 — 그게 없으면 언제 알릴지를 정할 수가 없다. */
  async function registerWatch(scan) {
    if (!S.consent || !scan.interval) return false;
    const dec = S.dec || decide(scan);
    const t = scan.total && scan.total.val > 0 ? scan.total : null;
    const payload = {
      key: mkeyOf(scan.merchant),
      name: scan.merchant || "이름 없는 구독",
      amountOrig: t ? t.val : null,
      currency: t ? t.cur : "KRW",
      amountKrw: !t ? null : (t.cur === "KRW" ? t.val : (dec.fx ? dec.fx.krw : null)),
      interval: scan.interval,
      auto: true,
      lastPaid: todayISO(),
      manageUrl: PAGE === "portal" ? location.href : (scan.manageLink || null),
      /* 등록한 그 화면 주소. 나중에 "그 사이트 어디였더라"가 되지 않게 남긴다.
         Stripe 결제창 주소(/c/pay/...)는 하루면 만료돼 열어도 오류 화면만 나온다.
         죽은 링크를 보여주느니 아예 안 남긴다. */
      sourceUrl: /^checkout\.stripe\.com$/i.test(location.host) ? null : location.href,
      source: PROCESSOR
    };
    try {
      const res = await chrome.runtime.sendMessage({ type: "addWatch", data: payload });
      return !!(res && res.ok);
    } catch (e) { return false; }
  }

  // ---------- 절감 확정 ----------
  /* 면제가 먹었을 때 화면이 두 가지로 갈린다. 부가세 줄을 "₩0"으로 바꾸는 곳도 있고,
     줄을 통째로 지우는 곳도 있다. 실제로는 지우는 쪽이 훨씬 많다(Envato가 그렇다).
     0만 인정하면 이 기능은 대부분의 결제창에서 아무 일도 하지 않는다.
     다만 "아직 화면을 못 읽었다"와 "부가세가 없다"는 다르다. 총액을 확실히 읽어
     화면이 다 뜬 것이 확인됐을 때만 없어진 것으로 본다. */
  function vatGone(scan) {
    if (scan.vat === 0) return true;
    return scan.vat == null && !!scan.amountSure;
  }

  async function checkSavings(scan) {
    if (PAGE !== "checkout" || !vatGone(scan)) return;
    const mk = mkeyOf(scan.merchant);
    if (S.pending[mk] && !S.savedCounted) {
      S.savedCounted = true;
      /* 한 숫자에 더하지 않고 서비스별로 남긴다. 주기가 달라서 그냥 더하면 뜻을 잃는다.
         보여줄 때 1년 기준으로 맞춰 합친다. */
      S.stats.vatFree = Object.assign({}, S.stats.vatFree, {
        [mk]: { name: S.pending[mk].merchant, vat: S.pending[mk].vat,
                interval: scan.interval === "year" ? "year" : "month", at: todayISO() }
      });
      await chrome.storage.local.set({ stats: S.stats });
      await clearTask(mk, "register");
      setTimeout(async () => {
        delete S.pending[mk];
        await chrome.storage.local.set({ pending: S.pending });
      }, 30000);
    }
  }

  // ---------- 배지 ----------
  /* 배지는 약속을 한다. 그래서 확신 없는 금액을 '아끼는 돈'이라고 부르지 않는다. */
  function updateBadge(scan, dec) {
    /* 배지는 결제 화면이라고 판단된 뒤에 비로소 만든다. 미리 만들어 두고 숨기는 게 아니라
       아예 만들지 않는다. paypal.com 로그인 화면이나 쇼핑몰 장바구니처럼 결제와 상관없는 곳에서
       한 번이라도 튀어나오면, 그 사람은 다음부터 이걸 성가신 물건으로 기억한다.
       못 뜨는 것보다 엉뚱한 데서 뜨는 것이 훨씬 나쁘다. */
    if (!scan.checkoutLike) return;
    ensureUI();

    /* 읽을 값이 처음 생긴 순간을 잡는다. 주소를 넣거나 카드가 들어가면 부가세와 총액이 나타나는데,
       그때가 우리가 할 말이 생기는 시점이다. 그 전에는 배지도 조용히 있는다. */
    const wasReady = S.ready;
    S.ready = S.ready || hasSignal(scan, dec);
    if (S.ready && !wasReady) glowBadge();

    const askWatch = !watchState(scan) && !scan.success
      && (knowsAmount(scan) || scan.checkoutLike);
    const onboarding = !S.consent || askWatch || !S.profile || S.profile.pendingBrn;
    const isBiz = S.profile && S.profile.type !== "personal";
    const cyc = cycleWord(scan.interval);
    const mk = mkeyOf(scan.merchant);

    if (onboarding) {
      // 부가세보다 '얼마가 반복해서 빠져나가는가'를 먼저 보여준다 — 그게 모두에게 해당하는 값이다.
      if (knowsAmount(scan) && (askWatch || !S.consent)) {
        setBadge("action", everyWord(scan.interval) + " 빠져나갈 금액", money(scan.total));
      } else if (scan.vat > 0) {
        setBadge("setup", cyc + "붙는 부가세", won(scan.vat));
      } else if (askWatch) {
        /* 금액을 못 읽은 결제창. 카드를 스스로 펼치지 않고 물음만 걸어 둔다.
           할 말이 분명하지 않을 때 앞에 나서면 그냥 성가시기만 하다. */
        setBadge("ask", "이 구독, 결제 전에 알려드릴까요?", "");
      } else setBadge(null, "", "");
      announce("onboard");
      return;
    }
    if (!IS_STRIPE) {
      if (watchState(scan) === "on") {
        setBadge("done", "결제 전 알림 켜짐", knowsAmount(scan) ? money(scan.total) : "");
      } else setBadge(null, "", "");
      return;
    }
    if (!isBiz) return setBadge(null, "", "");
    if (dec.charge === CH.FAILED) return setBadge(null, "", "");

    if (scan.success) {
      setBadge("done", dec.unknowns.includes("supplier") ? "확인 한 가지" : "세무 자료에 기록됨",
        scan.total ? money(scan.total) : "완료");
      announce("success");
      return;
    }
    if (dec.action === ACT.ASK_SUPPLIER) {
      setBadge("ask", "뺄 수 있는지 확인", won(scan.vat));
      announce("ask");
      return;
    }
    if (dec.action === ACT.ADVISOR) {
      setBadge("ask", "세무 확인 필요", won(scan.vat));
      announce("advisor");
      return;
    }
    if (dec.supplier === SUP.DOMESTIC && scan.vat > 0) {
      setBadge("action", "세금계산서 대상", won(scan.total ? scan.total.val : scan.vat));
      announce("domestic");
      return;
    }
    if (dec.action === ACT.FILL_NOW || dec.action === ACT.REGISTER_LATER) {
      setBadge("action", cyc + "아낄 수 있는 부가세", won(scan.vat));
      announce("vat");
      return;
    }
    if (S.pending[mk]) {
      /* vat === 0 이면 등록이 끝나 이제 안 붙는 상태다. 아직이면 등록해야 빠지는 금액이다.
         둘 다 앞으로의 이야기라 과거형을 쓰지 않는다. 말은 쉽게 한다. */
      setBadge("done",
        vatGone(scan) ? "앞으로도 부가세 없어요" : "등록하면 부가세 안 내도 돼요",
        cyc + won(S.pending[mk].vat));
      announce("pending");
      return;
    }
    setBadge(null, "", "");
  }

  /* 화면에서 숫자를 확실히 읽었을 때 딱 한 번 알린다. 알림 목록의 금액을 최신으로 맞추고,
     달라졌으면 백그라운드가 알려 준다. 사용자가 버튼을 눌러 답한 것은 여기 오지 않는다 —
     "계속 씁니다"는 결제 여부에 대한 답이지 금액을 본 것이 아니기 때문이다. */
  async function reportObservation(scan, dec) {
    if (S.observed || !S.consent) return;
    if (!(scan.total && scan.total.val > 0 && scan.amountSure)) return;
    S.observed = true;
    try {
      await chrome.runtime.sendMessage({
        type: "observePrice",
        data: {
          key: mkeyOf(scan.merchant),
          amountOrig: scan.total.val,
          currency: scan.total.cur,
          amountKrw: dec.fx ? dec.fx.krw : null,
          interval: scan.interval,
          by: PAGE,
          manageUrl: scan.manageLink || null,
          canceled: looksCanceledHere(scan)
        }
      });
    } catch (e) { /* 백그라운드가 자고 있으면 다음 기회에 */ }
  }

  /* 구독관리 화면에 '취소됨'이 보이면 묻지 않고 해지로 처리한다. 이미 열려 있는 화면이라 공짜다.
     판정 규칙은 watch.js 한 곳에만 둔다. 여기에 정규식을 복사해 두면 언젠가 둘이 달라진다. */
  function looksCanceledHere(scan) {
    const W = self.SVSTWatch;
    return PAGE === "portal" && !!(W && W.looksCanceled(scan.pageText));
  }

  // ---------- 메인 루프 ----------
  const rescan = debounce(async () => {
    const scan = lockMerchant(scanPage());
    const dec = decide(scan);
    S.scan = scan; S.dec = dec;

    await checkSavings(scan);
    if (scan.success) await commitPayment(scan, dec);
    else if (PAGE === "checkout" && scan.total) await stashDraft(scan);
    else if ((PAGE === "invoice" || PAGE === "receipt") && scan.total) await captureReceipt(scan, dec);

    await reportObservation(scan, dec);
    updateBadge(scan, dec);

    const sig = [scan.vat, scan.success, scan.hasTaxField, scan.hasBizToggle, scan.hasTaxTrigger, scan.interval,
      scan.total && scan.total.val, dec.action, dec.supplier, dec.charge,
      !!S.consent, !!S.profile, S.profile && S.profile.pendingBrn,
      S.view, watchState(scan)].join("|");
    /* 화면을 보고 있는 중에 내용을 통째로 갈아치우면, 방금 읽던 글이 사라지고
       다른 이야기가 나타난다 — 이것도 "무작위로 뜬다"는 인상의 절반이다.
       그래서 사용자가 카드에 손을 댄 뒤(stickOpen)에는 다시 그리지 않고,
       다음에 열 때 새 내용으로 보여준다. */
    if (S.cardOpen && sig !== S.lastSig) {
      S.lastSig = sig;
      if (!S.stickOpen) render(); else S.stale = true;
    }
  }, 500);

  async function init() {
    const st = await chrome.storage.local.get(
      ["profile", "stats", "pending", "ledger", "subs", "suppliers", "consent", "flow"]);
    S.consent = st.consent && st.consent.v === CONSENT_VERSION ? st.consent : null;
    S.profile = st.profile || null;
    S.flow = st.flow || null;
    S.stats = st.stats || { saved: 0 };
    S.pending = st.pending || {};
    S.ledger = st.ledger || [];
    S.subs = st.subs || {};
    S.suppliers = st.suppliers || {};
    chrome.runtime.sendMessage({ type: "getRates" }, (res) => {
      if (res && res.rates) S.rates = res.rates;
      rescan();
    });
    rescan();
    new MutationObserver(rescan).observe(document.documentElement,
      { childList: true, subtree: true, characterData: true });

    /* 사용자가 결제창에 뭔가 입력하기 시작했다는 사실만 본다. 무엇을 입력했는지는 보지 않는다 —
       값은 읽지도, 저장하지도, 어디로 보내지도 않는다. 카드를 언제 열지 정하는 데만 쓴다. */
    document.addEventListener("input", (e) => {
      if (S.typed) return;
      const card = document.getElementById("svst-card");
      if (card && card.contains(e.target)) return;   // 우리 입력칸은 신호가 아니다
      S.typed = true;
      rescan();
    }, true);

    // 아무것도 입력하지 않아도 한참 머물렀다면, 그 자체로 들여다보고 있다는 뜻이다.
    setTimeout(() => { S.dwelt = true; rescan(); }, DWELL_MS);
  }

  init();
})();
