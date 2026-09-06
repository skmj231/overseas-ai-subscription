/* Donna · plan.js — 무료 한도와 Donna Plus 라이선스
 *
 * 규칙
 *   · 활성 구독 3개까지 무료. 네 번째부터 Plus(3개월 6,000원).
 *   · 이미 등록된 구독을 고치는 것은 언제나 된다. 새로 만드는 것만 센다.
 *   · Plus가 끝나거나 결제가 실패해도 데이터는 지우지 않는다. 추가 등록만 막는다.
 *   · 라이선스는 서버(api.donna.co.kr)가 판단한다. 확장은 install_id 하나만 보낸다.
 *     서버가 응답하지 않으면 마지막으로 확인한 상태를 7일까지 믿는다(유예).
 *
 * DOM도 chrome API도 쓰지 않는다 → node 테스트에서 그대로 읽는다.
 * 저장소를 만지는 함수는 background.js·popup.js가 각자 가진다.
 */
(function (root) {
  "use strict";

  const FREE_LIMIT = 3;
  const PRICE_KRW = 6000;
  const PERIOD_MONTHS = 3;
  const GRACE_DAYS = 7;            // 서버가 안 잡힐 때 마지막 상태를 믿어 주는 기간
  const RECHECK_HOURS = 24;        // 라이선스를 다시 묻는 주기
  const API_BASE = "https://api.donna.co.kr/v1";
  const SITE = "https://donna.co.kr";

  /* 무료 한도에 세는 구독: 해지 확인된 것만 뺀다.
     알림을 잠깐 끈 것(paused)이나 날짜를 아직 모르는 것(needs-info)도 '내 구독'이다. */
  function activeCount(watch) {
    return Object.values(watch || {}).filter(w => w && w.status !== "canceled").length;
  }

  /* plan = { tier:'free'|'plus', status:'active'|'canceled'|'past_due'|'expired'|'none',
              current_period_end: ISO|null, checkedAt: ms|null, email?: string, manageUrl?: string } */
  function isPlus(plan, now) {
    if (!plan || plan.tier !== "plus") return false;
    const t = now || Date.now();
    const end = plan.current_period_end ? Date.parse(plan.current_period_end) : 0;
    if (plan.status === "active" && (!end || end + GRACE_DAYS * 86400000 > t)) return true;
    // 해지했더라도 결제한 기간이 끝날 때까지는 Plus
    if (plan.status === "canceled" && end > t) return true;
    return false;
  }

  /* 새 구독을 넣어도 되나. key가 이미 있으면 '수정'이라 언제나 된다. */
  function canAdd(watch, plan, key, now) {
    if (key && watch && watch[key]) return { ok: true };
    if (isPlus(plan, now)) return { ok: true };
    const n = activeCount(watch);
    if (n < FREE_LIMIT) return { ok: true, left: FREE_LIMIT - n };
    return { ok: false, reason: "limit", count: n, limit: FREE_LIMIT };
  }

  /* 라이선스를 다시 물어볼 때인가 */
  function needsRecheck(plan, now) {
    const t = now || Date.now();
    if (!plan || !plan.checkedAt) return true;
    return t - plan.checkedAt > RECHECK_HOURS * 3600000;
  }

  /* 서버 응답 → 저장할 plan. 응답이 없으면(null) 이전 상태를 유지하되,
     유예 기간이 지났으면 무료로 내린다. */
  function fromServer(res, prev, now) {
    const t = now || Date.now();
    if (res && typeof res === "object" && res.tier) {
      return {
        tier: res.tier === "plus" ? "plus" : "free",
        status: String(res.status || (res.tier === "plus" ? "active" : "none")),
        current_period_end: res.current_period_end || null,
        cancel_at_period_end: !!res.cancel_at_period_end,
        email: res.email || (prev && prev.email) || null,
        manageUrl: res.manage_url || (prev && prev.manageUrl) || null,
        checkedAt: t
      };
    }
    const p = prev || { tier: "free", status: "none", current_period_end: null, checkedAt: null };
    if (p.tier === "plus") {
      const end = p.current_period_end ? Date.parse(p.current_period_end) : (p.checkedAt || t);
      if (end + GRACE_DAYS * 86400000 < t) return { ...p, tier: "free", status: "expired" };
    }
    return p; // 못 물어봤다. checkedAt은 그대로 두어 다음에 또 시도한다
  }

  /* 설치 식별자. 추측하기 어렵게 26자, 이름·기기와 무관하다. */
  function newInstallId(rand) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    const bytes = rand ? rand(26) : Array.from({ length: 26 }, () => Math.floor(Math.random() * 256));
    for (let i = 0; i < 26; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  function plusUrl(installId, campaign) {
    const u = new URL(SITE + "/plus.html");
    if (installId) u.searchParams.set("install", installId);
    u.searchParams.set("utm_source", "extension");
    u.searchParams.set("utm_medium", "sidepanel");
    u.searchParams.set("utm_campaign", campaign || "plus");
    return u.toString();
  }

  function licenseUrl(installId) {
    return API_BASE + "/license?install_id=" + encodeURIComponent(installId || "");
  }

  /* 설정 화면 한 줄 */
  function statusText(plan, watch, now) {
    if (isPlus(plan, now)) {
      const end = plan.current_period_end ? new Date(plan.current_period_end) : null;
      const until = end ? `${end.getMonth() + 1}월 ${end.getDate()}일까지` : "";
      if (plan.status === "canceled" || plan.cancel_at_period_end) return `Plus · ${until} 이용 후 종료`.trim();
      return `Plus · ${until} · 다음 결제 ₩${PRICE_KRW.toLocaleString("ko-KR")}`.replace(" ·  ·", " ·");
    }
    const n = activeCount(watch);
    if (plan && plan.status === "past_due") return `결제 실패 · 무료 ${Math.min(n, FREE_LIMIT)} / ${FREE_LIMIT}`;
    return `무료 · 구독 ${Math.min(n, FREE_LIMIT)} / ${FREE_LIMIT}`;
  }

  root.SVSTPlan = { FREE_LIMIT, PRICE_KRW, PERIOD_MONTHS, GRACE_DAYS, RECHECK_HOURS, API_BASE, SITE,
                    activeCount, isPlus, canAdd, needsRecheck, fromServer, newInstallId, plusUrl, licenseUrl, statusText };
})(typeof self !== "undefined" ? self : globalThis);
