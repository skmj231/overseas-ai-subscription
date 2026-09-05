/* 해외AI구독관리 · rules.js — 순수 판정 로직
 *
 * DOM도 chrome API도 쓰지 않는다. 그래서 node에서 그대로 테스트할 수 있다(tests/run.js).
 *
 * 설계 원칙 하나만 기억하면 된다: 모든 판정은 3값이다. yes / no / unknown.
 * unknown은 실패가 아니라 정상 결과다. unknown은 CSV에 빈칸으로 나가고,
 * 사용자에게는 질문 하나를 만들고, 세무대리인에게는 '확인 필요'로 전달된다.
 * 추측으로 채운 값이 한 번 틀리면 그 세무사는 다시 이 도구를 추천하지 않는다.
 * 그래서 이 파일에는 "아마도"가 없다.
 */
(function (root) {
  "use strict";

  // ============================================================
  // 1. 열거형
  // ============================================================

  /* 구매자 과세유형. 이걸 안 나누면 면세사업자에게 정반대 안내를 하게 된다. */
  const TAX_TYPE = {
    GENERAL: "general",       // 일반과세자 — 해외 매입은 불공제
    SIMPLIFIED: "simplified", // 간이과세자 — 공제 구조가 다름
    EXEMPT: "exempt",         // 면세사업자 — 오히려 대리납부 의무(부가세법 §52) 검토 대상
    NONE: "none",             // 비사업자 — 부가세 내는 게 정상
    UNKNOWN: "unknown"        // 본인도 모름 — 찍게 하지 말고 비워서 세무대리인에게 넘긴다
  };

  const SUPPLIER = { OVERSEAS: "overseas", DOMESTIC: "domestic", UNKNOWN: "unknown" };

  const CHARGE = {
    INITIAL: "initial",     // 최초 결제
    RENEWAL: "renewal",     // 자동 갱신
    ONEOFF: "oneoff",       // 일회성 / 크레딧 충전
    PRORATION: "proration", // 플랜 변경 비례정산
    REFUND: "refund",       // 환불 / 크레딧 노트
    FAILED: "failed",       // 결제 실패 — 기록하지 않는다
    TRIAL: "trial"          // ₩0 무료 체험
  };

  const CONF = { HIGH: "high", MEDIUM: "medium", LOW: "low", NONE: "none" };

  // ============================================================
  // 2. 사업자등록번호 — 체크섬까지 검증
  // ============================================================

  /* 형식만 맞으면 통과시키면 오타가 그대로 결제창에 들어간다.
     국세청 검증 알고리즘(가중치 1,3,7,1,3,7,1,3,5)까지 돌린다. */
  function validBrn(v) {
    const d = String(v || "").replace(/\D/g, "");
    if (d.length !== 10) return false;
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i];
    sum += Math.floor((Number(d[8]) * 5) / 10);
    return (10 - (sum % 10)) % 10 === Number(d[9]);
  }

  function fmtBrn(v) {
    const d = String(v || "").replace(/\D/g, "").slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 5) return d.slice(0, 3) + "-" + d.slice(3);
    return d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5);
  }

  // ============================================================
  // 3-B. 결제 시스템 지문 — 판매자 사이트에서도 누가 결제를 받는지 알아낸다
  // ============================================================

  /* 판매자가 자기 사이트에서 결제를 받아도 카드 입력칸만은 거의 언제나
     결제사(PSP)가 내려주는 iframe이나 스크립트다. 그 출처를 보면
     처음 보는 사이트라도 "여기는 Stripe를 쓰는 곳"임을 알 수 있다.
     안을 들여다볼 필요는 없다 — 금액은 어차피 판매자 페이지에 적혀 있다. */
  const PSP_HOSTS = [
    [/(^|\.)stripe\.com$/i, "stripe"],
    [/(^|\.)paddle\.com$/i, "paddle"],
    [/(^|\.)lemonsqueezy\.com$/i, "lemonsqueezy"],
    [/(^|\.)onfastspring\.com$/i, "fastspring"],
    [/(^|\.)chargebee\.com$/i, "chargebee"],
    [/(^|\.)recurly\.com$/i, "recurly"],
    [/(^|\.)braintreegateway\.com$/i, "braintree"],
    [/(^|\.)paypal(objects)?\.com$/i, "paypal"],
    [/(^|\.)gumroad\.com$/i, "gumroad"],
    [/(^|\.)polar\.sh$/i, "polar"],
    [/(^|\.)creem\.io$/i, "creem"],
    [/(^|\.)2checkout\.com$/i, "2checkout"],
    [/(^|\.)adyen\.com$/i, "adyen"],
    [/(^|\.)checkout\.com$/i, "checkout"],
    [/(^|\.)tosspayments\.com$/i, "toss"],
    [/(^|\.)inicis\.com$/i, "inicis"],
    /* 국내 PG. 해외 AI 툴에서는 드물지만, 국내 재판매처를 거쳐 결제하는 경우가 있다. */
    [/(^|\.)kakaopay\.com$/i, "kakaopay"],
    [/^(online-pay|mpay)\.kakao\.com$/i, "kakaopay"],
    [/^pay\.naver\.com$/i, "naverpay"],
    [/(^|\.)nicepay\.co\.kr$/i, "nicepay"],
    [/(^|\.)(danalpay|teledit)\.com$/i, "danal"],
    /* 해외 PG 추가분 */
    [/(^|\.)klarna\.com$/i, "klarna"],
    [/(^|\.)(squareup\.com|square\.site|square\.link)$/i, "square"],
    [/(^|\.)mollie\.com$/i, "mollie"],
    [/(^|\.)razorpay\.com$/i, "razorpay"],
    [/(^|\.)xsolla\.com$/i, "xsolla"],
    /* Shopify Payments는 속을 열면 Stripe지만 도메인이 다르게 나온다. 따로 잡는다. */
    [/(^|\.)(myshopify\.com|shopify\.com)$/i, "shopify"],
    [/^shop\.app$/i, "shopify"],
    [/^(payments|apay)\.amazon\.com$/i, "amazonpay"],
    [/(^|\.)payments-amazon\.com$/i, "amazonpay"]
  ];

  function processorOf(hosts) {
    for (const h of (hosts || [])) {
      if (!h) continue;
      for (const [re, name] of PSP_HOSTS) if (re.test(h)) return name;
    }
    return null;
  }

  /* 여기가 결제 화면인가. 하나만 보고 정하지 않는다 —
     결제사 지문, 카드 입력칸, 총액을 뜻하는 단어. 둘 이상 맞으면 결제창으로 본다.
     하나뿐이면 조용히 있는다. 아닌 화면에서 튀어나오는 것이 못 뜨는 것보다 나쁘다. */
  function looksLikeCheckout(sig) {
    const hits = [!!sig.processor, !!sig.hasCardField, !!sig.hasTotalWord].filter(Boolean).length;
    return hits >= 2;
  }

  // ============================================================
  // 3. 금액 파싱 — USD/KRW만이 아니다
  // ============================================================

  const CUR_SYMBOL = [
    [/₩\s?([\d,]+(?:\.\d+)?)/, "KRW"],
    [/KRW\s?([\d,]+(?:\.\d+)?)/i, "KRW"],
    [/(?:US)?\$\s?([\d,]+(?:\.\d+)?)/, "USD"],
    [/USD\s?([\d,]+(?:\.\d+)?)/i, "USD"],
    [/€\s?([\d,]+(?:\.\d+)?)/, "EUR"],
    [/EUR\s?([\d,]+(?:\.\d+)?)/i, "EUR"],
    [/£\s?([\d,]+(?:\.\d+)?)/, "GBP"],
    [/GBP\s?([\d,]+(?:\.\d+)?)/i, "GBP"],
    [/(?:JP)?¥\s?([\d,]+(?:\.\d+)?)/, "JPY"],
    [/JPY\s?([\d,]+(?:\.\d+)?)/i, "JPY"],
    [/A\$\s?([\d,]+(?:\.\d+)?)/, "AUD"],
    [/C\$\s?([\d,]+(?:\.\d+)?)/, "CAD"],
    [/S\$\s?([\d,]+(?:\.\d+)?)/, "SGD"]
  ];

  /* 음수 표기: -$10.00, ($10.00), −10,000원 */
  function parseMoney(str) {
    if (!str) return null;
    const s = String(str);
    for (const [re, cur] of CUR_SYMBOL) {
      const m = s.match(re);
      if (m) {
        const val = parseFloat(m[1].replace(/,/g, ""));
        if (!isFinite(val)) continue;
        const before = s.slice(Math.max(0, m.index - 2), m.index);
        const neg = /[-−–]/.test(before) || /\(\s*$/.test(before);
        return { cur, val: neg ? -val : val };
      }
    }
    return null;
  }

  /* 소수 없는 통화 — 표시할 때 반올림 처리를 다르게 한다 */
  const ZERO_DECIMAL = new Set(["KRW", "JPY", "VND", "CLP"]);

  // ============================================================
  // 3-C. 총액과 부가세 — 단어가 먼저 찾고, 산수가 검증한다
  // ============================================================

  /* 숫자만 보고 총액을 고르면 사고가 난다. 날짜, 카드 끝 네 자리, 좌석 수,
     취소선 그은 할인 전 가격, 그리고 무엇보다 "연간 결제 시 $180" 같은 업셀 가격이
     전부 금액처럼 생겼다. 가장 큰 값을 총액으로 집으면 실제로 낸 돈의 몇 배가 기록된다.

     그래서 순서를 정한다.
       1) 단어가 후보를 찾는다 — Total, 합계, 지불 총액.
       2) 산수는 그 후보를 검증하고, 부가세 줄에 이름표가 없을 때만 값을 찾아 준다.
       3) 산수 혼자서는 절대 총액을 정하지 않는다.
     단어를 못 찾으면 금액은 '모름'으로 남긴다. 틀린 숫자를 자신 있게 보여주는 것이
     아무 숫자도 안 보여주는 것보다 훨씬 나쁘다. */

  const SUBTOTAL_RE = /(소\s*계|중간\s*합계|공급\s*가액|Sub\s*-?\s*total|Item\s*total)/i;
  const TOTAL_RE = /(당일\s*지불\s*총액|지불\s*총액|총\s*결제\s*금액|결제\s*금액|합\s*계|총\s*액|오늘\s*결제|Total\s*due(\s*today)?|Amount\s*due|Order\s*total|Grand\s*total|Total\s*to\s*pay|Total)/i;
  const VATLINE_RE = /(부가가치세|부가세|VAT|Sales\s*Tax|消費税|(?<![A-Za-z])Tax(?!\s*(ID|번호)))/i;
  const TAXID_RE = /(ID|번호|등록|number)/i;

  const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= Math.max(tol || 1, Math.abs(b) * 0.005);

  /* lines: 화면에 보이는 줄들(위에서 아래 순서). money(line)로 금액을 뽑는다.
     한 줄에 이름표만 있고 금액이 다음 줄에 있는 경우가 흔해서 다음 줄까지 본다. */
  function readAmounts(lines) {
    const L = (lines || []).map(x => String(x || "").trim()).filter(Boolean);
    const at = (i) => parseMoney(L[i]) || (L[i + 1] ? parseMoney(L[i + 1]) : null);

    let total = null, vat = null, subtotal = null;

    /* 총액은 아래쪽에 있다. 그리고 'Subtotal'에는 'Total'이 들어 있으니 먼저 걸러낸다. */
    for (let i = L.length - 1; i >= 0; i--) {
      if (SUBTOTAL_RE.test(L[i])) continue;
      if (!TOTAL_RE.test(L[i])) continue;
      const m = at(i);
      if (m && m.val > 0) { total = m; break; }
    }
    for (let i = 0; i < L.length; i++) {
      if (!VATLINE_RE.test(L[i]) || TAXID_RE.test(L[i])) continue;
      const m = at(i);
      if (m && m.val >= 0) { vat = m; break; }
    }
    for (let i = 0; i < L.length; i++) {
      if (!SUBTOTAL_RE.test(L[i])) continue;
      const m = at(i);
      if (m && m.val > 0) { subtotal = m; break; }
    }

    /* 검증. 부가세는 공급가의 10%이고, 총액의 1/11이기도 하다
       (부가세 포함 가격을 쓰는 곳이 있어서 두 쪽을 다 본다).
       어느 쪽으로도 안 맞으면 그 부가세는 우리가 잘못 읽은 것이다. 버린다. */
    let checked = false;
    if (total && vat && vat.val > 0 && total.cur === vat.cur) {
      checked = near(vat.val, (total.val - vat.val) / 10) || near(vat.val, total.val / 11);
      if (!checked) vat = null;
    }

    /* 부가세 줄에 이름표가 없는 결제창이 있다. 총액을 이미 단어로 확정했을 때만,
       그 안에서 10%에 해당하는 금액이 화면에 따로 적혀 있는지 찾아 준다.
       총액을 산수로 만들어 내지는 않는다. */
    if (total && !vat) {
      const pool = [];
      for (const ln of L) {
        const m = parseMoney(ln);
        if (m && m.cur === total.cur && m.val > 0 && m.val < total.val) pool.push(m.val);
      }
      const fits = [...new Set(pool)].filter(v =>
        near(v, (total.val - v) / 10) || near(v, total.val / 11));
      if (fits.length === 1) { vat = { cur: total.cur, val: fits[0] }; checked = true; }
    }

    return { total, vat, subtotal, verified: checked, sure: !!total };
  }

  // ============================================================
  // 4. 공급자 판별 — 여기가 제일 위험한 지점
  // ============================================================

  /* Stripe는 결제 수단일 뿐이다. 판매자가 한국 법인이면 그 거래는 국내 거래이고
     세금계산서 발급 대상이며 매입세액공제가 된다. "Stripe = 해외"로 단정하면
     공제 가능한 건을 '불공제'로 찍어 세무사에게 보내게 된다. 그래서 3분류다. */

  const KNOWN_OVERSEAS = [
    "openai", "chatgpt", "anthropic", "claude", "midjourney", "figma", "notion",
    "slack", "github", "vercel", "linear", "canva", "adobe", "cursor", "perplexity",
    "elevenlabs", "runway", "higgsfield", "replicate", "huggingface", "zapier",
    "airtable", "miro", "framer", "webflow", "descript", "loom", "calendly",
    "intercom", "mailchimp", "twilio", "cloudflare", "atlassian", "jetbrains",
    "sentry", "datadog", "supabase", "planetscale", "railway", "render", "netlify",
    "heroku", "digitalocean", "gamma", "tome", "suno", "udio", "pika", "luma",
    "ideogram", "leonardo", "civitai", "together", "groq", "fireworks", "deepl",
    "grammarly", "quillbot", "jasper", "writesonic", "surfer", "ahrefs", "semrush",
    "typeform", "dropbox", "evernote", "todoist", "raycast", "arc", "superhuman",
    "beehiiv", "substack", "ghost", "buttondown", "posthog", "amplitude", "mixpanel",
    "retool", "bubble", "softr", "make", "n8n", "clickup", "monday", "asana",
    "krea", "freepik", "flux", "recraft", "lovable", "bolt", "windsurf", "devin",
    "cody", "codeium", "tabnine", "warp", "fathom", "granola", "otter", "rev"
  ];

  /* 영수증/인보이스 페이지에서만 신뢰할 수 있는 국내 신호.
     결제창의 '사업자등록번호' 라벨은 우리가 입력할 칸이라 국내 신호가 아니다. */
  const DOMESTIC_TEXT = [
    /주식회사|㈜|\(주\)|유한회사|합자회사/,
    /통신판매업\s*(신고|번호)/,
    /대표\s*이사|사업자\s*등록\s*번호\s*[:：]/,
    /대한민국|Republic\s+of\s+Korea|South\s+Korea/i,
    /서울특별시|서울시|경기도|부산광역시|성남시|판교|강남구|마포구/
  ];

  /* 판매자 영역에 노출된 10자리 사업자번호 (내 번호가 아니어야 한다) */
  function findSellerBrn(pageText, myBrn) {
    const mine = String(myBrn || "").replace(/\D/g, "");
    const re = /\b(\d{3})-(\d{2})-(\d{5})\b/g;
    let m;
    while ((m = re.exec(pageText))) {
      const d = m[1] + m[2] + m[3];
      if (d !== mine && validBrn(d)) return fmtBrn(d);
    }
    return null;
  }

  /* pageKind: 'checkout' | 'receipt' | 'invoice' | 'portal' | 'other'
     반환: { value, confidence, why, question? } */
  function classifySupplier(input) {
    const merchant = String(input.merchant || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const text = String(input.pageText || "");
    const kind = input.pageKind || "other";

    // 사용자가 이미 답한 적 있으면 그게 최우선 — 사람이 확인한 사실을 덮어쓰지 않는다
    if (input.userAnswer === SUPPLIER.DOMESTIC || input.userAnswer === SUPPLIER.OVERSEAS) {
      return { value: input.userAnswer, confidence: CONF.HIGH, why: "사용자 확인" };
    }

    // 1) 알려진 해외 공급자 목록 — 가장 확실
    const hit = KNOWN_OVERSEAS.find(k => merchant.includes(k));
    if (hit) return { value: SUPPLIER.OVERSEAS, confidence: CONF.HIGH, why: `알려진 해외 공급자(${hit})` };

    // 2) 영수증/인보이스에 노출된 판매자 사업자등록번호 — 국내의 결정적 증거
    if (kind === "receipt" || kind === "invoice") {
      const brn = findSellerBrn(text, input.myBrn);
      if (brn) return { value: SUPPLIER.DOMESTIC, confidence: CONF.HIGH, why: `판매자 사업자번호 ${brn} 확인` };

      const sig = DOMESTIC_TEXT.filter(re => re.test(text));
      if (sig.length >= 2) {
        return { value: SUPPLIER.DOMESTIC, confidence: CONF.MEDIUM, why: "판매자 정보에 국내 사업자 표기" };
      }
      // 영수증에 국내 신호가 전혀 없고 해외 주소 형식이면 해외로 본다
      if (/\b(USA|United States|Delaware|California|London|Singapore|Ireland|Netherlands)\b/i.test(text)) {
        return { value: SUPPLIER.OVERSEAS, confidence: CONF.MEDIUM, why: "판매자 주소가 해외" };
      }
    }

    // 3) 그 외 — 모른다. 모른다고 말한다.
    return {
      value: SUPPLIER.UNKNOWN,
      confidence: CONF.NONE,
      why: "판매자 소재를 확인할 단서가 없음",
      question: "이 서비스에서 세금계산서를 받으실 수 있나요?"
    };
  }

  // ============================================================
  // 4-B. 결제 방식 — 주기(월/연) × 자동 여부
  // ============================================================

  /* 사용자마다 다르게 고른다. 월 1회 / 월 자동 / 연 1회 / 연 자동.
     이 구분이 중요한 이유는 알림이 완전히 달라지기 때문이다.
     자동이면 "가만있으면 빠져나간다"고 미리 알려야 하고,
     수동이면 "이번에도 결제하실 건가요"라고 물어야 한다. */
  const RE_AUTO = /(취소할\s*때까지|해지할\s*때까지|until\s+you\s+cancel|자동\s*(으로\s*)?(갱신|결제|연장)|automatically\s+renew|auto-?renew|recurring|계속\s*청구|반복\s*결제)/i;
  const RE_ONEOFF = /(1회\s*(성|결제|한정)|일회성|one[-\s]?time|단건\s*결제|자동\s*갱신\s*(안\s*됨|없음)|does\s+not\s+renew|no\s+auto)/i;

  /* 결제 주기는 '고른 플랜'에서만 읽는다.
     결제창에는 고르지 않은 대안이 같이 떠 있다. Suno는 월간을 고른 화면에도
     "연간 간격 청구가 포함된 ₩36,000 절약 · ₩144,000/년"이라는 연간 권유 줄을 띄운다.
     화면 전체를 훑으면 이 권유 줄에 걸려 월간 구독이 연간으로 찍힌다.
     그러면 "내년 갱신부터"라고 말하고, 갱신 알림도 1년 뒤로 잡힌다 —
     한 달 뒤 빠져나갈 돈을 놓치는 것이므로 이 도구의 존재 이유가 무너진다. */
  const RE_UPSELL = /(절약|아끼|save|discount|할인|switch|바꾸|대신|포함된|instead)/i;
  const RE_BILLED = /((연간|월간|매년|매월)\s*청구|billed\s*(annually|yearly|monthly))/i;
  /* 판매자가 "앞으로 어떻게 될지"를 직접 적어 둔 문장. 화면에서 제일 믿을 만한 근거다.
     플랜 고르는 줄에 붙은 '/month' 같은 표기보다 이 문장이 우선한다.
     Envato는 연 구독인데 화면 위쪽 플랜 선택칸에 "Monthly $59.00/month"가 같이 떠 있어서,
     그 줄에 걸리면 연 결제를 매달 결제로 읽는다. 실제로 그렇게 틀렸다. */
  const RE_RENEW_Y = /(매\s*년\s*(자동\s*)?(갱신|연장|청구)|renews?\s+(automatically\s+)?(each|every)\s+year|automatically\s+renews?\w*\s+each\s+year|renew\w*\s+(each|every)\s+year|renew\w*\s+annually|annual\s+subscription|yearly\s+subscription|연간\s*구독)/i;
  const RE_RENEW_M = /(매\s*(달|월)\s*(자동\s*)?(갱신|연장|청구)|renews?\s+(automatically\s+)?(each|every)\s+month|automatically\s+renews?\w*\s+each\s+month|renew\w*\s+(each|every)\s+month|renew\w*\s+monthly|monthly\s+subscription|월간\s*구독)/i;

  const RE_Y_STRONG = /(매\s*년|billed\s*(annually|yearly)|annually|yearly|per\s*year|per\s*annum|\/\s*(year|yr)\b|\ba\s+year\b|\beach\s+year\b|\bannual\b)/i;
  const RE_M_STRONG = /(매\s*월|billed\s*monthly|monthly|per\s*month|\/\s*(month|mo)\b|\ba\s+month\b|\beach\s+month\b)/i;
  const RE_Y_WEAK = /(연간|\/\s*년|년\s*청구)/;
  const RE_M_WEAK = /(월간|\/\s*월|월\s*청구)/;

  function detectInterval(lines) {
    const all = Array.isArray(lines)
      ? lines : String(lines || "").split("\n");
    const own = all.map(s => String(s).trim()).filter(Boolean).filter(l => !RE_UPSELL.test(l));

    // 1) 고른 항목에 붙은 청구 라벨이 가장 믿을 만하다 ("월간 청구" / "Billed annually")
    const billed = own.find(l => RE_BILLED.test(l));
    if (billed) return (/연간|매년|annually|yearly/i.test(billed)) ? "year" : "month";

    /* 1-B) 판매자가 직접 적어 둔 갱신 문장. "each year unless you cancel" 같은 줄이다.
       한쪽만 나오면 그게 답이다. 둘 다 나오면 근거가 못 되니 아래로 넘긴다. */
    const joined = own.join("\n");
    const ry = RE_RENEW_Y.test(joined), rm = RE_RENEW_M.test(joined);
    if (ry !== rm) return ry ? "year" : "month";

    // 2) 없으면 반복 표기 — 연간 우선(연간 플랜이 '월 환산' 금액을 함께 쓰기 때문)
    const rest = joined;
    if (RE_Y_STRONG.test(rest)) return "year";
    if (RE_M_STRONG.test(rest)) return "month";

    // 3) 마지막으로 약한 단서. 여기까지 왔으면 확신은 낮다.
    if (RE_Y_WEAK.test(rest)) return "year";
    if (RE_M_WEAK.test(rest)) return "month";
    return null;
  }

  function detectBilling(pageText, interval) {
    const t = String(pageText || "");
    if (!interval) return { interval: null, auto: false, source: "none" };
    if (RE_ONEOFF.test(t)) return { interval, auto: false, source: "declared" };
    if (RE_AUTO.test(t)) return { interval, auto: true, source: "declared" };
    // Stripe의 구독은 기본이 자동 갱신이다. 주기가 있으면 자동으로 본다.
    return { interval, auto: true, source: "assumed" };
  }

  const BILLING_LABEL = {
    "month:true": "월 자동결제", "month:false": "월 1회 결제",
    "year:true": "연 자동결제", "year:false": "연 1회 결제"
  };
  const billingLabel = (b) =>
    !b || !b.interval ? "일회성" : (BILLING_LABEL[`${b.interval}:${!!b.auto}`] || "");

  /* 원장에서 '수동 반복'을 찾아낸다.
     Stripe 구독이 아닌데 사용자가 매달 직접 결제하고 있는 경우 —
     선언된 적이 없으니 추론할 수밖에 없다. 2회 이상 규칙적이면 반복으로 본다. */
  function inferRepeat(records) {
    if (!records || records.length < 2) return null;
    const dates = records.map(r => r.date).sort();
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.round((new Date(dates[i]) - new Date(dates[i - 1])) / 86400e3));
    }
    const monthly = gaps.filter(g => g >= 26 && g <= 34).length;
    const yearly = gaps.filter(g => g >= 355 && g <= 375).length;
    if (monthly >= 1 && monthly >= yearly) {
      return { interval: "month", auto: false, source: "inferred", lastPaid: dates[dates.length - 1] };
    }
    if (yearly >= 1) {
      return { interval: "year", auto: false, source: "inferred", lastPaid: dates[dates.length - 1] };
    }
    return null;
  }

  /* 언제 알릴 것인가.
     해외 툴은 결제된 뒤에 환불받기가 대단히 어렵다. 그래서 알림은 '결제 후 기록'이 아니라
     '결제 전 판단'을 위한 것이어야 한다. 금액이 클수록 더 일찍 알린다. */
  function alertDaysBefore(billing) {
    if (!billing || !billing.interval) return [];
    if (!billing.auto) return [0];                 // 수동은 그날 "또 하실 건가요"
    return billing.interval === "year" ? [30, 7, 1] : [5, 1];   // watch.js LEAD_DEFAULT와 같은 값
  }

  // ============================================================
  // 5. 거래 성격
  // ============================================================

  const RE_REFUND = /(환불|반환|Refund|Refunded|Credit\s*note|크레딧\s*노트)/i;
  const RE_FAILED = /(결제\s*(실패|거절)|Payment\s*(failed|declined)|card\s*(was\s*)?declined|카드가\s*거절)/i;
  const RE_PRORATE = /(비례\s*(배분|정산)|Proration|Prorated|Unused\s*time|Remaining\s*time)/i;
  const RE_TRIAL = /(무료\s*체험|Free\s*trial|Trial\s*period|체험\s*기간|0원|₩0\b)/i;

  function classifyCharge(input) {
    const text = String(input.pageText || "");
    const amount = input.amount; // {cur, val} | null

    if (RE_FAILED.test(text)) return CHARGE.FAILED;
    if (RE_REFUND.test(text) || (amount && amount.val < 0)) return CHARGE.REFUND;
    if (RE_PRORATE.test(text)) return CHARGE.PRORATION;
    if (amount && amount.val === 0 && RE_TRIAL.test(text)) return CHARGE.TRIAL;
    if (input.knownSub) return CHARGE.RENEWAL;
    if (input.interval) return CHARGE.INITIAL;
    return CHARGE.ONEOFF;
  }

  // ============================================================
  // 6. 부가세 처리 판정 — (과세유형 × 공급자)
  // ============================================================

  /* 우리는 신고를 대신하지 않는다. '이 건이 어떤 성격인지'만 근거와 함께 적는다.
     확신이 없으면 판단 칸을 비우고 확인 요청만 남긴다. */
  function vatTreatment(taxType, supplier) {
    if (taxType === TAX_TYPE.NONE) {
      return {
        code: "personal",
        short: "개인 구매",
        csv: "",
        note: "사업용 지출이 아닙니다.",
        review: false
      };
    }
    if (taxType === TAX_TYPE.UNKNOWN) {
      return {
        code: "taxtype_unknown",
        short: "확인 필요",
        csv: "",
        note: "과세 유형이 확인되지 않아 판단을 비워 둡니다.",
        review: true
      };
    }
    if (supplier === SUPPLIER.UNKNOWN) {
      return {
        code: "unknown",
        short: "확인 필요",
        csv: "",                       // 비워서 내보낸다. 추측해서 채우지 않는다.
        note: "공급자가 국내인지 해외인지 확인되지 않아 판단을 비워 둡니다.",
        review: true
      };
    }
    if (supplier === SUPPLIER.DOMESTIC) {
      return {
        code: "domestic",
        short: "국내 거래",
        csv: "국내 거래 · 세금계산서 수취 시 공제 대상",
        note: "국내 사업자 거래입니다. 세금계산서를 요청하시면 매입세액공제를 받을 수 있습니다.",
        review: false
      };
    }
    // supplier === OVERSEAS
    if (taxType === TAX_TYPE.GENERAL) {
      return {
        code: "overseas_general",
        short: "불공제",
        csv: "매입세액공제 제외(불공제)",
        note: "세금계산서가 없는 해외 매입이라 매입세액공제 대상이 아닙니다. 경비로만 처리합니다.",
        review: false
      };
    }
    if (taxType === TAX_TYPE.SIMPLIFIED) {
      return {
        code: "overseas_simplified",
        short: "간이과세",
        csv: "간이과세자, 세무대리인 확인 필요",
        note: "간이과세자는 매입세액 공제 구조가 달라 세무대리인 확인이 필요합니다.",
        review: true
      };
    }
    // EXEMPT — 여기서 틀리면 제일 크게 틀린다
    return {
      code: "overseas_exempt",
      short: "대리납부 검토",
      csv: "면세사업자, 대리납부(부가가치세법 §52) 대상 여부 확인 필요",
      note: "면세사업자가 해외에서 용역을 사면 부가세를 대신 납부해야 하는 경우가 있습니다. 세무대리인께 확인하세요.",
      review: true
    };
  }

  // ============================================================
  // 7. 결제창에서 지금 무엇을 할 수 있나
  // ============================================================

  const ACTION = {
    FILL_NOW: "fill_now",         // 입력칸 있음 → 그 자리에서 면제
    REGISTER_LATER: "later",      // 입력칸 없음 → 결제 후 구독 관리에서
    ALREADY_EXEMPT: "exempt",     // 이미 부가세 0
    ASK_SUPPLIER: "ask_supplier", // 공급자를 먼저 물어야 함
    ADVISOR: "advisor",           // 면세사업자 — 아끼라고 말하면 안 되는 구간
    NOTHING: "nothing",           // 할 일 없음
    WAIT_ADDRESS: "wait_address"  // 주소 입력 전이라 부가세 미계산
  };

  /* 이 함수 하나가 카드 화면 전체를 결정한다.
     시나리오마다 if를 늘리는 대신, 상태를 계산해서 화면을 고른다. */
  function decideAction(ctx) {
    const { taxType, supplier, vat, hasTaxField, hasBizToggle, hasTaxTrigger, alreadyPending, pageKind } = ctx;

    if (taxType === TAX_TYPE.NONE) return ACTION.NOTHING;

    // 공급자를 모르면 면제 안내를 먼저 하지 않는다.
    // 국내 공급자에게 "부가세 빼세요"라고 하면 그건 틀린 안내다.
    if (supplier === SUPPLIER.UNKNOWN && vat > 0) return ACTION.ASK_SUPPLIER;

    if (supplier === SUPPLIER.DOMESTIC) return ACTION.NOTHING; // 국내는 세금계산서 안내로 간다

    /* 면세사업자에게 "부가세 빼세요"는 위험한 조언이다.
       번호를 넣으면 판매자는 부가세를 안 걷지만, 그 순간 대리납부 의무(§52)가 생길 수 있다.
       아끼는 게 아니라 내는 주체가 바뀌는 것이므로, 우리는 권하지 않고 넘긴다. */
    if (taxType === TAX_TYPE.EXEMPT && vat > 0) return ACTION.ADVISOR;

    if (vat === null || vat === undefined) return ACTION.WAIT_ADDRESS;
    if (vat === 0) return ACTION.ALREADY_EXEMPT;

    if (pageKind === "checkout" || pageKind === "portal") {
      // 접혀 있는 입력칸도 '있는 것'이다. 펼쳐서 넣으면 이 결제부터 빠진다.
      if (hasTaxField || hasBizToggle || hasTaxTrigger) return ACTION.FILL_NOW;
      return alreadyPending ? ACTION.NOTHING : ACTION.REGISTER_LATER;
    }
    return ACTION.NOTHING;
  }

  // ============================================================
  // 8. 환율 — 언제나 추정이다
  // ============================================================

  const CARD_FEE = 0.013; // 해외 이용 수수료 가정 (카드사·브랜드별 1.0~1.8%)

  /* USD 기준 rates 객체에서 임의 통화 → KRW.
     결제 시점에는 실제 청구액을 아무도 모른다(매입일 환율로 카드사가 재계산).
     그래서 basis를 반드시 함께 반환한다. */
  function fxToKrw(amount, cur, rates) {
    if (cur === "KRW") return { krw: Math.round(amount), basis: "actual", rate: 1, note: "원화 결제" };
    if (!rates || !rates.KRW) return { krw: null, basis: "unknown", rate: null, note: "환율을 가져오지 못했습니다" };
    const perUsd = cur === "USD" ? 1 : rates[cur];
    if (!perUsd) return { krw: null, basis: "unknown", rate: null, note: `${cur} 환율 없음` };
    const mid = rates.KRW / perUsd;            // 1 cur = ? KRW
    const eff = mid * (1 + CARD_FEE);
    return {
      krw: Math.round(amount * eff),
      basis: "estimated",
      rate: Math.round(mid * 100) / 100,
      note: `매매기준율 ${mid.toFixed(2)} + 해외수수료 1.3% 가정 · 카드 명세서와 다를 수 있음`
    };
  }

  // ============================================================
  // 9. 거래 한 건 = 하나의 결정 객체
  // ============================================================

  /* 모든 시나리오는 결국 이 하나를 채우는 문제로 환원된다.
     시나리오별 분기가 아니라, 필드별 확신도를 채우고 못 채운 건 unknowns에 남긴다. */
  function buildDecision(obs, profile, rates, opts) {
    opts = opts || {};
    const taxType = (profile && profile.taxType) || TAX_TYPE.NONE;

    const sup = classifySupplier({
      merchant: obs.merchant,
      pageText: obs.pageText,
      pageKind: obs.pageKind,
      myBrn: profile && profile.brn,
      userAnswer: opts.supplierAnswer
    });

    const charge = classifyCharge({
      pageText: obs.pageText,
      amount: obs.total,
      interval: obs.interval,
      knownSub: opts.knownSub
    });

    const fx = obs.total
      ? fxToKrw(obs.total.val, obs.total.cur, rates)
      : { krw: null, basis: "unknown", rate: null, note: "금액을 읽지 못했습니다" };

    const billing = detectBilling(obs.pageText, obs.interval);
    const vt = vatTreatment(taxType, sup.value);

    const action = decideAction({
      taxType,
      supplier: sup.value,
      vat: obs.vat,
      hasTaxField: obs.hasTaxField,
      hasBizToggle: obs.hasBizToggle,
      hasTaxTrigger: obs.hasTaxTrigger,
      alreadyPending: opts.alreadyPending,
      pageKind: obs.pageKind
    });

    const unknowns = [];
    if (sup.value === SUPPLIER.UNKNOWN) unknowns.push("supplier");
    if (fx.basis === "unknown") unknowns.push("amountKrw");
    else if (fx.basis === "estimated") unknowns.push("amountKrwExact");
    if (obs.vat === null || obs.vat === undefined) unknowns.push("vat");
    if (charge === CHARGE.RENEWAL && !opts.observed) unknowns.push("renewalConfirmed");

    return {
      supplier: sup.value,
      supplierWhy: sup.why,
      supplierQuestion: sup.question || null,
      charge,
      billing,
      taxType,
      vat: vt,
      fx,
      action,
      unknowns,
      recordable: charge !== CHARGE.FAILED && !!obs.total
    };
  }

  // ============================================================
  // 10. 중복 방지 — 결제창·영수증·예측이 같은 건을 세 번 넣지 않게
  // ============================================================

  function sameRecord(a, b) {
    if (a.mkey !== b.mkey) return false;
    const days = Math.abs(new Date(a.date) - new Date(b.date)) / 86400e3;
    if (days > 4) return false;
    // 외화 결제는 원화가 추정치라 흔들린다 → 외화 원금으로 비교하는 쪽이 정확
    if (a.currency && a.currency === b.currency && a.amountOrig && b.amountOrig) {
      return Math.abs(a.amountOrig - b.amountOrig) < 0.01;
    }
    const x = a.amountKrw || 0, y = b.amountKrw || 0;
    return Math.abs(x - y) <= Math.max(1000, y * 0.03);
  }

  // ============================================================
  // 11. 갱신 예정일 — 말일 구독 오버플로 방지
  // ============================================================

  function addInterval(dateStr, interval) {
    const [y, m, day] = String(dateStr).split("-").map(Number);
    let ny = y, nm = m;
    if (interval === "year") ny += 1;
    else { nm += 1; if (nm > 12) { nm = 1; ny += 1; } }
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  }

  // ============================================================
  // 12. CSV 한 줄 — unknown은 빈칸으로 나간다
  // ============================================================

  const CSV_HEADER = [
    "결제일", "서비스명(공급자)", "적요", "공급자 구분", "거래 성격",
    "결제통화", "외화금액", "원화금액", "원화금액 기준", "적용환율",
    "이 중 부가세액", "부가세 신고 처리", "계정과목 제안", "증빙",
    "결제 확인", "확인 필요", "비고"
  ];

  const SUPPLIER_LABEL = {
    overseas: "해외(세금계산서 없음)",
    domestic: "국내(세금계산서 대상)",
    unknown: ""   // 비운다
  };

  const CHARGE_LABEL = {
    initial: "최초 결제", renewal: "자동 갱신", oneoff: "일회성",
    proration: "플랜 변경 정산", refund: "환불", trial: "무료 체험", failed: "결제 실패"
  };

  function csvRow(r) {
    const foreign = r.currency && r.currency !== "KRW";
    const krwActual = !foreign || r.krwBasis === "actual";
    const needs = [];
    if (r.supplier === SUPPLIER.UNKNOWN) needs.push("공급자 국내/해외 확인");
    if (foreign && !krwActual) needs.push("카드 명세서 실제 청구액");
    if (r.status === "estimated") needs.push("결제 발생 여부");
    if (r.vatReview) needs.push("부가세 처리 확인");

    return [
      r.date,
      r.merchant || "",
      r.desc || "",
      SUPPLIER_LABEL[r.supplier] || "",
      CHARGE_LABEL[r.charge] || "",
      r.currency || "KRW",
      foreign ? (r.amountOrig ?? "") : "",
      r.amountKrw ?? "",
      r.amountKrw == null ? "" : (krwActual ? "실제 청구액" : "환산 추정"),
      foreign ? (r.fxRate ?? "") : "",
      r.vatKrw ?? "",
      r.vatCsv || "",
      r.account || "지급수수료",
      r.supplier === SUPPLIER.DOMESTIC ? "세금계산서(요청 필요)" : "해외 인보이스+카드전표",
      r.status === "confirmed" ? "확정" : "추정(카드전표 대조 필요)",
      needs.join(" · "),
      [
        r.interval ? billingLabel({ interval: r.interval, auto: r.auto !== false }) : "",
        r.note || ""
      ].filter(Boolean).join(" · ")
    ];
  }

  // ============================================================
  root.SVST = {
    TAX_TYPE, SUPPLIER, CHARGE, CONF, ACTION,
    ZERO_DECIMAL, CARD_FEE,
    KNOWN_OVERSEAS,
    validBrn, fmtBrn, parseMoney,
    PSP_HOSTS, processorOf, looksLikeCheckout, readAmounts,
    classifySupplier, classifyCharge, vatTreatment, decideAction,
    fxToKrw, buildDecision, sameRecord, addInterval,
    CSV_HEADER, SUPPLIER_LABEL, CHARGE_LABEL, csvRow,
    findSellerBrn,
    detectInterval, detectBilling, billingLabel, inferRepeat, alertDaysBefore, BILLING_LABEL
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SVST;
})(typeof self !== "undefined" ? self : globalThis);
