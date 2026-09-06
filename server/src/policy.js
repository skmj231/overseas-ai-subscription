/* Donna Plus · 정책과 날짜 계산. DB도 네트워크도 없다 → 그대로 테스트한다.
 *
 * 상품: 3개월 6,000원. 갱신 7일·3일 전 메일. 실패하면 즉시 메일, 3일 뒤·7일 뒤 재시도, 그 뒤 past_due.
 * 환불: 결제 후 7일 이내 전액(서버는 '사용 여부'를 모르므로 신고 기반, 분쟁은 수동).
 * 기기: 고객당 install_id 3개.
 */
export const PLAN = {
  id: "plus_3m",
  name: "Donna Plus 3개월 이용권",
  amount: 6000,          // 부가세 포함
  months: 3,
  reminderDays: [7, 3],  // 갱신 며칠 전에 메일
  retryDays: [3, 7],     // 첫 실패로부터 며칠 뒤에 다시 시도
  refundDays: 7,
  maxInstalls: 3,
  graceDays: 7           // 확장(plan.js)의 유예와 같다. 서버는 이 안에서 재시도를 끝낸다
};

const DAY = 86400000;

/* 3개월 뒤 같은 날. 말일이 없는 달(11/30 → 2/30)은 그 달의 말일로 당긴다. */
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export function nextPeriod(start) {
  const s = new Date(start);
  return { start: s, end: addMonths(s, PLAN.months) };
}

export function orderId(subscriptionId, periodNo) {
  // 토스 orderId 규칙: 6~64자, 영문·숫자·-·_
  return `sub_${String(subscriptionId).replace(/-/g, "")}_${periodNo}`;
}

/* 갱신 안내 메일을 지금 보내야 하나. days 중 '오늘이 그 날 이후이고 아직 안 보낸' 첫 단계.
   sentActions: ["once:remind7:<periodNo>", ...] */
export function reminderDue(sub, now, sentActions) {
  if (!sub.current_period_end || sub.status !== "active" || sub.cancel_at_period_end) return null;
  const end = new Date(sub.current_period_end).getTime();
  const t = new Date(now).getTime();
  const left = Math.ceil((end - t) / DAY);
  for (const d of PLAN.reminderDays) {
    const key = `once:remind${d}:${sub.period_no}`;
    if (left <= d && left > 0 && !sentActions.includes(key)) return { days: d, key, left };
  }
  return null;
}

/* 지금 승인을 시도해야 하나 (첫 갱신 또는 재시도) */
export function chargeDue(sub, now) {
  const t = new Date(now).getTime();
  if (sub.cancel_at_period_end) return false;
  if (sub.status === "active") return !!sub.current_period_end && new Date(sub.current_period_end).getTime() <= t;
  if (sub.status === "past_due" && sub.next_retry_at) return new Date(sub.next_retry_at).getTime() <= t;
  return false;
}

/* 실패했을 때 다음 상태. fail_count는 이번 실패를 포함한 횟수.
   1회 실패: past_due, 3일 뒤 재시도 / 2회: 7일 뒤(첫 실패 기준) / 3회: 재시도 없음(past_due 유지, 수동·카드 변경으로만 복구) */
export function afterFailure(sub, now) {
  const t = new Date(now);
  const first = sub.first_failed_at ? new Date(sub.first_failed_at) : t;
  const count = (sub.fail_count || 0) + 1;
  const idx = count - 1; // 0 → retryDays[0]
  const next = idx < PLAN.retryDays.length ? new Date(first.getTime() + PLAN.retryDays[idx] * DAY) : null;
  return { status: "past_due", fail_count: count, first_failed_at: first, next_retry_at: next, exhausted: next === null };
}

export function afterSuccess(sub, approvedAt) {
  // 만료 뒤 늦게 성공해도 기간은 원래 만료일부터 이어 붙인다(사용자가 손해 보지 않게 하되 중복 지급도 없게).
  const base = sub.current_period_end && new Date(sub.current_period_end) > new Date(approvedAt) - 30 * DAY
    ? new Date(sub.current_period_end) : new Date(approvedAt);
  const p = nextPeriod(base);
  return { status: "active", current_period_start: p.start, current_period_end: p.end, period_no: (sub.period_no || 0) + 1,
           fail_count: 0, first_failed_at: null, next_retry_at: null };
}

/* 확장 /v1/license 응답. 확장(plan.js)의 isPlus와 같은 뜻으로 맞춘다. */
export function licenseView(sub, now) {
  if (!sub) return { tier: "free", status: "none", current_period_end: null, cancel_at_period_end: false };
  const t = new Date(now).getTime();
  const end = sub.current_period_end ? new Date(sub.current_period_end) : null;
  let status = sub.status;
  if (status === "canceled" && end && end.getTime() <= t) status = "expired";
  const tier = (status === "active" || status === "canceled" || status === "past_due") ? "plus" : "free";
  // past_due는 tier는 plus지만 확장이 isPlus=false로 다룬다(추가 등록 제한, 데이터 유지).
  return { tier, status, current_period_end: end ? end.toISOString() : null, cancel_at_period_end: !!sub.cancel_at_period_end };
}

export function refundable(payment, now) {
  if (!payment || payment.status !== "done" || !payment.approved_at) return false;
  return new Date(now).getTime() - new Date(payment.approved_at).getTime() <= PLAN.refundDays * DAY;
}

export function fmtDate(d) {
  const x = new Date(d);
  // 표시는 한국 시간
  const k = new Date(x.getTime() + 9 * 3600000);
  return `${k.getUTCFullYear()}년 ${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일`;
}
export function won(n) { return "₩" + Number(n).toLocaleString("ko-KR"); }
