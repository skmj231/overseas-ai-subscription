/* 이메일 — Resend (https://resend.com). 키가 없으면 콘솔에만 찍는다(개발·테스트).
 * 4종: 결제 완료(영수증), 갱신 안내(7일·3일 전), 결제 실패, 해지 확인. + 환불 완료, 카드 변경 완료.
 */
import { PLAN, fmtDate, won } from "./policy.js";

export function makeMailer({ MAIL_API_KEY, MAIL_FROM = "Donna <no-reply@donna.co.kr>", SITE_URL = "https://donna.co.kr", fetchImpl = fetch, log = console }) {
  async function send(to, subject, text) {
    if (!MAIL_API_KEY) { log.info(`[mail:dry] to=${to} subject=${subject}\n${text}`); return { dry: true }; }
    const r = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${MAIL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text })
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`mail ${r.status} ${t}`); }
    return r.json();
  }

  const foot = (manageUrl) => `\n\n—\n관리·해지: ${manageUrl}\n문의: stevejk911@gmail.com\n솔리드 미디어(SOLID MEDIA) · 사업자등록번호 659-13-02509 · 통신판매업신고 제2025-서울강남-02655호\n경기도 양평군 지평면 산허머리길 53-1`;

  return {
    send,
    receipt: (to, { amount, approvedAt, periodEnd, receiptUrl, manageUrl, first }) => send(to,
      first ? "Donna Plus 결제가 완료됐습니다" : "Donna Plus가 갱신됐습니다",
      `${first ? "Donna Plus를 시작해 주셔서 감사합니다." : "Donna Plus가 3개월 더 이어집니다."}\n\n` +
      `상품: ${PLAN.name}\n결제 금액: ${won(amount)} (부가세 포함)\n결제일: ${fmtDate(approvedAt)}\n다음 결제일: ${fmtDate(periodEnd)}\n` +
      (receiptUrl ? `영수증: ${receiptUrl}\n` : "") +
      `\n${first ? "확장 프로그램 패널을 열면 몇 초 안에 구독 개수 제한이 풀립니다. 반영되지 않으면 설정에서 'Plus 상태 다시 확인'을 눌러 주세요.\n\n결제 후 7일 이내에 네 번째 이상의 구독을 등록하지 않았다면 전액 환불받을 수 있습니다." : "다음 결제 7일 전과 3일 전에 다시 알려드립니다."}` + foot(manageUrl)),

    reminder: (to, { days, periodEnd, amount, cardSummary, manageUrl }) => send(to,
      `${days}일 뒤 Donna Plus ${won(amount)}이 결제됩니다`,
      `${fmtDate(periodEnd)}에 ${cardSummary ? cardSummary + "로 " : ""}${won(amount)}이 자동 결제됩니다.\n\n` +
      `계속 쓰시려면 아무것도 하지 않으셔도 됩니다. 그만 쓰시려면 아래 링크에서 해지하세요. 해지해도 ${fmtDate(periodEnd)}까지는 그대로 쓰실 수 있습니다.` + foot(manageUrl)),

    failed: (to, { amount, reason, nextRetryAt, exhausted, manageUrl }) => send(to,
      exhausted ? "Donna Plus 결제가 계속 실패해 잠시 멈췄습니다" : "Donna Plus 결제가 실패했습니다",
      `${won(amount)} 자동 결제가 실패했습니다.${reason ? `\n사유: ${reason}` : ""}\n\n` +
      (exhausted
        ? "세 번 시도했지만 승인되지 않아 Plus를 잠시 멈췄습니다. 등록해 둔 구독과 알림은 그대로이고, 새 구독 등록만 무료 한도(3개)로 제한됩니다.\n아래 링크에서 결제 수단을 바꾸면 바로 다시 시작됩니다."
        : `${fmtDate(nextRetryAt)}에 다시 시도합니다. 그 전에 결제 수단을 바꾸시면 바로 승인해 드립니다.\n등록해 둔 구독은 그대로입니다.`) + foot(manageUrl)),

    canceled: (to, { periodEnd, manageUrl }) => send(to,
      "Donna Plus 해지가 접수됐습니다",
      `다음 자동 결제를 중단했습니다. ${fmtDate(periodEnd)}까지는 지금처럼 쓰실 수 있고, 그 뒤로는 새 구독 등록만 무료 한도(3개)로 돌아갑니다. 등록해 둔 구독과 기록은 지워지지 않습니다.\n\n마음이 바뀌면 같은 링크에서 다시 켤 수 있습니다.` + foot(manageUrl)),

    refunded: (to, { amount, manageUrl }) => send(to,
      "Donna Plus 환불이 완료됐습니다",
      `${won(amount)}을 결제하신 카드로 환불했습니다. 카드사에 따라 3~5영업일이 걸릴 수 있습니다.\n\nPlus는 종료됐고, 등록해 둔 구독과 기록은 그대로입니다.` + foot(manageUrl)),

    cardChanged: (to, { cardSummary, manageUrl }) => send(to,
      "Donna Plus 결제 수단이 바뀌었습니다",
      `앞으로 ${cardSummary || "새 카드"}로 결제됩니다.` + foot(manageUrl))
  };
}
