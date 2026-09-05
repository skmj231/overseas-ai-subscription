/* 돈나가요 · presets.js — 자주 쓰는 해외 AI·SaaS 서비스의 기본값
 *
 * 왜 있나: 구독 관리 앱이 버려지는 첫 번째 이유는 "입력이 귀찮아서"다.
 * 이름 하나를 누르면 금액·주기·해지 화면·환불 정책이 채워지게 해서
 * 사용자가 적을 것을 '다음 결제일' 하나로 줄인다.
 *
 * 값의 성격: 2026-09 기준 공식 요금 페이지에서 확인한 개인 요금제 기본값이다.
 * 실제 청구액은 프로모션·연간 할인·지역 가격·부가세로 달라질 수 있으므로
 * 화면에서는 항상 "기본값, 고칠 수 있음"으로 보여 준다. 추측해서 채우지 않는다.
 * verified:false 인 항목은 공식 페이지에서 그 값을 직접 보지 못한 것이다.
 *
 * DOM도 chrome API도 쓰지 않는다 → node 테스트에서 그대로 읽는다.
 */
(function (root) {
  "use strict";

  const P = [
    { id: "chatgpt", name: "ChatGPT Plus", aliases: ["chatgpt", "openai", "gpt", "챗지피티", "챗gpt"],
      amount: 20, currency: "USD", interval: "month", yearly: null,
      manageUrl: "https://chatgpt.com/#settings/Billing",
      refundUrl: "https://help.openai.com/en/articles/7232895",
      refundNote: "한국: 결제 후 7일 이내·미사용이면 전액 환불", appStore: true, verified: true },
    { id: "claude", name: "Claude Pro", aliases: ["claude", "anthropic", "클로드"],
      amount: 20, currency: "USD", interval: "month", yearly: 200,
      manageUrl: "https://claude.ai/settings/billing",
      refundUrl: "https://support.claude.com/en/articles/12386328",
      refundNote: "한국: 7일 이내 청약철회 가능(사용분 비례)", appStore: true, verified: true },
    { id: "cursor", name: "Cursor Pro", aliases: ["cursor", "커서", "anysphere"],
      amount: 20, currency: "USD", interval: "month", yearly: null,
      manageUrl: "https://cursor.com/dashboard/billing",
      refundUrl: "https://cursor.com/help/account-and-billing/refunds",
      refundNote: "14일 이내·해당 기간 미사용일 때만 환불", appStore: true, verified: true },
    { id: "midjourney", name: "Midjourney", aliases: ["midjourney", "mj", "미드저니"],
      amount: 10, currency: "USD", interval: "month", yearly: 96, plans: [{ name: "Basic", amount: 10 }, { name: "Standard", amount: 30 }],
      manageUrl: "https://www.midjourney.com/account",
      refundUrl: "https://docs.midjourney.com/hc/en-us/articles/25386088618253",
      refundNote: "거의 안 씀(GPU 20분 미만)일 때만 환불", appStore: false, verified: true },
    { id: "gemini", name: "Google AI Pro (Gemini)", aliases: ["gemini", "google ai pro", "제미나이", "google one"],
      amount: 19.99, currency: "USD", interval: "month", yearly: null,
      manageUrl: "https://one.google.com/settings",
      refundUrl: "https://support.google.com/googleone/answer/2736362",
      refundNote: "대부분 국가에서 환불 불가", appStore: true, verified: true },
    { id: "perplexity", name: "Perplexity Pro", aliases: ["perplexity", "퍼플렉시티"],
      amount: 20, currency: "USD", interval: "month", yearly: 200,
      manageUrl: "https://www.perplexity.ai/settings",
      refundUrl: "https://www.perplexity.ai/help-center/en/articles/10354288-refunds",
      refundNote: "한국: 결제 후 7일 이내 환불 요청 가능", appStore: true, verified: true },
    { id: "copilot", name: "GitHub Copilot Pro", aliases: ["github copilot", "copilot pro", "코파일럿"],
      amount: 10, currency: "USD", interval: "month", yearly: null,
      manageUrl: "https://github.com/settings/billing",
      refundUrl: "https://docs.github.com/en/copilot/managing-copilot/managing-copilot-as-an-individual-subscriber/managing-your-copilot-subscription/about-billing-for-github-copilot-individual",
      refundNote: "해지는 주기 말에 반영·환불 규정 없음", appStore: false, verified: true },
    { id: "m365", name: "Microsoft 365 Premium (Copilot)", aliases: ["microsoft 365", "copilot pro", "m365", "오피스"],
      amount: 19.99, currency: "USD", interval: "month", yearly: 199.99,
      manageUrl: "https://account.microsoft.com/services",
      refundUrl: "https://support.microsoft.com/en-us/accounts-billing/subscriptions/microsoft-subscription-refund-policy",
      refundNote: "한국: 언제든 남은 기간 비례 환불", appStore: true, verified: true },
    { id: "notion", name: "Notion Plus", aliases: ["notion", "노션"],
      amount: 12, currency: "USD", interval: "month", yearly: 120,
      manageUrl: "https://www.notion.so/my-account",
      refundUrl: "https://www.notion.com/help/upgrade-or-downgrade-your-plan",
      refundNote: "월간 3일·연간 30일 이내 다운그레이드 시 전액 환불", appStore: true, verified: false },
    { id: "canva", name: "Canva Pro", aliases: ["canva", "캔바"],
      amount: 99000, currency: "KRW", interval: "year", yearly: 99000,
      manageUrl: "https://www.canva.com/settings/billing-and-teams",
      refundUrl: "https://www.canva.com/help/subscription-refunds/",
      refundNote: "원칙적으로 환불 불가, 건별 검토", appStore: true, verified: true },
    { id: "figma", name: "Figma Professional", aliases: ["figma", "피그마"],
      amount: 20, currency: "USD", interval: "month", yearly: 192,
      manageUrl: "https://www.figma.com/files",
      refundUrl: "https://www.figma.com/pricing-faq/",
      refundNote: "EU·터키 외 환불 불가", appStore: false, verified: false },
    { id: "elevenlabs", name: "ElevenLabs", aliases: ["elevenlabs", "eleven labs", "일레븐랩스"],
      amount: 22, currency: "USD", interval: "month", yearly: null, plans: [{ name: "Starter", amount: 6 }, { name: "Creator", amount: 22 }],
      manageUrl: "https://elevenlabs.io/app/subscription",
      refundUrl: "https://elevenlabs.io/docs/product-guides/administration/billing",
      refundNote: "14일 이내·크레딧 미사용일 때 환불", appStore: false, verified: true },
    { id: "replit", name: "Replit Core", aliases: ["replit", "리플릿"],
      amount: 20, currency: "USD", interval: "month", yearly: 204,
      manageUrl: "https://replit.com/account",
      refundUrl: "https://docs.replit.com/help/billing-and-refunds",
      refundNote: "구독 결제 30일 이내 환불 가능(사용량 요금 제외)", appStore: true, verified: true },
    { id: "grammarly", name: "Grammarly Pro", aliases: ["grammarly", "그래머리"],
      amount: 30, currency: "USD", interval: "month", yearly: 144,
      manageUrl: "https://account.grammarly.com/subscription",
      refundUrl: "https://support.grammarly.com/hc/en-us/articles/360049189071",
      refundNote: "법이 요구할 때만 환불", appStore: true, verified: true },
    { id: "adobe", name: "Adobe Creative Cloud", aliases: ["adobe", "creative cloud", "어도비", "포토샵", "photoshop"],
      amount: 78100, currency: "KRW", interval: "month", yearly: null,
      manageUrl: "https://account.adobe.com/plans",
      refundUrl: "https://www.adobe.com/kr/legal/subscription-terms.html",
      refundNote: "14일 이내 전액 환불 · 연간 약정 중도 해지 시 위약금", appStore: true, verified: true },
    { id: "lovable", name: "Lovable", aliases: ["lovable", "러버블"],
      amount: 25, currency: "USD", interval: "month", yearly: 250,
      manageUrl: "https://lovable.dev/settings/billing",
      refundUrl: "https://lovable.dev/terms",
      refundNote: "원칙적으로 환불 불가", appStore: true, verified: true },
    { id: "v0", name: "v0 (Vercel)", aliases: ["v0", "vercel"],
      amount: 30, currency: "USD", interval: "month", yearly: null,
      manageUrl: "https://v0.app/settings/billing",
      refundUrl: "https://vercel.com/legal/terms",
      refundNote: "환불 불가", appStore: false, verified: true },
    { id: "runway", name: "Runway", aliases: ["runway", "runwayml", "런웨이"],
      amount: 15, currency: "USD", interval: "month", yearly: 144,
      manageUrl: "https://app.runwayml.com/settings/billing",
      refundUrl: "https://help.runwayml.com/hc/en-us/articles/24343363554067",
      refundNote: "30일 이내·거의 미사용이면 환불 가능", appStore: true, verified: true },
    { id: "suno", name: "Suno Pro", aliases: ["suno", "수노"],
      amount: 10, currency: "USD", interval: "month", yearly: 96,
      manageUrl: "https://suno.com/account",
      refundUrl: "https://help.suno.com/en/articles/2550209",
      refundNote: "원칙적으로 환불 불가, 건별 검토", appStore: true, verified: true },
    { id: "framer", name: "Framer", aliases: ["framer", "프레이머"],
      amount: 15, currency: "USD", interval: "month", yearly: 120,
      manageUrl: "https://framer.com/projects",
      refundUrl: "https://www.framer.com/help/articles/refund-policy/",
      refundNote: "첫 결제 7일 이내 환불", appStore: false, verified: false },
    { id: "webflow", name: "Webflow", aliases: ["webflow", "웹플로우"],
      amount: 18, currency: "USD", interval: "month", yearly: 180,
      manageUrl: "https://webflow.com/dashboard",
      refundUrl: "https://help.webflow.com/hc/en-us/articles/40102090399635",
      refundNote: "원칙적으로 환불 불가(EU 14일 예외)", appStore: false, verified: false },
    { id: "zapier", name: "Zapier Professional", aliases: ["zapier", "재피어"],
      amount: 29.99, currency: "USD", interval: "month", yearly: 239.88,
      manageUrl: "https://zapier.com/app/settings/billing",
      refundUrl: "https://help.zapier.com/hc/en-us/articles/38624184577165",
      refundNote: "모든 결제 환불 불가", appStore: false, verified: false },
    { id: "linear", name: "Linear", aliases: ["linear", "리니어"],
      amount: 12, currency: "USD", interval: "month", yearly: 120,
      manageUrl: "https://linear.app/settings/billing",
      refundUrl: "https://linear.app/docs/billing-and-plans",
      refundNote: "중도 해지 환불 없음", appStore: false, verified: false },
    { id: "loom", name: "Loom Business", aliases: ["loom", "룸"],
      amount: 18, currency: "USD", interval: "month", yearly: 180,
      manageUrl: "https://www.loom.com/settings/workspace",
      refundUrl: "https://support.atlassian.com/loom/docs/looms-billing-policy-for-paid-plans",
      refundNote: "중도 해지 비례 환불 없음", appStore: false, verified: true }
  ];

  /* 온보딩·빈 화면에 먼저 보여 줄 순서. 한국 사용자가 가장 많이 결제하는 AI 툴이 앞이다. */
  const FEATURED = ["chatgpt", "claude", "cursor", "midjourney", "gemini", "perplexity", "copilot", "notion", "canva", "figma"];

  const norm = (s) => String(s || "").toLocaleLowerCase().replace(/[\s._\-]+/g, "");

  function find(q) {
    const n = norm(q);
    if (!n) return null;
    return P.find(p => norm(p.name) === n || p.id === n)
      || P.find(p => p.aliases.some(a => norm(a) === n))
      || P.find(p => norm(p.name).startsWith(n) || p.aliases.some(a => norm(a).startsWith(n)))
      || null;
  }

  function search(q, limit) {
    const n = norm(q);
    const out = !n ? FEATURED.map(id => P.find(p => p.id === id)).filter(Boolean)
      : P.filter(p => norm(p.name).includes(n) || p.aliases.some(a => norm(a).includes(n)));
    return out.slice(0, limit || 8);
  }

  /* 결제 채널. 같은 서비스를 웹과 앱스토어에서 두 번 결제하는 사고가 잦아서
     "어디서 결제 중인지"를 등록 때 한 번 묻는다. 해지 경로가 채널마다 다르다. */
  const CHANNEL = {
    web: { label: "웹사이트", cancelHint: "서비스 사이트의 결제·구독 설정에서 해지합니다." },
    appstore: { label: "App Store", cancelHint: "iPhone 설정 → Apple 계정 → 구독에서 해지합니다. 사이트에서 해지해도 App Store 결제는 계속됩니다." },
    play: { label: "Google Play", cancelHint: "Google Play → 결제 및 정기결제 → 정기결제에서 해지합니다. 사이트에서 해지해도 Play 결제는 계속됩니다." }
  };

  const CHANNEL_URL = {
    appstore: "https://apps.apple.com/account/subscriptions",
    play: "https://play.google.com/store/account/subscriptions"
  };

  root.SVSTPresets = { LIST: P, FEATURED, find, search, CHANNEL, CHANNEL_URL };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SVSTPresets;
})(typeof self !== "undefined" ? self : globalThis);
