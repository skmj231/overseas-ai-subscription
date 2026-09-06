/* Donna Plus 관리 — 토큰(?token=)으로 상태를 읽고 해지·재개·환불·카드 변경을 요청한다. */
(function () {
  const API = "https://api.donna.co.kr/v1";
  const q = new URLSearchParams(location.search);
  const token = q.get("token") || "";
  const install = q.get("install") || "";
  const $ = (id) => document.getElementById(id);
  const won = (n) => "₩" + Number(n).toLocaleString("ko-KR");
  const date = (d) => { if (!d) return "—"; const x = new Date(d); return `${x.getFullYear()}년 ${x.getMonth() + 1}월 ${x.getDate()}일`; };
  const say = (t, k) => { const m = $("msg"); m.textContent = t; m.className = "msg" + (k ? " " + k : ""); };

  async function post(path, body) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
    return j;
  }

  async function load() {
    if (!token) { $("err-card").hidden = false; $("who").textContent = ""; return; }
    let v;
    try {
      const r = await fetch(API + "/subscription?token=" + encodeURIComponent(token));
      if (!r.ok) throw new Error(String(r.status));
      v = await r.json();
    } catch (e) { $("err-card").hidden = false; $("who").textContent = ""; return; }

    $("who").textContent = v.email;
    $("status-card").hidden = false; $("link-card").hidden = false; $("pay-card").hidden = false;
    const tag = $("st-tag"), title = $("st-title");
    const ends = date(v.current_period_end);
    if (v.status === "active" && !v.cancel_at_period_end) { title.textContent = "Plus 이용 중"; tag.textContent = "자동 갱신"; tag.className = "tag"; }
    else if (v.status === "canceled" || v.cancel_at_period_end) { title.textContent = "해지 예약됨"; tag.textContent = ends + "까지"; tag.className = "tag orange"; }
    else if (v.status === "past_due") { title.textContent = "결제 실패"; tag.textContent = v.next_retry_at ? date(v.next_retry_at) + " 재시도" : "재시도 중단"; tag.className = "tag red"; }
    else { title.textContent = "종료됨"; tag.textContent = "무료로 이용 중"; tag.className = "tag gray"; }
    $("kv-next").textContent = (v.status === "active" && !v.cancel_at_period_end) ? ends : (v.cancel_at_period_end ? `없음 · ${ends}까지 이용` : "—");
    $("kv-card").textContent = v.card || "등록 안 됨";
    $("kv-installs").textContent = v.installs.length ? `${v.installs.length}대 / 3대` : "없음";

    const live = ["active", "past_due", "canceled"].includes(v.status);
    $("b-card").hidden = !live;
    $("b-cancel").hidden = !live || v.cancel_at_period_end;
    $("b-resume").hidden = !(v.cancel_at_period_end && live);
    $("b-refund").hidden = !v.refundable;
    $("b-restart").hidden = live;
    $("c-cancel-until").textContent = ends;

    $("pays").innerHTML = v.payments.map(p => `<tr><td>${date(p.approved_at || p.created_at)}</td><td>${p.status === "done" ? "Donna Plus 3개월" : p.status === "canceled" ? "환불" : "실패 · " + (p.fail_reason || "")}</td><td class="n">${won(p.amount)}</td><td>${p.receipt_url ? `<a href="${p.receipt_url}" target="_blank" rel="noopener">보기</a>` : ""}</td></tr>`).join("")
      || `<tr><td colspan="4" style="color:var(--sub)">아직 없음</td></tr>`;

    if (install && live) {
      try { await post("/installations/link", { install_id: install }); $("link-msg").textContent = "이 컴퓨터를 연결했어요. 확장 프로그램에서 '상태 다시 확인'을 누르면 바로 반영됩니다."; $("link-msg").className = "msg ok"; }
      catch (e) { $("link-msg").textContent = "연결하지 못했어요: " + e.message; $("link-msg").className = "msg err"; }
    }
  }

  $("b-cancel").addEventListener("click", () => { $("c-cancel").classList.add("on"); $("c-refund").classList.remove("on"); });
  $("c-cancel-no").addEventListener("click", () => $("c-cancel").classList.remove("on"));
  $("c-cancel-yes").addEventListener("click", async () => {
    try { await post("/subscription/cancel", {}); $("c-cancel").classList.remove("on"); say("해지를 접수했어요. 확인 메일을 보냈습니다.", "ok"); load(); }
    catch (e) { say(e.message, "err"); }
  });
  $("b-resume").addEventListener("click", async () => {
    try { await post("/subscription/resume", {}); say("자동 갱신을 다시 켰어요.", "ok"); load(); } catch (e) { say(e.message, "err"); }
  });
  $("b-refund").addEventListener("click", () => { $("c-refund").classList.add("on"); $("c-cancel").classList.remove("on"); });
  $("c-refund-no").addEventListener("click", () => $("c-refund").classList.remove("on"));
  $("c-refund-yes").addEventListener("click", async () => {
    try { await post("/subscription/refund", {}); $("c-refund").classList.remove("on"); say("환불했어요. 카드사에 따라 3~5영업일 뒤 확인됩니다.", "ok"); load(); }
    catch (e) { say(e.message, "err"); }
  });
  $("b-card").addEventListener("click", async () => {
    try {
      say("토스페이먼츠 결제창을 엽니다.");
      const j = await post("/subscription/change-card", { return_url: location.href });
      const tp = TossPayments(j.client_key);
      const payment = tp.payment({ customerKey: j.customer_key });
      await payment.requestBillingAuth({ method: "CARD", successUrl: j.success_url, failUrl: j.fail_url, customerEmail: j.customer_email, customerName: j.customer_email.split("@")[0] });
    } catch (e) { say(/USER_CANCEL/i.test(e && e.code || "") ? "결제창을 닫으셨어요." : e.message, "err"); }
  });

  load();
})();
