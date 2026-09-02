const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const W = require(path.join(root, "watch.js"));
const R = require(path.join(root, "rules.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.3.3");
assert.match(manifest.name, /돈나가요/);
for (const size of [16, 48, 128]) {
  assert.ok(fs.existsSync(path.join(root, `icon${size}.png`)), `icon${size}.png 누락`);
}
for (const file of ["onboarding.html", "onboarding.css", "onboarding.js"]) {
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

console.log("돈나가요 확장프로그램 핵심 테스트 통과");
