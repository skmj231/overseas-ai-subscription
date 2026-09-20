import test from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "../src/app.js";

test("웹 결제는 설치 연결 없이 시작되고 복원 요청은 계정 존재 여부를 숨긴다", async (t) => {
  const calls = [];
  const service = {
    async createCheckout(v) { calls.push(["checkout", v]); return { ok: true }; },
    async requestRestore(email, installId) { calls.push(["restore", email, installId]); return { ok: true }; },
    async license() { return { tier: "free", status: "none" }; },
    async manageView() { throw Object.assign(new Error("unused"), { status: 400 }); },
    async cancel() {}, async resume() {}, async refund() {}, async changeCard() {}, async linkByToken() {}, async unlinkInstall() {}
  };
  const db = { async q() { return { rows: [] }; } };
  const toss = { async getPayment() { return { status: "DONE" }; } };
  const env = { SITE_URL: "https://donna.co.kr", EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop" };
  const app = makeApp({ service, env, toss, db, log: { error() {}, info() {} } });
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://donna.co.kr" },
    body: JSON.stringify(body)
  });

  let r = await post("/v1/checkout/session", {
    email: "paid@example.com", consent_version: "2026-09-19", recurring_accepted: true, terms_accepted: true
  });
  assert.equal(r.status, 200);
  assert.equal(calls[0][0], "checkout");
  assert.equal(calls[0][1].install_id, null, "웹 결제는 나중에 이메일 복원으로 설치를 연결한다");

  const install = "a".repeat(26);
  r = await post("/v1/checkout/session", { email: "paid@example.com", install_id: install });
  assert.equal(r.status, 400, "서버는 동의 값이 없는 결제를 거절한다");
  r = await post("/v1/checkout/session", { email: "paid@example.com", install_id: install, consent_version: "2026-09-19", recurring_accepted: true, terms_accepted: true });
  assert.equal(r.status, 200);
  assert.equal(calls[1][0], "checkout");
  assert.equal(calls[1][1].install_id, install);
  assert.equal(calls[1][1].recurring_accepted, true);

  r = await post("/v1/checkout/session", { email: "paid@example.com", install_id: "bad", consent_version: "2026-09-19", recurring_accepted: true, terms_accepted: true });
  assert.equal(r.status, 400, "잘못된 설치 ID는 웹 결제로 가장해 통과하지 못한다");

  r = await post("/v1/restore/request", { email: "paid@example.com", install_id: "bad" });
  assert.equal(r.status, 400);

  r = await post("/v1/restore/request", { email: "unknown@example.com", install_id: install });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(calls.at(-1), ["restore", "unknown@example.com", install]);
});
