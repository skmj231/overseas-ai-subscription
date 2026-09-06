/* 통합 테스트: 실제 Postgres + 가짜 토스 + 가짜 메일.
 * DATABASE_URL_TEST가 없으면 건너뛴다. 로컬: postgresql://donna@localhost:5433/donna_test?host=/tmp */
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "../src/db.js";
import { makeCrypto } from "../src/crypto.js";
import { makeMailer } from "../src/mail.js";
import { makeService } from "../src/service.js";
import { makeApp } from "../src/app.js";
import { PLAN } from "../src/policy.js";

const URL_ = process.env.DATABASE_URL_TEST;
const skip = !URL_;

function fakeToss(nowFn) {
  const calls = [];
  let failNext = null; // { code, message } 또는 null
  return {
    calls,
    setFail(f) { failNext = f; },
    async issueBillingKey({ authKey, customerKey }) { calls.push(["issue", authKey, customerKey]); return { billingKey: "bk_" + authKey, card: { company: "신한", number: "433012******1234" } }; },
    async charge({ orderId, amount }) {
      calls.push(["charge", orderId, amount]);
      if (failNext) { const f = failNext; failNext = null; const e = new Error(f.message); e.code = f.code; e.body = f; throw e; }
      return { status: "DONE", paymentKey: "pay_" + orderId, approvedAt: nowFn().toISOString(), receipt: { url: "https://r/" + orderId } };
    },
    async getPayment(k) { return { paymentKey: k, status: "DONE" }; },
    async cancel({ paymentKey }) { calls.push(["cancel", paymentKey]); return { status: "CANCELED" }; }
  };
}

test("결제 → 라이선스 → 갱신 안내 → 실패·재시도 → 해지 → 환불", { skip: skip && "DATABASE_URL_TEST 없음" }, async (t) => {
  const db = makeDb(URL_);
  for (const tb of ["checkout_sessions", "payments", "audit", "installations", "subscriptions", "customers"]) await db.q(`DROP TABLE IF EXISTS ${tb} CASCADE`);
  await db.migrate();
  let NOW = new Date("2026-09-06T00:00:00Z");
  const sent = [];
  const mail = makeMailer({ MAIL_API_KEY: "", log: { info: (m) => sent.push(m), error: () => {} } });
  const toss = fakeToss(() => NOW);
  const env = { SITE_URL: "https://donna.co.kr", API_URL: "https://api.donna.co.kr", TOSS_CLIENT_KEY: "test_ck_x", EXTENSION_ID: "" };
  const crypto = makeCrypto({ BILLING_KEY_SECRET: "a".repeat(64), LICENSE_TOKEN_SECRET: "b".repeat(64) });
  const service = makeService({ db, toss, mail, crypto, env, log: { error: () => {}, info: () => {} }, now: () => NOW });
  const app = makeApp({ service, env, toss, db, log: { error: () => {}, info: () => {} } });
  const srv = app.listen(0); const port = srv.address().port;
  const api = (path, opt = {}) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", ...opt, headers: { "Content-Type": "application/json", Origin: "https://donna.co.kr", ...(opt.headers || {}) } });
  t.after(async () => { srv.close(); await db.end(); });

  const INSTALL = "abcdefghijklmnopqrstuvwxyz";
  // 0. 아직 아무것도 없음 → 무료
  let lic = await (await api(`/v1/license?install_id=${INSTALL}`)).json();
  assert.equal(lic.tier, "free"); assert.equal(lic.status, "none");

  // 1. 결제 세션
  let r = await api("/v1/checkout/session", { method: "POST", body: JSON.stringify({ email: "A@Example.com", install_id: INSTALL, return_url: "https://donna.co.kr/plus-done.html", cancel_url: "https://evil.com/x" }) });
  assert.equal(r.status, 200);
  const ses = await r.json();
  assert.equal(ses.customer_email, "a@example.com");
  assert.match(ses.success_url, /\/v1\/billing\/issue\?sid=/); assert.equal(ses.amount, 6000);
  assert.equal(r.headers.get("access-control-allow-origin"), "https://donna.co.kr");

  // 2. 토스에서 돌아옴 → 빌링키 발급 + 첫 승인 → plus-done으로
  const sid = new URL(ses.success_url).searchParams.get("sid");
  r = await api(`/v1/billing/issue?sid=${sid}&customerKey=${ses.customer_key}&authKey=auth1`);
  assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://donna.co.kr/plus-done.html");
  assert.deepEqual(toss.calls[0], ["issue", "auth1", ses.customer_key]);
  assert.equal(toss.calls[1][2], 6000);
  assert.ok(sent.some(m => m.includes("결제가 완료됐습니다")), "영수증 메일");
  // 같은 successUrl을 다시 열어도 두 번 결제하지 않는다
  r = await api(`/v1/billing/issue?sid=${sid}&customerKey=${ses.customer_key}&authKey=auth1`);
  assert.equal(r.status, 302); assert.equal(toss.calls.filter(c => c[0] === "charge").length, 1);

  // 3. 라이선스
  lic = await (await api(`/v1/license?install_id=${INSTALL}`)).json();
  assert.equal(lic.tier, "plus"); assert.equal(lic.status, "active");
  assert.equal(lic.current_period_end, "2026-12-06T00:00:00.000Z");
  assert.match(lic.manage_url, /plus-manage\.html\?token=/); assert.equal(lic.email, "a*@example.com");
  const sub = await db.one("SELECT * FROM subscriptions");
  assert.equal(sub.status, "active"); assert.equal(sub.period_no, 1); assert.equal(sub.card_summary, "신한 **** 1234");
  assert.notEqual(sub.billing_key_encrypted, "bk_auth1");

  // 3b. 이미 Plus인 사람이 또 결제 시도 → 관리 페이지로
  r = await api("/v1/checkout/session", { method: "POST", body: JSON.stringify({ email: "a@example.com" }) });
  assert.equal((await r.json()).already, true);

  // 3c. 기기 3대 제한
  for (const id of ["b".repeat(26), "c".repeat(26), "d".repeat(26)]) await service.linkInstall(sub.customer_id, id);
  lic = await (await api(`/v1/license?install_id=${INSTALL}`)).json();
  assert.equal(lic.tier, "free", "가장 오래 안 본 설치(첫 설치)는 떨어져 나간다");
  lic = await (await api(`/v1/license?install_id=${"d".repeat(26)}`)).json();
  assert.equal(lic.tier, "plus");
  await service.linkInstall(sub.customer_id, INSTALL); // 다시 연결

  // 4. 스케줄러: 7일 전 안내, 3일 전 안내 (각 한 번)
  NOW = new Date("2026-11-29T12:00:00Z"); let tk = await service.tick(); assert.equal(tk.reminded, 1);
  tk = await service.tick(); assert.equal(tk.reminded, 0, "같은 단계는 다시 안 보냄");
  NOW = new Date("2026-12-03T12:00:00Z"); tk = await service.tick(); assert.equal(tk.reminded, 1);
  assert.equal(sent.filter(m => m.includes("일 뒤 Donna Plus")).length, 2);

  // 5. 만료일: 갱신 승인 실패 → past_due, 3일 뒤 재시도 예약
  toss.setFail({ code: "REJECT_CARD_PAYMENT", message: "한도 초과" });
  NOW = new Date("2026-12-06T00:30:00Z"); tk = await service.tick(); assert.equal(tk.charged, 1);
  let s = await db.one("SELECT * FROM subscriptions");
  assert.equal(s.status, "past_due"); assert.equal(s.fail_count, 1);
  assert.equal(new Date(s.next_retry_at).toISOString(), "2026-12-09T00:30:00.000Z");
  assert.ok(sent.some(m => m.includes("결제가 실패했습니다")));
  lic = await (await api(`/v1/license?install_id=${INSTALL}`)).json();
  assert.equal(lic.status, "past_due", "확장은 이걸 보고 추가 등록만 막는다");
  // 재시도 전에는 시도하지 않는다
  NOW = new Date("2026-12-08T00:00:00Z"); tk = await service.tick(); assert.equal(tk.charged, 0);
  // 3일 뒤 재시도 성공 → 기간은 12/6부터 이어 붙어 3/6까지
  NOW = new Date("2026-12-09T01:00:00Z"); tk = await service.tick(); assert.equal(tk.charged, 1);
  s = await db.one("SELECT * FROM subscriptions");
  assert.equal(s.status, "active"); assert.equal(s.period_no, 2); assert.equal(s.fail_count, 0);
  assert.equal(new Date(s.current_period_end).toISOString(), "2027-03-06T00:00:00.000Z");
  const pays = await db.q("SELECT order_id, status FROM payments ORDER BY created_at");
  assert.deepEqual(pays.rows.map(p => p.status), ["done", "done"], "실패 행이 성공으로 갱신된다(같은 orderId)");

  // 6. 관리 페이지: 조회 → 해지 → 라이선스는 기간 끝까지 plus → 만료 → free
  const token = new URL(lic.manage_url).searchParams.get("token");
  let mv = await (await api(`/v1/subscription?token=${token}`)).json();
  assert.equal(mv.email, "a@example.com"); assert.equal(mv.status, "active"); assert.equal(mv.payments.length, 2); assert.equal(mv.refundable, false);
  r = await api("/v1/subscription/cancel", { method: "POST", body: JSON.stringify({ token }) }); assert.equal((await r.json()).ok, true);
  assert.ok(sent.some(m => m.includes("해지가 접수")));
  lic = await (await api(`/v1/license?install_id=${INSTALL}`)).json();
  assert.equal(lic.status, "canceled"); assert.equal(lic.tier, "plus"); assert.equal(lic.cancel_at_period_end, true);
  NOW = new Date("2027-03-01T00:00:00Z"); tk = await service.tick(); assert.equal(tk.charged, 0, "해지 예약이면 갱신하지 않는다");
  r = await api("/v1/subscription/resume", { method: "POST", body: JSON.stringify({ token }) }); assert.equal((await r.json()).ok, true);
  s = await db.one("SELECT * FROM subscriptions"); assert.equal(s.status, "active");
  await api("/v1/subscription/cancel", { method: "POST", body: JSON.stringify({ token }) });
  NOW = new Date("2027-03-07T00:00:00Z"); tk = await service.tick(); assert.equal(tk.expired, 1);
  lic = await (await api(`/v1/license?install_id=${INSTALL}`)).json();
  assert.equal(lic.tier, "free"); assert.equal(lic.status, "none", "만료된 구독은 없는 것과 같다");

  // 7. 새 고객: 첫 결제 뒤 7일 이내 환불
  NOW = new Date("2027-04-01T00:00:00Z");
  r = await api("/v1/checkout/session", { method: "POST", body: JSON.stringify({ email: "b@example.com", install_id: "e".repeat(26) }) });
  const s2 = await r.json(); const sid2 = new URL(s2.success_url).searchParams.get("sid");
  await api(`/v1/billing/issue?sid=${sid2}&customerKey=${s2.customer_key}&authKey=auth2`);
  lic = await (await api(`/v1/license?install_id=${"e".repeat(26)}`)).json(); assert.equal(lic.tier, "plus");
  const tok2 = new URL(lic.manage_url).searchParams.get("token");
  mv = await (await api(`/v1/subscription?token=${tok2}`)).json(); assert.equal(mv.refundable, true);
  NOW = new Date("2027-04-05T00:00:00Z");
  r = await api("/v1/subscription/refund", { method: "POST", body: JSON.stringify({ token: tok2 }) }); assert.equal((await r.json()).ok, true);
  assert.ok(toss.calls.some(c => c[0] === "cancel"));
  lic = await (await api(`/v1/license?install_id=${"e".repeat(26)}`)).json(); assert.equal(lic.tier, "free");
  NOW = new Date("2027-04-20T00:00:00Z");
  r = await api("/v1/subscription/refund", { method: "POST", body: JSON.stringify({ token: tok2 }) }); assert.equal(r.status, 409);

  // 8. 첫 결제 실패 → incomplete, plus.html로 error와 함께
  toss.setFail({ code: "INVALID_CARD_NUMBER", message: "카드번호 오류" });
  r = await api("/v1/checkout/session", { method: "POST", body: JSON.stringify({ email: "c@example.com" }) });
  const s3 = await r.json(); const sid3 = new URL(s3.success_url).searchParams.get("sid");
  r = await api(`/v1/billing/issue?sid=${sid3}&customerKey=${s3.customer_key}&authKey=auth3`);
  assert.equal(r.status, 302); assert.match(r.headers.get("location"), /plus\.html\?error=payment/);

  // 9. 입력 검증·CORS·잘못된 토큰
  r = await api("/v1/checkout/session", { method: "POST", body: JSON.stringify({ email: "nope" }) }); assert.equal(r.status, 400);
  r = await api("/v1/subscription?token=bad"); assert.equal(r.status, 401);
  r = await api("/v1/license?install_id=x", { headers: { Origin: "https://evil.com" } }); assert.equal(r.headers.get("access-control-allow-origin"), null);
  r = await api("/v1/license?install_id=x", { headers: { Origin: "chrome-extension://abc" } }); assert.equal(r.headers.get("access-control-allow-origin"), "chrome-extension://abc");
  r = await api("/healthz"); assert.equal((await r.json()).ok, true);
  assert.equal(PLAN.amount, 6000);
});
