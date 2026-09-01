/* 점검 화면 — 손으로 확인할 상황을 버튼 하나로 만든다.
 *
 * 여기서 하는 일은 chrome.storage.local에 값을 써 넣고 백그라운드에 "지금 한 번 돌려 봐"라고
 * 부르는 것뿐이다. 새 권한도, 바깥 통신도 없다.
 * 이 화면은 어디에서도 링크되지 않는다. 주소를 아는 사람만 연다. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const D = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const won = (n) => "₩" + Math.round(n || 0).toLocaleString("ko-KR");

  const W = (o) => Object.assign({
    name: "데모", amountOrig: 682813, currency: "KRW", amountKrw: 682813,
    interval: "year", auto: true, lastPaid: D(-351), due: D(14),
    manageUrl: "https://billing.stripe.com/p/session/demo", source: "stripe",
    status: "active", misses: 0, ackedFor: null,
    createdAt: D(-351), seenAt: D(-351), seenBy: "checkout", priceLog: []
  }, o);

  const BASE = () => ({
    consent: { v: 1, ts: Date.now() }, notified: {}, notiMap: {},
    settings: { notify: true }, ledger: [], subs: {}, stats: {}, watch: {}
  });

  const PRE = [
    ["금액이 확실할 때", "₩682,813이 자동으로 빠져나갑니다. 버튼은 해지하러 가기 · 계속 씁니다.",
      () => Object.assign(BASE(), { watch: { d: W({ name: "Higgsfield" }) } })],
    ["한 주기 지났을 때", "지난번과 같다면 USD 20이 빠져나갑니다. 단정하지 않습니다.",
      () => Object.assign(BASE(), { watch: { d: W({ name: "Cursor", interval: "month",
        amountOrig: 20, currency: "USD", amountKrw: 28070,
        lastPaid: D(-16), due: D(5), createdAt: D(-45), seenAt: D(-45) }) } })],
    ["오래됐고 확인 주소 있음", "마지막으로 본 금액은 1년 전 기준이라고 밝히고 금액 확인하기 버튼이 뜹니다.",
      () => Object.assign(BASE(), { watch: { d: W({ name: "Higgsfield", interval: "month",
        lastPaid: D(-16), due: D(5), createdAt: D(-400), seenAt: D(-400) }) } })],
    ["오래됐고 확인 주소 없음", "오래됐다는 말은 하되 확인 버튼은 안 띄웁니다. 눌러도 열 곳이 없기 때문입니다.",
      () => Object.assign(BASE(), { watch: { d: W({ name: "Movavi", interval: "month",
        amountOrig: 99, currency: "USD", amountKrw: 138000, lastPaid: D(-16), due: D(5),
        manageUrl: null, source: "manual", createdAt: D(-400), seenAt: D(-400) }) } })],
    ["예정일이 지남", "결제됐나요? 버튼은 결제됐어요 · 해지했어요. 여기서 눌러 다음 단계를 봅니다.",
      () => Object.assign(BASE(), { watch: { d: W({ name: "ElevenLabs", interval: "month",
        amountOrig: 22, currency: "USD", amountKrw: 30900, lastPaid: D(-32), due: D(-2),
        manageUrl: null, createdAt: D(-32), seenAt: D(-32) }) } })],
    ["같은 구독 중복", "세무 쪽과 알림 쪽에 같은 구독이 있는 상태. 알림이 딱 한 건이어야 합니다.",
      () => Object.assign(BASE(), {
        subs: { dup: { merchant: "DupTest", interval: "year", auto: true, lastPaid: D(-351),
          amountKrw: 682813, currency: "KRW", amountOrig: 682813 } },
        watch: { dup: W({ name: "DupTest", manageUrl: null }) } })]
  ];

  const ETC = [
    ["추정 기록 쌓기", "계속 씁니다로 주기가 넘어간 상황. 기록함에 추정 한 줄이 생겨야 합니다.",
      () => Object.assign(BASE(), { watch: { d: W({ name: "Runway", interval: "month",
        amountOrig: 35, currency: "USD", amountKrw: 49200, lastPaid: D(-32), due: D(-1),
        ackedFor: D(-1), manageUrl: null, createdAt: D(-32), seenAt: D(-32) }) } })],
    ["월 1회 요약", "구독 건수, 월 합계, 확인 필요, 해지로 절약 중인 금액을 한 줄로 알립니다.",
      () => Object.assign(BASE(), {
        stats: { saved: 62074, canceledYear: 682813 },
        ledger: [{ id: "x1", date: D(-10), merchant: "A", mkey: "a", supplier: "unknown",
          status: "confirmed", amountKrw: 30000, currency: "KRW" }],
        watch: {
          a: W({ name: "Cursor", interval: "month", amountOrig: 20, currency: "USD",
            amountKrw: 28070, due: D(20), createdAt: D(-400), seenAt: D(-400) }),
          b: W({ name: "Higgsfield", due: D(40), createdAt: D(-10), seenAt: D(-10) })
        } })],
    ["무료 체험 전환", "체험이 곧 유료로 바뀐다고 알립니다.",
      () => Object.assign(BASE(), { subs: { d: { merchant: "Gamma", trial: true,
        interval: "month", auto: true, lastPaid: D(-28), amountKrw: 0, currency: "KRW" } } })],
    ["알림 전체 끄기", "위 상황을 만들어도 알림이 하나도 안 떠야 합니다. 목록과 기록은 그대로 돕니다.",
      () => Object.assign(BASE(), { settings: { notify: false },
        watch: { d: W({ name: "Higgsfield" }) } })]
  ];

  let toastTimer = null;
  function toast(t) {
    const m = $("msg");
    m.textContent = t; m.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => m.classList.remove("on"), 2600);
  }

  async function apply(label, make) {
    try {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(make());
      await chrome.runtime.sendMessage({ type: "runTick" });
      await paint();
      /* "알림을 보세요"라고 붙이면 알림 끄기 항목에서 거짓말이 된다.
         무엇이 나와야 하는지는 각 줄에 이미 적혀 있으니 여기서는 준비됐다는 말만 한다. */
      toast(label + " 준비 완료.");
    } catch (e) {
      toast("실패했습니다. 확장 프로그램을 다시 로드해 주세요.");
    }
  }

  function rows(host, list) {
    host.innerHTML = "";
    list.forEach(([label, desc, make]) => {
      const d = document.createElement("div");
      d.className = "row";
      const b = document.createElement("button");
      b.textContent = "만들기";
      b.addEventListener("click", () => apply(label, make));
      const p = document.createElement("p");
      p.innerHTML = "<b></b><em></em>";
      p.querySelector("b").textContent = label;
      p.querySelector("em").textContent = desc;
      d.appendChild(b); d.appendChild(p);
      host.appendChild(d);
    });
  }

  async function paint() {
    const s = await chrome.storage.local.get(null);
    const watch = s.watch || {}, ledger = s.ledger || [], stats = s.stats || {};
    const live = Object.keys(watch).filter(k =>
      watch[k] && (watch[k].status === "active" || watch[k].status === "pending"));
    const est = ledger.filter(r => r.status === "estimated").length;
    const cells = [
      ["구독", live.length + "건"],
      ["기록", ledger.length + "건" + (est ? " (추정 " + est + ")" : "")],
      ["동의", s.consent ? "받음" : "아직"],
      ["사업자번호", (s.profile && s.profile.brn) ? "저장됨" : "없음"],
      ["알림", (s.settings && s.settings.notify === false) ? "꺼짐" : "켜짐"],
      ["부가세로 아낀 돈", won(stats.saved)],
      ["해지로 연", won(stats.canceledYear)]
    ];
    $("state").innerHTML = cells.map(([k, v]) =>
      `<div><span></span><b></b></div>`).join("");
    Array.from($("state").children).forEach((el, i) => {
      el.querySelector("span").textContent = cells[i][0];
      el.querySelector("b").textContent = cells[i][1];
    });
  }

  rows($("pre"), PRE);
  rows($("etc"), ETC);
  /* 확인용 줄은 하는 일이 달라서(상황을 만들지 않는다) 따로 붙인다.
     rows()를 재활용해 버튼만 바꾸면 원래 동작이 같이 실행돼 오류가 난다. */
  {
    const d = document.createElement("div");
    d.className = "row";
    const b = document.createElement("button");
    b.textContent = "펼치기";
    b.addEventListener("click", async () => {
      const st = await chrome.storage.local.get(null);
      const o = $("out");
      o.hidden = false;
      o.textContent = JSON.stringify(st, null, 2);
      toast("저장소를 펼쳤습니다. " + JSON.stringify(st).length + "자");
    });
    const p = document.createElement("p");
    p.innerHTML = "<b></b><em></em>";
    p.querySelector("b").textContent = "저장소 전문";
    p.querySelector("em").textContent =
      "지금 저장돼 있는 것을 그대로 펼칩니다. 카드번호 같은 게 없는지 눈으로 확인하실 수 있습니다.";
    d.appendChild(b); d.appendChild(p);
    $("dump").appendChild(d);
  }

  /* 되돌릴 수 없는 버튼이라 한 번에 지우지 않는다. 팝업의 전체 삭제와 같은 방식이다. */
  $("wipe").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed !== "1") {
      b.dataset.armed = "1";
      b.textContent = "정말 지웁니다 · 한 번 더";
      setTimeout(() => {
        if (b.dataset.armed === "1") { b.dataset.armed = ""; b.textContent = "연습 데이터 전부 지우기"; }
      }, 6000);
      return;
    }
    b.dataset.armed = "";
    b.textContent = "연습 데이터 전부 지우기";
    await chrome.storage.local.clear();
    $("out").hidden = true;
    await paint();
    toast("전부 지웠습니다.");
  });

  paint();
})();
