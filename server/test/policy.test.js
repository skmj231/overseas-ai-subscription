import test from "node:test";
import assert from "node:assert/strict";
import { PLAN, addMonths, nextPeriod, orderId, reminderDue, chargeDue, afterFailure, afterSuccess, licenseView, refundable } from "../src/policy.js";
import { makeCrypto } from "../src/crypto.js";

const D = (s) => new Date(s);
const DAY = 86400000;

test("3개월 뒤 같은 날, 말일 보정", () => {
  assert.equal(addMonths(D("2026-09-06T00:00:00Z"), 3).toISOString(), "2026-12-06T00:00:00.000Z");
  assert.equal(addMonths(D("2026-11-30T00:00:00Z"), 3).toISOString(), "2027-02-28T00:00:00.000Z");
  assert.equal(addMonths(D("2026-01-31T00:00:00Z"), 3).toISOString(), "2026-04-30T00:00:00.000Z");
  assert.equal(nextPeriod("2026-09-06T00:00:00Z").end.toISOString(), "2026-12-06T00:00:00.000Z");
});

test("orderId는 토스 규칙(영숫자·_·-, 6~64자)", () => {
  const id = orderId("6b1f0f2e-0c2b-4e2a-9c1d-8f3a2b1c0d9e", 3);
  assert.match(id, /^[A-Za-z0-9_-]{6,64}$/);
  assert.equal(id, "sub_6b1f0f2e0c2b4e2a9c1d8f3a2b1c0d9e_3");
});

test("갱신 안내: 7일 전, 3일 전 각각 한 번", () => {
  const sub = { status: "active", cancel_at_period_end: false, current_period_end: "2026-12-06T00:00:00Z", period_no: 1 };
  assert.equal(reminderDue(sub, D("2026-11-20T00:00:00Z"), []), null, "16일 전엔 아직");
  const r7 = reminderDue(sub, D("2026-11-29T12:00:00Z"), []);
  assert.equal(r7.days, 7); assert.equal(r7.key, "once:remind7:1");
  assert.equal(reminderDue(sub, D("2026-11-30T00:00:00Z"), ["once:remind7:1"]), null, "7일 전 보냈으면 3일 전까지 조용");
  const r3 = reminderDue(sub, D("2026-12-03T12:00:00Z"), ["once:remind7:1"]);
  assert.equal(r3.days, 3);
  assert.equal(reminderDue({ ...sub, cancel_at_period_end: true }, D("2026-12-03T12:00:00Z"), []), null, "해지 예약이면 안 보냄");
  assert.equal(reminderDue(sub, D("2026-12-06T01:00:00Z"), []), null, "지난 뒤엔 안 보냄");
});

test("승인 시점: 만료일 도래, 재시도 시각 도래", () => {
  const sub = { status: "active", cancel_at_period_end: false, current_period_end: "2026-12-06T00:00:00Z" };
  assert.equal(chargeDue(sub, D("2026-12-05T23:00:00Z")), false);
  assert.equal(chargeDue(sub, D("2026-12-06T00:00:00Z")), true);
  assert.equal(chargeDue({ ...sub, cancel_at_period_end: true }, D("2026-12-07T00:00:00Z")), false);
  const pd = { status: "past_due", cancel_at_period_end: false, next_retry_at: "2026-12-09T00:00:00Z" };
  assert.equal(chargeDue(pd, D("2026-12-08T00:00:00Z")), false);
  assert.equal(chargeDue(pd, D("2026-12-09T00:00:00Z")), true);
  assert.equal(chargeDue({ ...pd, next_retry_at: null }, D("2026-12-20T00:00:00Z")), false, "재시도 소진이면 멈춤");
});

test("실패 정책: 3일 뒤, 7일 뒤(첫 실패 기준), 그 다음 소진", () => {
  const t0 = D("2026-12-06T00:00:00Z");
  const f1 = afterFailure({ fail_count: 0, first_failed_at: null }, t0);
  assert.equal(f1.status, "past_due"); assert.equal(f1.fail_count, 1);
  assert.equal(f1.next_retry_at.toISOString(), "2026-12-09T00:00:00.000Z"); assert.equal(f1.exhausted, false);
  const f2 = afterFailure({ fail_count: 1, first_failed_at: t0 }, D("2026-12-09T01:00:00Z"));
  assert.equal(f2.next_retry_at.toISOString(), "2026-12-13T00:00:00.000Z");
  const f3 = afterFailure({ fail_count: 2, first_failed_at: t0 }, D("2026-12-13T01:00:00Z"));
  assert.equal(f3.next_retry_at, null); assert.equal(f3.exhausted, true);
  assert.equal(PLAN.retryDays[1], 7, "7일이면 확장 유예(7일) 안에서 끝난다");
});

test("성공 시 기간은 원래 만료일부터 이어 붙인다", () => {
  const s = afterSuccess({ current_period_end: "2026-12-06T00:00:00Z", period_no: 1 }, D("2026-12-08T10:00:00Z"));
  assert.equal(s.current_period_start.toISOString(), "2026-12-06T00:00:00.000Z");
  assert.equal(s.current_period_end.toISOString(), "2027-03-06T00:00:00.000Z");
  assert.equal(s.period_no, 2); assert.equal(s.fail_count, 0);
  const first = afterSuccess({ period_no: 0 }, D("2026-09-06T00:00:00Z"));
  assert.equal(first.current_period_end.toISOString(), "2026-12-06T00:00:00.000Z");
  // 아주 오래된 만료일(30일 넘게 지남)은 이어 붙이지 않고 오늘부터
  const late = afterSuccess({ current_period_end: "2026-06-01T00:00:00Z", period_no: 1 }, D("2026-09-06T00:00:00Z"));
  assert.equal(late.current_period_start.toISOString(), "2026-09-06T00:00:00.000Z");
});

test("라이선스 응답은 확장 plan.js와 같은 뜻", () => {
  assert.deepEqual(licenseView(null, D("2026-09-06T00:00:00Z")), { tier: "free", status: "none", current_period_end: null, cancel_at_period_end: false });
  const a = licenseView({ status: "active", current_period_end: "2026-12-06T00:00:00Z", cancel_at_period_end: false }, D("2026-09-06T00:00:00Z"));
  assert.equal(a.tier, "plus"); assert.equal(a.status, "active");
  const c = licenseView({ status: "canceled", current_period_end: "2026-12-06T00:00:00Z", cancel_at_period_end: true }, D("2026-12-07T00:00:00Z"));
  assert.equal(c.status, "expired"); assert.equal(c.tier, "free");
  const p = licenseView({ status: "past_due", current_period_end: "2026-12-06T00:00:00Z", cancel_at_period_end: false }, D("2026-12-08T00:00:00Z"));
  assert.equal(p.tier, "plus"); assert.equal(p.status, "past_due");
});

test("환불 가능: 결제 후 7일 이내", () => {
  const pay = { status: "done", approved_at: "2026-09-06T00:00:00Z" };
  assert.equal(refundable(pay, D("2026-09-13T00:00:00Z")), true);
  assert.equal(refundable(pay, D("2026-09-13T00:00:01Z")), false);
  assert.equal(refundable({ ...pay, status: "canceled" }, D("2026-09-07T00:00:00Z")), false);
});

test("빌링키 암호화·토큰 서명", () => {
  const c = makeCrypto({ BILLING_KEY_SECRET: "a".repeat(64), LICENSE_TOKEN_SECRET: "b".repeat(64) });
  const blob = c.encrypt("bill_key_123");
  assert.notEqual(blob, "bill_key_123"); assert.equal(c.decrypt(blob), "bill_key_123");
  assert.notEqual(c.encrypt("x"), c.encrypt("x"), "iv가 매번 달라야 한다");
  const t = c.sign({ sub: "s1", scope: "manage" }, 1000);
  assert.equal(c.verify(t).sub, "s1");
  assert.equal(c.verify(t + "x"), null, "변조");
  const c2 = makeCrypto({ BILLING_KEY_SECRET: "a".repeat(64), LICENSE_TOKEN_SECRET: "c".repeat(64) });
  assert.equal(c2.verify(t), null, "다른 키");
  assert.equal(c.verify(c.sign({ sub: "s1" }, -1)), null, "만료");
  assert.throws(() => makeCrypto({ BILLING_KEY_SECRET: "short", LICENSE_TOKEN_SECRET: "b".repeat(64) }));
});
