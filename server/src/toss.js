/* 토스페이먼츠 빌링(자동결제) API 클라이언트.
 * https://docs.tosspayments.com/reference#빌링
 *
 * 인증: Basic base64("{secretKey}:")
 * - 빌링키 발급   POST /v1/billing/authorizations/issue  { authKey, customerKey }
 * - 자동결제 승인 POST /v1/billing/{billingKey}          { customerKey, amount, orderId, orderName, customerEmail, customerName }
 * - 결제 조회     GET  /v1/payments/{paymentKey}
 * - 결제 취소     POST /v1/payments/{paymentKey}/cancel   { cancelReason, cancelAmount? }
 * 모든 쓰기 호출에 Idempotency-Key를 붙인다(같은 orderId로 두 번 승인돼도 한 번만 결제).
 */
export function makeToss({ TOSS_SECRET_KEY, fetchImpl = fetch, base = "https://api.tosspayments.com" }) {
  if (!TOSS_SECRET_KEY) throw new Error("TOSS_SECRET_KEY가 없습니다.");
  const auth = "Basic " + Buffer.from(TOSS_SECRET_KEY + ":").toString("base64");

  async function call(method, path, body, idem) {
    const headers = { Authorization: auth, "Content-Type": "application/json" };
    if (idem) headers["Idempotency-Key"] = idem;
    const r = await fetchImpl(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok) {
      const err = new Error((j && j.message) || `toss ${r.status}`);
      err.code = j && j.code; err.status = r.status; err.body = j;
      throw err;
    }
    return j;
  }

  return {
    issueBillingKey: ({ authKey, customerKey }) =>
      call("POST", "/v1/billing/authorizations/issue", { authKey, customerKey }),
    charge: ({ billingKey, customerKey, amount, orderId, orderName, customerEmail, customerName }) =>
      call("POST", `/v1/billing/${encodeURIComponent(billingKey)}`,
           { customerKey, amount, orderId, orderName, customerEmail, customerName }, orderId),
    getPayment: (paymentKey) => call("GET", `/v1/payments/${encodeURIComponent(paymentKey)}`),
    cancel: ({ paymentKey, cancelReason, cancelAmount }) =>
      call("POST", `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`,
           cancelAmount ? { cancelReason, cancelAmount } : { cancelReason }, `cancel_${paymentKey}`)
  };
}

/* 실패 코드 중 '재시도해도 소용없는' 것. 이건 바로 카드 변경을 안내한다. */
export const HARD_FAIL = new Set([
  "INVALID_CARD_NUMBER", "INVALID_STOPPED_CARD", "INVALID_CARD_EXPIRATION", "INVALID_CARD_LOST_OR_STOLEN",
  "REJECT_CARD_COMPANY", "NOT_SUPPORTED_CARD_TYPE", "INVALID_CARD_INSTALLMENT_PLAN", "NOT_REGISTERED_BUSINESS",
  "EXCEED_MAX_CARD_INSTALLMENT_PLAN", "NOT_AVAILABLE_PAYMENT", "INVALID_BILLING_KEY", "NOT_FOUND_BILLING_KEY"
]);

export function cardSummary(p) {
  const c = p && p.card;
  if (!c) return null;
  const num = c.number ? String(c.number).replace(/\*/g, "").slice(-4) : "";
  return [c.company || c.issuerCode || "카드", num ? `**** ${num}` : ""].filter(Boolean).join(" ");
}
