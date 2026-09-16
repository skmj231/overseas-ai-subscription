/* Donna Plus 결제 시작.
   서버(api.donna.co.kr)가 결제 세션을 만들어 주면 토스페이먼츠 결제창(빌링키 발급)을 연다.
   카드 정보는 토스 결제창 안에서만 입력되고 Donna 서버·이 페이지를 거치지 않는다. */
(function () {
  const API = "https://api.donna.co.kr/v1";
  const q = new URLSearchParams(location.search);
  const form = document.getElementById("checkout");
  if (!form) return;
  const email = document.getElementById("email"), install = document.getElementById("install"),
        agree = document.getElementById("agree"), pay = document.getElementById("pay"), msg = document.getElementById("msg");
  install.value = q.get("install") || "";
  if (q.get("email")) email.value = q.get("email");
  const validInstall = /^[a-z0-9]{20,40}$/.test(install.value);

  const d = new Date(); d.setMonth(d.getMonth() + 3);
  const nb = document.getElementById("nextBill"); if (nb) nb.textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;

  function say(text, kind) { msg.textContent = text; msg.className = "msg" + (kind ? " " + kind : ""); }

  if (!validInstall) {
    pay.disabled = true;
    say("결제할 Chrome과 안전하게 연결하기 위해 Donna 확장 프로그램에서 ‘Plus 시작하기’를 눌러 주세요. 연결 정보 없이 결제는 진행하지 않습니다.", "err");
  }

  const restoreOpen = document.getElementById("restore-open"), restoreBox = document.getElementById("restore-box");
  const restoreEmail = document.getElementById("restore-email"), restoreSend = document.getElementById("restore-send"), restoreMsg = document.getElementById("restore-msg");
  if (restoreOpen) restoreOpen.addEventListener("click", () => { restoreBox.hidden = false; restoreEmail.value = email.value || ""; restoreEmail.focus(); });
  if (q.get("mode") === "restore" && restoreBox) { restoreBox.hidden = false; setTimeout(() => restoreEmail.focus(), 0); }
  if (restoreSend) restoreSend.addEventListener("click", async () => {
    const value = (restoreEmail.value || "").trim();
    restoreMsg.className = "msg"; restoreMsg.textContent = "";
    if (!validInstall) { restoreMsg.className = "msg err"; restoreMsg.textContent = "확장 프로그램에서 구매 복원을 시작해 주세요."; return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { restoreMsg.className = "msg err"; restoreMsg.textContent = "결제 이메일 주소를 확인해 주세요."; return; }
    restoreSend.disabled = true;
    try {
      const r = await fetch(API + "/restore/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: value, install_id: install.value }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      restoreMsg.className = "msg ok"; restoreMsg.textContent = "해당 이메일의 구매 내역이 있으면 복원 링크를 보냈습니다. 메일의 링크를 열어 연결을 완료해 주세요.";
    } catch (e3) {
      restoreMsg.className = "msg err"; restoreMsg.textContent = e3.message || "복원 메일을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
    } finally { restoreSend.disabled = false; }
  });

  // 토스 결제창에서 돌아왔는데 실패한 경우
  const err = q.get("error");
  if (err) {
    const reason = q.get("reason") || "", code = q.get("code") || "";
    const tail = reason ? ` (${reason})` : code ? ` (${code})` : "";
    say(err === "canceled" ? "결제창을 닫으셨어요. 다시 시도하려면 아래 버튼을 눌러 주세요."
      : err === "card" ? `카드가 등록되지 않았어요.${tail} 카드 번호와 유효기간을 다시 확인해 주세요.`
      : err === "payment" ? `카드 승인이 되지 않았어요.${tail} 다른 카드로 다시 시도해 주세요.`
      : `카드 등록 중 문제가 생겼어요.${tail} 잠시 뒤 다시 시도해 주세요.`, "err");
    form.scrollIntoView({ block: "center" });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!validInstall) { say("Donna 확장 프로그램에서 Plus 시작하기를 눌러 주세요.", "err"); return; }
    if (!email.value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value)) { say("이메일 주소를 확인해 주세요.", "err"); email.focus(); return; }
    if (!agree.checked) { say("3개월 자동 갱신 동의를 확인해 주세요.", "err"); agree.focus(); return; }
    if (typeof TossPayments !== "function") { say("결제 모듈을 불러오지 못했어요. 새로고침 뒤 다시 시도해 주세요.", "err"); return; }
    pay.disabled = true; say("결제창을 준비하고 있습니다…");
    try {
      const r = await fetch(API + "/checkout/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.value.trim(), install_id: install.value || null, plan: "plus_3m",
                               return_url: location.origin + "/plus-done.html", cancel_url: location.origin + "/plus.html" })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      if (j.already) { say("이미 Plus를 쓰고 계세요. 관리 페이지로 이동합니다.", "ok"); location.href = j.manage_url; return; }
      say("토스페이먼츠 결제창을 엽니다.", "ok");
      const tp = TossPayments(j.client_key);
      const payment = tp.payment({ customerKey: j.customer_key });
      await payment.requestBillingAuth({
        method: "CARD", successUrl: j.success_url, failUrl: j.fail_url,
        customerEmail: j.customer_email, customerName: j.customer_email.split("@")[0]
      });
    } catch (e2) {
      pay.disabled = false;
      const m = (e2 && e2.message) || "";
      if (/USER_CANCEL/i.test(e2 && e2.code || "")) { say("결제창을 닫으셨어요. 준비되면 다시 눌러 주세요."); return; }
      say(/HTTP|fetch|Failed/i.test(m) || !m ? "지금은 결제 서버에 연결할 수 없습니다. 잠시 뒤 다시 시도하거나 stevejk911@gmail.com으로 알려 주세요." : m, "err");
    }
  });
})();
