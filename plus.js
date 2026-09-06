/* Donna Plus 결제 시작 — 카드 정보는 이 페이지를 거치지 않는다.
   서버가 결제 세션을 만들고 토스페이먼츠 결제창 주소를 돌려주면 그리로 보낸다. */
(function () {
  const API = "https://api.donna.co.kr/v1";
  const q = new URLSearchParams(location.search);
  const form = document.getElementById("checkout");
  if (!form) return;
  const email = document.getElementById("email"), install = document.getElementById("install"),
        agree = document.getElementById("agree"), pay = document.getElementById("pay"), msg = document.getElementById("msg");
  install.value = q.get("install") || "";
  if (q.get("email")) email.value = q.get("email");

  const d = new Date(); d.setMonth(d.getMonth() + 3);
  const nb = document.getElementById("nextBill"); if (nb) nb.textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

  function say(text, kind) { msg.textContent = text; msg.className = "msg" + (kind ? " " + kind : ""); }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!email.value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value)) { say("이메일 주소를 확인해 주세요.", "err"); email.focus(); return; }
    if (!agree.checked) { say("자동 결제 동의에 체크해 주세요.", "err"); agree.focus(); return; }
    pay.disabled = true; say("결제창을 준비하고 있습니다…");
    try {
      const r = await fetch(API + "/checkout/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.value.trim(), install_id: install.value || null, plan: "plus_3m",
                               return_url: location.origin + "/plus-done.html", cancel_url: location.href })
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!j.checkout_url) throw new Error("no url");
      say("토스페이먼츠 결제창으로 이동합니다.", "ok");
      location.href = j.checkout_url;
    } catch (err) {
      pay.disabled = false;
      say("지금은 결제 서버에 연결할 수 없습니다. 잠시 뒤 다시 시도하거나 stevejk911@gmail.com으로 알려 주세요.", "err");
    }
  });
})();
