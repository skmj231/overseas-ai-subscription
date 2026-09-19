/* Donna Plus license helpers. No DOM or Chrome APIs: safe to unit-test. */
(function (root) {
  "use strict";
  const FREE_LIMIT = 3;
  const PRICE_KRW = 6000;
  const PERIOD_MONTHS = 3;
  const GRACE_DAYS = 7;
  const RECHECK_HOURS = 24;
  const API_BASE = "https://api.donna.co.kr/v1";
  const SITE = "https://donna.co.kr";

  function activeCount(watch) {
    return Object.values(watch || {}).filter(w => w && w.status !== "canceled").length;
  }
  function isPlus(plan, now) {
    if (!plan || plan.tier !== "plus") return false;
    const t = now || Date.now();
    const end = plan.current_period_end ? Date.parse(plan.current_period_end) : 0;
    if (plan.status === "active" && (!end || end + GRACE_DAYS * 86400000 > t)) return true;
    return plan.status === "canceled" && end > t;
  }
  function canAdd(watch, plan, key, now) {
    if (key && watch && watch[key]) return { ok: true };
    if (isPlus(plan, now)) return { ok: true };
    const count = activeCount(watch);
    return count < FREE_LIMIT ? { ok: true, left: FREE_LIMIT - count }
      : { ok: false, reason: "limit", count, limit: FREE_LIMIT };
  }
  function needsRecheck(plan, now) {
    const t = now || Date.now();
    return !plan || !plan.checkedAt || t - plan.checkedAt > RECHECK_HOURS * 3600000;
  }
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
    return p;
  }
  function newInstallId(rand) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = rand ? rand(26) : crypto.getRandomValues(new Uint8Array(26));
    return Array.from(bytes, b => chars[b % chars.length]).join("");
  }
  function plusUrl(installId, campaign) {
    const u = new URL(SITE + "/plus.html");
    if (installId) u.searchParams.set("install", installId);
    u.searchParams.set("utm_source", "extension");
    u.searchParams.set("utm_medium", "sidepanel");
    u.searchParams.set("utm_campaign", campaign || "plus");
    return u.toString();
  }
  const licenseUrl = installId => API_BASE + "/license?install_id=" + encodeURIComponent(installId || "");
  const linkUrl = () => API_BASE + "/installations/link";
  function statusText(plan, watch, now) {
    if (isPlus(plan, now)) {
      const end = plan.current_period_end ? new Date(plan.current_period_end) : null;
      const until = end ? `${end.getMonth() + 1}월 ${end.getDate()}일까지` : "";
      if (plan.status === "canceled" || plan.cancel_at_period_end) return `Plus · ${until} 이용 후 종료`.trim();
      return `Plus · ${until} · 다음 결제 ₩${PRICE_KRW.toLocaleString("ko-KR")}`.replace(" ·  ·", " ·");
    }
    const count = activeCount(watch);
    if (plan && plan.status === "past_due") return `결제 실패 · 무료 ${Math.min(count, FREE_LIMIT)} / ${FREE_LIMIT}`;
    return `무료 · 구독 ${Math.min(count, FREE_LIMIT)} / ${FREE_LIMIT}`;
  }
  root.SVSTPlan = { FREE_LIMIT, PRICE_KRW, PERIOD_MONTHS, GRACE_DAYS, RECHECK_HOURS,
    API_BASE, SITE, activeCount, isPlus, canAdd, needsRecheck, fromServer,
    newInstallId, plusUrl, licenseUrl, linkUrl, statusText };
})(typeof self !== "undefined" ? self : globalThis);
