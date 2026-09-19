/* 업무 로직. 라우트와 스케줄러가 이 함수들만 부른다. */
import { PLAN, nextPeriod, orderId, afterFailure, afterSuccess, licenseView, refundable, reminderDue, chargeDue } from "./policy.js";
import { HARD_FAIL, cardSummary } from "./toss.js";

export function makeService({ db, toss, mail, crypto, env, log = console, now = () => new Date() }) {
  const SITE = env.SITE_URL || "https://donna.co.kr";
  const API = env.API_URL || "https://api.donna.co.kr";

  const manageUrl = (subId) => `${SITE}/plus-manage.html?token=${crypto.sign({ sub: subId, scope: "manage" }, 30 * 86400000)}`;

  async function findCustomerByEmail(email) { return db.one("SELECT * FROM customers WHERE email=$1", [email]); }
  async function upsertCustomer(email) {
    return db.one("INSERT INTO customers(email) VALUES($1) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *", [email]);
  }
  async function currentSub(customerId) {
    return db.one(`SELECT * FROM subscriptions WHERE customer_id=$1 AND status IN ('active','canceled','past_due','pending','incomplete')
                   ORDER BY created_at DESC LIMIT 1`, [customerId]);
  }
  async function liveSub(customerId) {
    return db.one(`SELECT * FROM subscriptions WHERE customer_id=$1 AND status IN ('active','canceled','past_due')
                   ORDER BY created_at DESC LIMIT 1`, [customerId]);
  }

  /* 설치를 고객에 연결. 한도 초과 시 기존 기기를 몰래 해제하지 않는다.
     유료 권한이 갑자기 사라지는 것보다 사용자가 관리 화면에서 직접 정리하는 편이 안전하다. */
  async function linkInstall(customerId, installId) {
    if (!installId || !/^[a-z0-9]{20,40}$/.test(installId)) return null;
    return db.tx(async c => {
      await c.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [customerId]);
      const existingQ = await c.query("SELECT * FROM installations WHERE public_install_id=$1 FOR UPDATE", [installId]);
      const existing = existingQ.rows[0];
      if (existing && existing.customer_id === customerId) {
        await c.query("UPDATE installations SET last_seen_at=now() WHERE id=$1", [existing.id]);
        return existing;
      }
      if (existing && existing.customer_id && existing.customer_id !== customerId) {
        throw Object.assign(new Error("이 Chrome은 다른 구매에 연결되어 있습니다. 구매 이메일로 복원을 다시 요청해 주세요."), { status: 409, code: "INSTALL_OWNED" });
      }
      const countQ = await c.query("SELECT count(*)::int AS n FROM installations WHERE customer_id=$1", [customerId]);
      if (countQ.rows[0].n >= PLAN.maxInstalls) {
        throw Object.assign(new Error(`연결 가능한 Chrome ${PLAN.maxInstalls}대를 모두 사용 중입니다. 기존 기기를 해제한 뒤 다시 시도해 주세요.`), { status: 409, code: "DEVICE_LIMIT" });
      }
      const made = existing
        ? await c.query("UPDATE installations SET customer_id=$2, last_seen_at=now() WHERE id=$1 RETURNING *", [existing.id, customerId])
        : await c.query("INSERT INTO installations(customer_id, public_install_id, last_seen_at) VALUES($1,$2,now()) RETURNING *", [customerId, installId]);
      return made.rows[0];
    });
  }

  /* 1. 결제 세션: plus.html이 부른다. 토스 결제창을 열 데 필요한 값을 돌려준다. */
  async function createCheckout({ email, install_id, return_url, cancel_url, purpose = "new", subscription_id = null,
                                  consent_version = null, recurring_accepted = false, terms_accepted = false }) {
    const cust = await upsertCustomer(email);
    if (install_id) {
      const owned = await db.one("SELECT customer_id FROM installations WHERE public_install_id=$1", [install_id]);
      if (owned && owned.customer_id && owned.customer_id !== cust.id) {
        throw Object.assign(new Error("이 Chrome은 다른 구매 이메일의 Plus에 연결되어 있습니다. 기존 이용권 관리에서 기기를 해제하거나 구매 복원을 이용해 주세요."), { status: 409, code: "INSTALL_OWNED" });
      }
    }
    let sub = subscription_id ? await db.one("SELECT * FROM subscriptions WHERE id=$1 AND customer_id=$2", [subscription_id, cust.id]) : await currentSub(cust.id);
    if (purpose === "new") {
      if (sub && ["active", "canceled", "past_due"].includes(sub.status)) {
        // 이메일만 아는 사람이 남의 Plus를 가져가지 못하게 결제/연결을 진행하지 않는다.
        // 기존 구매자에게만 인증 링크를 보내 현재 설치를 연결한다.
        if (install_id) await requestRestore(email, install_id);
        return { already: true, restore_required: true, restore_sent: !!install_id };
      }
      if (!sub || sub.status !== "pending") {
        sub = await db.one("INSERT INTO subscriptions(customer_id, plan, status, toss_customer_key) VALUES($1,$2,'pending',$3) RETURNING *",
                           [cust.id, PLAN.id, "cust_" + cust.id.replace(/-/g, "")]);
      }
    } else if (!sub) throw Object.assign(new Error("구독이 없습니다."), { status: 404 });
    const ses = await db.one(`INSERT INTO checkout_sessions(customer_id, subscription_id, install_id, purpose, return_url, cancel_url,
                                                               consent_version, recurring_accepted, terms_accepted, consented_at)
                              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8 AND $9 THEN now() ELSE NULL END) RETURNING *`,
                             [cust.id, sub.id, install_id || null, purpose, return_url || null, cancel_url || null,
                              consent_version, recurring_accepted, terms_accepted]);
    return {
      session_id: ses.id,
      client_key: env.TOSS_CLIENT_KEY,
      customer_key: sub.toss_customer_key,
      customer_email: cust.email,
      success_url: `${API}/v1/billing/issue?sid=${ses.id}`,
      fail_url: `${API}/v1/billing/fail?sid=${ses.id}`,
      amount: PLAN.amount, order_name: PLAN.name
    };
  }

  /* 2. 토스 successUrl: authKey → 빌링키 → (새 구독이면) 첫 승인 */
  async function completeBilling({ sid, customerKey, authKey }) {
    const ses = await db.one("SELECT * FROM checkout_sessions WHERE id=$1", [sid]);
    if (!ses) throw Object.assign(new Error("세션이 없습니다."), { status: 404 });
    const sub = await db.one("SELECT * FROM subscriptions WHERE id=$1", [ses.subscription_id]);
    const cust = await db.one("SELECT * FROM customers WHERE id=$1", [ses.customer_id]);
    if (!sub || sub.toss_customer_key !== customerKey) throw Object.assign(new Error("customerKey 불일치"), { status: 400 });
    if (now().getTime() - new Date(ses.created_at).getTime() > 30 * 60 * 1000) {
      throw Object.assign(new Error("결제 세션이 만료됐습니다. Plus 시작을 다시 눌러 주세요."), { status: 410 });
    }
    const claimed = !ses.used_at && await db.one("UPDATE checkout_sessions SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id", [ses.id]);
    if (!claimed) {
      const paid = await db.one("SELECT id FROM payments WHERE subscription_id=$1 AND status='done' ORDER BY approved_at DESC LIMIT 1", [sub.id]);
      if (paid) return { ok: true, redirect: ses.return_url || `${SITE}/plus-done.html`, reused: true };
      const u = new URL(ses.cancel_url || `${SITE}/plus.html`); u.searchParams.set("error", "payment");
      return { ok: false, redirect: u.toString(), reused: true };
    }

    const issued = await toss.issueBillingKey({ authKey, customerKey });
    const enc = crypto.encrypt(issued.billingKey);
    const card = cardSummary(issued);
    await db.q("UPDATE subscriptions SET billing_key_encrypted=$2, card_summary=$3, updated_at=now() WHERE id=$1", [sub.id, enc, card]);
    if (ses.purpose === "change_card") {
      await audit(`sub:${sub.id}`, "card_changed", { card });
      await mail.cardChanged(cust.email, { cardSummary: card, manageUrl: manageUrl(sub.id) }).catch(logMail);
      // 결제 실패로 멈춰 있었다면 새 카드로 바로 시도한다
      const fresh = await db.one("SELECT * FROM subscriptions WHERE id=$1", [sub.id]);
      if (fresh.status === "past_due") await charge(fresh, { reason: "card_changed" });
      return { ok: true, redirect: ses.return_url || manageUrl(sub.id) };
    }
    const fresh = await db.one("SELECT * FROM subscriptions WHERE id=$1", [sub.id]);
    const r = await charge(fresh, { reason: "first" });
    if (!r.ok) {
      if (toss.deleteBillingKey) {
        try { await toss.deleteBillingKey({ billingKey: issued.billingKey }); }
        catch (e) { log.error("billing-key delete after first failure", e.message); }
      }
      await db.q("UPDATE subscriptions SET status='incomplete', billing_key_encrypted=NULL, updated_at=now() WHERE id=$1", [sub.id]);
      const u = new URL(ses.cancel_url || `${SITE}/plus.html`); u.searchParams.set("error", "payment"); u.searchParams.set("reason", r.reason || "");
      return { ok: false, redirect: u.toString() };
    }
    if (ses.install_id) {
      try { await linkInstall(cust.id, ses.install_id); }
      catch (e) {
        log.error("paid but install link pending", sub.id, e.message);
        await audit(`sub:${sub.id}`, "installation_link_pending", { install: ses.install_id.slice(0, 6), error: e.code || e.message });
        const pending = new URL(ses.return_url || `${SITE}/plus-done.html`);
        pending.searchParams.set("link", "pending");
        return { ok: true, redirect: pending.toString(), link_pending: true };
      }
    }
    return { ok: true, redirect: ses.return_url || `${SITE}/plus-done.html` };
  }

  /* 3. 승인 한 번. 첫 결제·갱신·재시도 모두 여기로. */
  async function charge(sub, { reason }) {
    const cust = await db.one("SELECT * FROM customers WHERE id=$1", [sub.customer_id]);
    const no = (sub.period_no || 0) + 1;
    const oid = orderId(sub.id, no);
    const existing = await db.one("SELECT * FROM payments WHERE order_id=$1 AND status='done'", [oid]);
    if (existing) return { ok: true, payment: existing, duplicate: true };
    let billingKey;
    try { billingKey = crypto.decrypt(sub.billing_key_encrypted); }
    catch { return await onFailure(sub, cust, { code: "NO_BILLING_KEY", message: "결제 수단이 등록되지 않았습니다." }, no, oid); }
    try {
      const p = await toss.charge({ billingKey, customerKey: sub.toss_customer_key, amount: PLAN.amount, orderId: oid,
                                    orderName: PLAN.name, customerEmail: cust.email, customerName: cust.name || cust.email.split("@")[0] });
      if (p.status !== "DONE") throw Object.assign(new Error(`status ${p.status}`), { code: p.status });
      const approvedAt = p.approvedAt ? new Date(p.approvedAt) : now();
      const next = afterSuccess(sub, approvedAt);
      await db.tx(async c => {
        await c.query(`INSERT INTO payments(subscription_id, order_id, payment_key, amount, status, approved_at, receipt_url, raw)
                       VALUES($1,$2,$3,$4,'done',$5,$6,$7)
                       ON CONFLICT(order_id) DO UPDATE SET status='done', payment_key=EXCLUDED.payment_key, approved_at=EXCLUDED.approved_at,
                         receipt_url=EXCLUDED.receipt_url, raw=EXCLUDED.raw, fail_reason=NULL`,
                      [sub.id, oid, p.paymentKey, PLAN.amount, approvedAt, p.receipt && p.receipt.url, p]);
        await c.query(`UPDATE subscriptions SET status=$2, current_period_start=$3, current_period_end=$4, period_no=$5,
                       fail_count=0, first_failed_at=NULL, next_retry_at=NULL, updated_at=now() WHERE id=$1`,
                      [sub.id, next.status, next.current_period_start, next.current_period_end, next.period_no]);
      });
      await audit(`sub:${sub.id}`, "charged", { orderId: oid, reason, paymentKey: p.paymentKey });
      await mail.receipt(cust.email, { amount: PLAN.amount, approvedAt, periodEnd: next.current_period_end,
                                       receiptUrl: p.receipt && p.receipt.url, manageUrl: manageUrl(sub.id), first: no === 1 }).catch(logMail);
      return { ok: true, payment: p };
    } catch (e) {
      return await onFailure(sub, cust, e, no, oid);
    }
  }

  async function onFailure(sub, cust, e, no, oid) {
    const msg = e.message || String(e);
    await db.q(`INSERT INTO payments(subscription_id, order_id, amount, status, fail_reason, raw) VALUES($1,$2,$3,'failed',$4,$5)
                ON CONFLICT(order_id) DO UPDATE SET fail_reason=EXCLUDED.fail_reason, raw=EXCLUDED.raw`,
               [sub.id, oid, PLAN.amount, msg, e.body || { code: e.code, message: msg }]);
    if (no === 1) { // 첫 결제 실패는 재시도 없이 사용자가 다시 시도한다
      await audit(`sub:${sub.id}`, "first_charge_failed", { code: e.code, message: msg });
      return { ok: false, reason: msg, code: e.code };
    }
    const hard = HARD_FAIL.has(e.code);
    const n = afterFailure(sub, now());
    const exhausted = n.exhausted || hard;
    await db.q(`UPDATE subscriptions SET status='past_due', fail_count=$2, first_failed_at=$3, next_retry_at=$4, updated_at=now() WHERE id=$1`,
               [sub.id, n.fail_count, n.first_failed_at, exhausted ? null : n.next_retry_at]);
    await audit(`sub:${sub.id}`, "charge_failed", { code: e.code, message: msg, attempt: n.fail_count, hard });
    await mail.failed(cust.email, { amount: PLAN.amount, reason: msg, nextRetryAt: n.next_retry_at, exhausted, manageUrl: manageUrl(sub.id) }).catch(logMail);
    return { ok: false, reason: msg, code: e.code, exhausted };
  }

  /* 4. 라이선스: 확장이 install_id 하나로 묻는다. */
  async function license(installId) {
    const t = now();
    if (!installId || !/^[a-z0-9]{20,40}$/.test(installId)) return licenseView(null, t);
    const inst = await db.one("SELECT * FROM installations WHERE public_install_id=$1", [installId]);
    if (!inst) return licenseView(null, t);
    await db.q("UPDATE installations SET last_seen_at=now() WHERE id=$1", [inst.id]);
    if (!inst.customer_id) return licenseView(null, t);
    const sub = await liveSub(inst.customer_id);
    const cust = await db.one("SELECT email FROM customers WHERE id=$1", [inst.customer_id]);
    const v = licenseView(sub, t);
    if (sub) {
      v.manage_url = manageUrl(sub.id);
      v.email = maskEmail(cust.email);
      // Chrome sync에는 이 제한된 토큰만 저장한다. 결제·환불·해지는 할 수 없고 새 설치 연결만 가능하다.
      v.sync_token = crypto.sign({ sub: sub.id, scope: "link_install" }, 400 * 86400000);
    }
    return v;
  }

  /* 5. 관리 페이지 */
  async function subscriptionByToken(token) {
    const p = crypto.verify(token);
    if (!p || p.scope !== "manage" || !p.sub) throw Object.assign(new Error("링크가 만료됐거나 잘못됐습니다."), { status: 401 });
    const sub = await db.one("SELECT * FROM subscriptions WHERE id=$1", [p.sub]);
    if (!sub) throw Object.assign(new Error("구독이 없습니다."), { status: 404 });
    const cust = await db.one("SELECT * FROM customers WHERE id=$1", [sub.customer_id]);
    return { sub, cust };
  }
  async function manageView(token) {
    const { sub, cust } = await subscriptionByToken(token);
    const pays = await db.q("SELECT order_id, amount, status, approved_at, receipt_url, fail_reason, created_at FROM payments WHERE subscription_id=$1 ORDER BY created_at DESC LIMIT 12", [sub.id]);
    const last = pays.rows.find(p => p.status === "done");
    const installs = await db.q("SELECT id, public_install_id, last_seen_at FROM installations WHERE customer_id=$1 ORDER BY last_seen_at DESC NULLS LAST", [cust.id]);
    return {
      email: cust.email, status: sub.status, plan: PLAN, card: sub.card_summary,
      current_period_end: sub.current_period_end, cancel_at_period_end: sub.cancel_at_period_end,
      next_retry_at: sub.next_retry_at, refundable: refundable(last, now()),
      payments: pays.rows, installs: installs.rows.map(i => ({ installation_id: i.id, label: i.public_install_id.slice(0, 6) + "…", last_seen_at: i.last_seen_at }))
    };
  }
  async function cancel(token) {
    const { sub, cust } = await subscriptionByToken(token);
    if (sub.cancel_at_period_end || !["active", "past_due"].includes(sub.status)) return { ok: true, noop: true };
    await db.q("UPDATE subscriptions SET cancel_at_period_end=true, status=CASE WHEN status='active' THEN 'canceled' ELSE status END, next_retry_at=NULL, updated_at=now() WHERE id=$1", [sub.id]);
    await audit(`sub:${sub.id}`, "canceled", {});
    await mail.canceled(cust.email, { periodEnd: sub.current_period_end || now(), manageUrl: manageUrl(sub.id) }).catch(logMail);
    return { ok: true };
  }
  async function resume(token) {
    const { sub } = await subscriptionByToken(token);
    if (!sub.cancel_at_period_end) return { ok: true, noop: true };
    if (sub.current_period_end && new Date(sub.current_period_end) < now()) throw Object.assign(new Error("이미 만료됐습니다. 새로 결제해 주세요."), { status: 409 });
    await db.q("UPDATE subscriptions SET cancel_at_period_end=false, status='active', updated_at=now() WHERE id=$1", [sub.id]);
    await audit(`sub:${sub.id}`, "resumed", {});
    return { ok: true };
  }
  async function refund(token) {
    const { sub, cust } = await subscriptionByToken(token);
    const last = await db.one("SELECT * FROM payments WHERE subscription_id=$1 AND status='done' ORDER BY approved_at DESC LIMIT 1", [sub.id]);
    if (!refundable(last, now())) throw Object.assign(new Error("최근 결제의 환불 가능 기간(결제 후 7일)이 지났습니다."), { status: 409 });
    await toss.cancel({ paymentKey: last.payment_key, cancelReason: "고객 요청 (7일 이내 청약철회)" });
    await db.tx(async c => {
      await c.query("UPDATE payments SET status='canceled' WHERE id=$1", [last.id]);
      await c.query("UPDATE subscriptions SET status='expired', cancel_at_period_end=true, current_period_end=now(), billing_key_encrypted=NULL, updated_at=now() WHERE id=$1", [sub.id]);
    });
    if (sub.billing_key_encrypted && toss.deleteBillingKey) {
      try { await toss.deleteBillingKey({ billingKey: crypto.decrypt(sub.billing_key_encrypted) }); }
      catch (e) { log.error("billing-key delete after refund", e.message); }
    }
    await audit(`sub:${sub.id}`, "refunded", { paymentKey: last.payment_key, amount: last.amount });
    await mail.refunded(cust.email, { amount: last.amount, manageUrl: manageUrl(sub.id) }).catch(logMail);
    return { ok: true };
  }
  async function changeCard(token, return_url) {
    const { sub, cust } = await subscriptionByToken(token);
    return createCheckout({ email: cust.email, purpose: "change_card", subscription_id: sub.id, return_url: return_url || manageUrl(sub.id), cancel_url: manageUrl(sub.id) });
  }
  async function requestRestore(email, installId) {
    if (!installId || !/^[a-z0-9]{20,40}$/.test(installId)) return { ok: true };
    const cust = await findCustomerByEmail(email);
    if (!cust) return { ok: true };
    const sub = await liveSub(cust.id);
    if (!sub) return { ok: true };
    const restoreToken = crypto.sign({ sub: sub.id, scope: "restore_install", install: installId }, 24 * 3600000);
    const u = new URL(`${API}/v1/restore/confirm`);
    u.searchParams.set("token", restoreToken);
    u.searchParams.set("install", installId);
    await mail.restore(cust.email, { restoreUrl: u.toString() }).catch(logMail);
    await audit(`cust:${cust.id}`, "restore_requested", { install: installId.slice(0, 6) });
    return { ok: true };
  }

  async function confirmRestore(token, installId) {
    const p = crypto.verify(token);
    if (!p || p.scope !== "restore_install" || !p.sub || p.install !== installId) {
      throw Object.assign(new Error("복원 링크가 만료됐거나 이 Chrome에서 요청한 링크가 아닙니다."), { status: 401 });
    }
    const sub = await db.one("SELECT * FROM subscriptions WHERE id=$1", [p.sub]);
    if (!sub || !["active", "canceled", "past_due"].includes(sub.status)) {
      throw Object.assign(new Error("사용 가능한 Plus 이용권이 없습니다."), { status: 409 });
    }
    await linkInstall(sub.customer_id, installId);
    await audit(`sub:${sub.id}`, "installation_restored", { install: installId.slice(0, 6) });
    return { ok: true, redirect: `${SITE}/plus-done.html?restored=1` };
  }

  async function linkByToken(token, installId) {
    const p = crypto.verify(token);
    if (!p || !p.sub || !["manage", "link_install"].includes(p.scope)) {
      throw Object.assign(new Error("연결 링크가 만료됐거나 잘못됐습니다."), { status: 401 });
    }
    const sub = await db.one("SELECT * FROM subscriptions WHERE id=$1", [p.sub]);
    if (!sub || !["active", "canceled", "past_due"].includes(sub.status)) {
      throw Object.assign(new Error("사용 가능한 Plus 이용권이 없습니다."), { status: 409 });
    }
    const r = await linkInstall(sub.customer_id, installId);
    if (!r) throw Object.assign(new Error("install_id가 올바르지 않습니다."), { status: 400 });
    await audit(`sub:${sub.id}`, "installation_linked", { install: installId.slice(0, 6), via: p.scope });
    return { ok: true };
  }

  async function unlinkInstall(token, installationId) {
    const { sub, cust } = await subscriptionByToken(token);
    if (!/^[0-9a-f-]{36}$/i.test(String(installationId || ""))) {
      throw Object.assign(new Error("연결 기기 정보가 올바르지 않습니다."), { status: 400 });
    }
    const row = await db.one("SELECT * FROM installations WHERE id=$1 AND customer_id=$2", [installationId, cust.id]);
    if (!row) throw Object.assign(new Error("이미 해제됐거나 이 이용권에 연결된 기기가 아닙니다."), { status: 404 });
    await db.q("UPDATE installations SET customer_id=NULL WHERE id=$1 AND customer_id=$2", [installationId, cust.id]);
    await audit(`sub:${sub.id}`, "installation_unlinked", { install: row.public_install_id.slice(0, 6) });
    return { ok: true };
  }

  /* 6. 스케줄러 한 바퀴. 매시 부른다. */
  async function tick() {
    const t = now();
    const subs = await db.q("SELECT * FROM subscriptions WHERE status IN ('active','past_due','canceled')");
    let reminded = 0, charged = 0, expired = 0;
    for (const sub of subs.rows) {
      try {
        if (sub.status === "canceled" && sub.current_period_end && new Date(sub.current_period_end) <= t) {
          if (sub.billing_key_encrypted && toss.deleteBillingKey) {
            try { await toss.deleteBillingKey({ billingKey: crypto.decrypt(sub.billing_key_encrypted) }); }
            catch (e) { log.error("billing-key delete after expiry", sub.id, e.message); }
          }
          await db.q("UPDATE subscriptions SET status='expired', billing_key_encrypted=NULL, updated_at=now() WHERE id=$1", [sub.id]); expired++; continue;
        }
        const sent = (await db.q("SELECT action FROM audit WHERE subject=$1 AND action LIKE 'once:remind%'", [`sub:${sub.id}`])).rows.map(r => r.action);
        const rem = reminderDue(sub, t, sent);
        if (rem) {
          const cust = await db.one("SELECT email FROM customers WHERE id=$1", [sub.customer_id]);
          const ins = await db.q("INSERT INTO audit(subject, action, meta) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [`sub:${sub.id}`, rem.key, { left: rem.left }]);
          if (ins.rows.length) { await mail.reminder(cust.email, { days: rem.days, periodEnd: sub.current_period_end, amount: PLAN.amount, cardSummary: sub.card_summary, manageUrl: manageUrl(sub.id) }).catch(logMail); reminded++; }
        }
        if (chargeDue(sub, t)) { await charge(sub, { reason: sub.status === "past_due" ? "retry" : "renewal" }); charged++; }
      } catch (e) { log.error("tick", sub.id, e.message); }
    }
    return { reminded, charged, expired, scanned: subs.rows.length };
  }

  async function audit(subject, action, meta) { await db.q("INSERT INTO audit(subject, action, meta) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [subject, action, meta || {}]); }
  function logMail(e) { log.error("mail", e.message); }
  function maskEmail(e) { const [u, d] = String(e).split("@"); return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "***") + "@" + d; }

  return { createCheckout, completeBilling, charge, license, manageView, cancel, resume, refund, changeCard, requestRestore, confirmRestore, linkByToken, unlinkInstall, tick, manageUrl, linkInstall, findCustomerByEmail };
}
