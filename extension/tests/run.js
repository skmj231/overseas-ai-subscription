const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const W = require(path.join(root, "watch.js"));
const R = require(path.join(root, "rules.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.5.2");
/* 사이드패널: 아이콘을 누르면 팝업이 아니라 패널이 열려야 한다. 팝업이 남아 있으면 그쪽이 먼저 잡힌다. */
assert.ok(manifest.permissions.includes("sidePanel"), "sidePanel 권한 누락");
assert.equal(manifest.side_panel && manifest.side_panel.default_path, "popup.html");
assert.ok(!manifest.action.default_popup, "default_popup이 남아 있으면 사이드패널 대신 팝업이 뜬다");
const P = require(path.join(root, "presets.js"));
assert.match(manifest.name, /Donna/);
for (const size of [16, 48, 128]) {
  assert.ok(fs.existsSync(path.join(root, `icon${size}.png`)), `icon${size}.png 누락`);
}
for (const file of ["onboarding.html", "onboarding.css", "onboarding.js", "presets.js"]) {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} 누락`);
}

assert.equal(W.addInterval("2026-01-31", "month"), "2026-02-28");
assert.equal(W.addInterval("2024-02-29", "year"), "2025-02-28");
assert.equal(W.dueFrom("2026-01-31", "month", "2026-04-01"), "2026-04-28");

const yearly = W.makeWatch({
  name: "Higgsfield", amountOrig: 682813, currency: "KRW",
  interval: "year", nextDue: "2026-09-05", auto: true
}, "2026-09-01");
assert.equal(yearly.due, "2026-09-05");

const incomplete = W.makeWatch({ name: "Claude", interval: null, nextDue: null }, "2026-09-01");
assert.equal(incomplete.interval, null);
assert.equal(incomplete.due, null);
assert.equal(incomplete.status, W.STATUS.NEEDS_INFO);
assert.equal(W.planTick({ c: incomplete }, "2026-09-01", {}, W.LEAD_DEFAULT).notifications.length, 0,
  "날짜를 모르는 구독에 잘못된 알림을 보내면 안 됨");

const firstComplete = W.makeWatch({
  name: "Cursor", interval: "month", nextDue: "2026-09-06", auto: true
}, "2026-09-01");
assert.equal(firstComplete.status, W.STATUS.ACTIVE);
const firstPlan = W.planTick({ cursor: firstComplete }, "2026-09-01", {}, W.LEAD_DEFAULT);
assert.equal(firstPlan.notifications.length, 1, "주기와 날짜를 입력하면 알림이 예약되어야 함");
assert.equal(firstPlan.notifications[0].left, 5);
assert.equal(firstPlan.notifications[0].kind, "pre");

let planned = W.planTick({ h: yearly }, "2026-09-01", {}, W.LEAD_DEFAULT);
assert.equal(planned.notifications.length, 1);
assert.equal(planned.notifications[0].left, 4);
assert.equal(planned.notifications[0].kind, "pre");

const noticeKey = planned.notifications[0].nkey;
planned = W.planTick({ h: yearly }, "2026-09-01", { [noticeKey]: true }, W.LEAD_DEFAULT);
assert.equal(planned.notifications.length, 0, "같은 알림이 중복 발송되면 안 됨");

const kept = W.applyAction(yearly, "keep", "2026-09-01");
assert.equal(kept.ackedFor, "2026-09-05");
planned = W.planTick({ h: kept }, "2026-09-06", {}, W.LEAD_DEFAULT);
assert.equal(planned.updates.h.due, "2027-09-05");

const canceled = W.applyAction(yearly, "canceled", "2026-09-01");
planned = W.planTick({ h: canceled }, "2026-09-01", {}, W.LEAD_DEFAULT);
assert.equal(planned.notifications.length, 0, "해지한 구독은 알리면 안 됨");

const page = W.parsePage(
  "Next billing\nSeptember 21, 2026\nUSD 20 per month\nAuto-renew",
  "ChatGPT Plus",
  "https://chatgpt.com/account",
  R
);
assert.equal(page.nextDue, "2026-09-21");
assert.equal(page.interval, "month");
assert.equal(page.auto, true);

// ---------- 1.4: 원화 예상 · 무료 체험 · 채널 · 프리셋 ----------
const rates = { KRW: 1400, EUR: 0.9 };
assert.equal(W.estimateKrw(20, "USD", rates, { vat: true }), Math.round(20 * 1400 * 1.013 * 1.1));
assert.equal(W.estimateKrw(20, "USD", rates, { vat: false }), Math.round(20 * 1400 * 1.013));
assert.equal(W.estimateKrw(10, "EUR", rates, {}), Math.round(10 * (1400 / 0.9) * 1.013));
assert.equal(W.estimateKrw(5000, "KRW", null, { vat: true }), 5000, "원화는 그대로");
assert.equal(W.estimateKrw(20, "USD", null, {}), null, "환율을 모르면 지어내지 않는다");

const trial = W.makeWatch({ name: "Perplexity", kind: "trial", interval: "year", nextDue: "2026-09-10",
  amountOrig: 200, currency: "USD", channel: "appstore" }, "2026-09-01");
assert.equal(trial.kind, "trial");
assert.equal(trial.due, "2026-09-10", "체험 종료일은 그대로 첫 결제일");
assert.deepEqual(W.alertDaysBefore(trial, W.LEAD_DEFAULT), [2, 0]);
let tp = W.planTick({ t: trial }, "2026-09-08", {}, W.LEAD_DEFAULT);
assert.equal(tp.notifications.length, 1);
const tm = W.messageFor("pre", trial, 2, {});
assert.match(tm.title, /무료 체험이 끝나요/);
assert.match(tm.message, /매년 USD 200/);
assert.equal(W.cancelUrl(trial), W.CHANNEL_URL.appstore, "앱스토어 결제는 스토어 구독 화면으로");
const paidTrial = W.applyAction(trial, "paid", "2026-09-11");
assert.equal(paidTrial.kind, "sub", "체험이 끝나고 결제되면 보통 구독");
assert.equal(paidTrial.due, "2027-09-10");

assert.deepEqual(W.alertDaysBefore({ interval: "year", auto: true }, W.LEAD_DEFAULT), [30, 7, 1]);
assert.deepEqual(W.alertDaysBefore({ interval: "month", auto: true }, { year: [14, 3], month: [5, 1] }), [5, 1],
  "예전 설정(trial 없음)도 그대로 읽힌다");

const tot = W.monthlyTotal({
  a: W.makeWatch({ name: "A", interval: "month", nextDue: "2026-10-01", amountKrw: 30000 }, "2026-09-01"),
  b: W.makeWatch({ name: "B", interval: "year", nextDue: "2026-10-01", amountKrw: 120000 }, "2026-09-01"),
  c: W.makeWatch({ name: "C", interval: "month", nextDue: "2026-10-01" }, "2026-09-01"),
  d: W.applyAction(W.makeWatch({ name: "D", interval: "month", nextDue: "2026-10-01", amountKrw: 99999 }, "2026-09-01"), "canceled", "2026-09-01")
});
assert.deepEqual(tot, { monthly: 40000, count: 3, unknown: 1 });
const up = W.upcoming({ a: W.makeWatch({ name: "A", interval: "month", nextDue: "2026-09-05", amountKrw: 1 }, "2026-09-01") }, "2026-09-01", 30);
assert.equal(up.length, 1); assert.equal(up[0].left, 4);

assert.equal(P.find("chatgpt").name, "ChatGPT Plus");
assert.equal(P.find("클로드").id, "claude");
assert.equal(P.find("Cursor Pro").id, "cursor");
assert.equal(P.find("없는서비스"), null);
assert.ok(P.search("", 10).length === 10 && P.search("", 10)[0].id === "chatgpt");
for (const p of P.LIST) {
  assert.ok(p.amount > 0 && ["month", "year"].includes(p.interval) && /^https:\/\//.test(p.manageUrl), p.id + " 프리셋 값 이상");
  assert.match(p.color, /^#[0-9A-Fa-f]{6}$/, p.id + " 색 누락");
  if (p.logo) assert.ok(fs.existsSync(path.join(root, "logos", p.logo)), p.id + " 로고 파일 없음: " + p.logo);
}
assert.match(P.avatarHtml(P.find("claude")), /mask-image:url\(logos\/anthropic\.svg\)/);
assert.match(P.avatarHtml(P.find("cursor")), />C</);

// ── Donna Plus · 무료 한도 ──
const PLAN = (() => { const g = {}; new Function("self", fs.readFileSync(path.join(root, "plan.js"), "utf8"))(g); return g.SVSTPlan; })();
const mk = (n, status) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["w" + i, { name: "S" + i, status: status || "active" }]));
assert.equal(PLAN.FREE_LIMIT, 3);
assert.equal(PLAN.activeCount({ ...mk(3), x: { status: "canceled" } }), 3, "해지 확인된 것은 세지 않는다");
assert.ok(PLAN.canAdd(mk(2), null, null).ok && PLAN.canAdd(mk(2), null, null).left === 1);
assert.deepEqual(PLAN.canAdd(mk(3), null, null), { ok: false, reason: "limit", count: 3, limit: 3 });
assert.ok(PLAN.canAdd(mk(3), null, "w0").ok, "기존 항목 수정은 한도와 무관");
assert.ok(PLAN.canAdd(mk(3), { tier: "free", status: "none" }, null).ok === false);
const NOW = Date.parse("2026-09-06T00:00:00Z");
const plus = { tier: "plus", status: "active", current_period_end: "2026-12-06T00:00:00Z", checkedAt: NOW };
assert.ok(PLAN.isPlus(plus, NOW) && PLAN.canAdd(mk(9), plus, null, NOW).ok);
assert.ok(PLAN.isPlus({ ...plus, status: "canceled" }, NOW), "해지해도 결제한 기간까지는 Plus");
assert.ok(!PLAN.isPlus({ ...plus, status: "canceled" }, Date.parse("2026-12-07T00:00:00Z")));
assert.ok(PLAN.isPlus({ ...plus }, Date.parse("2026-12-10T00:00:00Z")), "만료 뒤 7일 유예");
assert.ok(!PLAN.isPlus({ ...plus }, Date.parse("2026-12-14T00:00:00Z")), "유예 지나면 무료");
assert.ok(!PLAN.isPlus({ ...plus, status: "past_due" }, NOW));
assert.ok(PLAN.needsRecheck(null) && PLAN.needsRecheck({ checkedAt: NOW - 25 * 3600000 }, NOW) && !PLAN.needsRecheck({ checkedAt: NOW - 3600000 }, NOW));
const fromSrv = PLAN.fromServer({ tier: "plus", status: "active", current_period_end: "2026-12-06T00:00:00Z" }, null, NOW);
assert.equal(fromSrv.tier, "plus"); assert.equal(fromSrv.checkedAt, NOW);
assert.deepEqual(PLAN.fromServer(null, plus, NOW), plus, "응답 없으면 이전 상태 유지");
assert.equal(PLAN.fromServer(null, plus, Date.parse("2027-01-01T00:00:00Z")).tier, "free", "유예 지나면 내린다");
assert.equal(PLAN.fromServer({ tier: "free", status: "none" }, plus, NOW).tier, "free", "서버가 무료라면 무료");
assert.match(PLAN.newInstallId(), /^[a-z0-9]{26}$/);
assert.notEqual(PLAN.newInstallId(), PLAN.newInstallId());
assert.match(PLAN.plusUrl("abc", "gate"), /^https:\/\/donna\.co\.kr\/plus\.html\?install=abc&utm_source=extension/);
assert.match(PLAN.licenseUrl("abc"), /\/v1\/license\?install_id=abc$/);
assert.equal(PLAN.statusText(null, mk(2)), "무료 · 구독 2 / 3");
assert.match(PLAN.statusText(plus, mk(5), NOW), /^Plus · 12월 6일까지 · 다음 결제 ₩6,000$/);
assert.match(PLAN.statusText({ ...plus, status: "canceled" }, mk(5), NOW), /이용 후 종료$/);
assert.ok(fs.existsSync(path.join(root, "fonts", "PretendardVariable.woff2")), "글꼴 파일 누락");
assert.ok(manifest.web_accessible_resources[0].resources.includes("fonts/PretendardVariable.woff2"));

assert.ok(manifest.host_permissions.includes("https://api.donna.co.kr/*"), "라이선스 서버 접근 권한 누락 — 확장이 CORS로 막힌다");

/* 내려받기: 앵커를 문서에 붙이지 않거나 click 직후 곧바로 URL을 해제하면
   사이드패널에서 다운로드가 시작되기 전에 블롭이 사라져 아무 일도 일어나지 않는다.
   캘린더(.ics)·분기 CSV·백업 JSON이 전부 이 경로를 쓴다. */
for (const f of ["popup.js", "onboarding.js"]) {
  const src = fs.readFileSync(path.join(root, f), "utf8");
  assert.match(src, /function saveFile\(/, f + ": 공용 저장 함수 없음");
  assert.match(src, /document\.body\.appendChild\(a\)/, f + ": 앵커를 문서에 붙이지 않으면 다운로드가 안 된다");
  assert.ok(!/click\(\);\s*URL\.revokeObjectURL/.test(src), f + ": click 직후 즉시 해제하면 다운로드가 취소된다");
  assert.ok(!/URL\.createObjectURL/.test(src.replace(/function saveFile\([\s\S]*?\n\}/, "")), f + ": 저장은 saveFile()만 거쳐야 한다");
}

console.log("Donna 확장프로그램 핵심 테스트 통과");
