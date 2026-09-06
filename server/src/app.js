/* HTTP 라우트. 업무 로직은 service.js에, 여기는 입력 검증·CORS·응답 형식만. */
import express from "express";

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;

export function makeApp({ service, env, toss, db, log = console }) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  /* CORS: 사이트와 확장만. 확장 ID를 모르는 개발 중에는 chrome-extension:// 전체를 허용한다. */
  const allowed = new Set([env.SITE_URL || "https://donna.co.kr", "https://donna.co.kr", "https://www.donna.co.kr"]);
  if (env.EXTENSION_ID) allowed.add(`chrome-extension://${env.EXTENSION_ID}`);
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && (allowed.has(o) || (!env.EXTENSION_ID && o.startsWith("chrome-extension://")) || (env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)/.test(o)))) {
      res.setHeader("Access-Control-Allow-Origin", o);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Donna-Version");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  /* 아주 단순한 rate limit(프로세스 메모리). Railway 단일 인스턴스면 충분하다. */
  const hits = new Map();
  function limit(key, max, windowMs) {
    const now = Date.now();
    const h = hits.get(key) || [];
    const fresh = h.filter(t => now - t < windowMs);
    fresh.push(now); hits.set(key, fresh);
    if (hits.size > 5000) hits.clear();
    return fresh.length <= max;
  }
  const ip = (req) => req.ip || req.socket.remoteAddress || "?";

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get("/", (req, res) => res.json({ ok: true, service: "donna-plus-api" }));
  app.get("/healthz", wrap(async (req, res) => { await db.q("SELECT 1"); res.json({ ok: true }); }));

  /* ── 결제 시작 ── */
  app.post("/v1/checkout/session", wrap(async (req, res) => {
    if (!limit("checkout:" + ip(req), 10, 3600000)) return res.status(429).json({ error: "잠시 후 다시 시도해 주세요." });
    const { email, install_id, return_url, cancel_url } = req.body || {};
    if (!email || !EMAIL.test(String(email))) return res.status(400).json({ error: "이메일 주소를 확인해 주세요." });
    const site = env.SITE_URL || "https://donna.co.kr";
    const safe = (u, fb) => (typeof u === "string" && u.startsWith(site)) ? u : fb;
    const out = await service.createCheckout({
      email: String(email).trim().toLowerCase(), install_id: typeof install_id === "string" ? install_id : null,
      return_url: safe(return_url, `${site}/plus-done.html`), cancel_url: safe(cancel_url, `${site}/plus.html`)
    });
    res.json(out);
  }));

  /* ── 토스 결제창 → 돌아오는 곳 ── */
  app.get("/v1/billing/issue", wrap(async (req, res) => {
    const { sid, customerKey, authKey } = req.query;
    if (!sid || !customerKey || !authKey) return res.status(400).send("잘못된 요청입니다.");
    try {
      const r = await service.completeBilling({ sid: String(sid), customerKey: String(customerKey), authKey: String(authKey) });
      res.redirect(302, r.redirect);
    } catch (e) {
      log.error("billing/issue", e.message);
      const u = new URL(`${env.SITE_URL || "https://donna.co.kr"}/plus.html`);
      u.searchParams.set("error", "billing"); u.searchParams.set("reason", e.message || "");
      res.redirect(302, u.toString());
    }
  }));
  /* 토스는 사용자가 창을 닫은 것(USER_CANCEL)과 카드가 거절된 것을 같은 failUrl로 보낸다.
     코드를 그대로 넘기지 않으면 "결제창을 닫으셨어요"만 보여 원인을 못 찾는다. */
  app.get("/v1/billing/fail", (req, res) => {
    const code = String(req.query.code || "");
    const u = new URL(`${env.SITE_URL || "https://donna.co.kr"}/plus.html`);
    u.searchParams.set("error", /USER_CANCEL|PAY_PROCESS_CANCELED/i.test(code) ? "canceled" : "card");
    if (code) u.searchParams.set("code", code.slice(0, 60));
    if (req.query.message) u.searchParams.set("reason", String(req.query.message).slice(0, 160));
    log.error("billing/fail", code, String(req.query.message || ""));
    res.redirect(302, u.toString());
  });

  /* ── 확장 프로그램 ── */
  app.get("/v1/license", wrap(async (req, res) => {
    if (!limit("license:" + ip(req), 120, 3600000)) return res.status(429).json({ error: "too many" });
    res.json(await service.license(String(req.query.install_id || "")));
  }));

  /* ── 관리 페이지 ── */
  const token = (req) => String((req.body && req.body.token) || req.query.token || "");
  app.get("/v1/subscription", wrap(async (req, res) => res.json(await service.manageView(token(req)))));
  app.post("/v1/subscription/cancel", wrap(async (req, res) => res.json(await service.cancel(token(req)))));
  app.post("/v1/subscription/resume", wrap(async (req, res) => res.json(await service.resume(token(req)))));
  app.post("/v1/subscription/refund", wrap(async (req, res) => res.json(await service.refund(token(req)))));
  app.post("/v1/subscription/change-card", wrap(async (req, res) => res.json(await service.changeCard(token(req), req.body && req.body.return_url))));
  app.post("/v1/installations/link", wrap(async (req, res) => res.json(await service.linkByToken(token(req), String((req.body && req.body.install_id) || "")))));

  /* ── 토스 웹훅: 서명이 없으므로 결제를 다시 조회해 확인한 뒤 payments 상태만 맞춘다. 상태 변경의 근원은 우리 호출 결과다. ── */
  app.post("/v1/webhooks/toss", wrap(async (req, res) => {
    const ev = req.body || {};
    const key = ev.data && ev.data.paymentKey;
    if (ev.eventType === "PAYMENT_STATUS_CHANGED" && key) {
      try {
        const p = await toss.getPayment(key);
        if (p.status === "CANCELED" || p.status === "PARTIAL_CANCELED") await db.q("UPDATE payments SET status='canceled', raw=$2 WHERE payment_key=$1", [key, p]);
        await db.q("INSERT INTO audit(subject, action, meta) VALUES($1,$2,$3)", [`payment:${key}`, "webhook", { status: p.status }]);
      } catch (e) { log.error("webhook", e.message); }
    }
    res.json({ ok: true });
  }));

  app.use((req, res) => res.status(404).json({ error: "not found" }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === "entity.parse.failed" ? 400 : 500);
    if (status >= 500) log.error(err);
    res.status(status).json({ error: status >= 500 ? "서버 오류입니다. 잠시 후 다시 시도해 주세요." : err.message });
  });
  return app;
}
