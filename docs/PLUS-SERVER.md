# Donna Plus 결제 서버 설계 (api.donna.co.kr)

작성 2026-09-06. 확장 1.5.0과 donna.co.kr/plus.html이 기대하는 계약이다. 서버는 아직 없다. 이 문서대로 만들면 확장·사이트는 고치지 않아도 된다.

## 원칙

- 확장 프로그램에는 PG 키·빌링키·시크릿이 없다. 확장이 서버에 보내는 것은 `install_id` 하나다.
- 결제는 `donna.co.kr/plus.html`에서만 시작한다. 카드 정보는 토스페이먼츠 결제창이 받고 서버는 빌링키만 암호화해 보관한다.
- 서버 응답이 `active`일 때만 확장이 `plan.tier = "plus"`로 바꾼다. 응답이 없으면 마지막 상태를 7일까지 믿는다(`extension/plan.js` `GRACE_DAYS`).
- 해지·만료·결제 실패는 사용자의 로컬 데이터를 건드리지 않는다. 추가 등록만 막는다.

## 상품

| 항목 | 값 |
|---|---|
| 상품명 | Donna Plus 3개월 이용권 (`plan = "plus_3m"`) |
| 가격 | 6,000원 / 3개월, 부가세 포함 |
| 갱신 | 최초 승인일 기준 3개월마다 같은 날 (말일 보정) |
| 갱신 안내 | 갱신 7일 전 이메일 |
| 실패 재시도 | 하루 1회, 7일. 그 뒤 `past_due` → 확장은 무료 한도로 |
| 환불 | 결제 후 7일 이내이고 4개 이상 구독을 등록하지 않았으면 전액. 그 외 남은 기간 이용 |
| 기기 | 같은 이메일로 확인한 install_id 3개까지 |

(환불·기기 수는 plus.html·terms.html에 이미 적혀 있다. 바꾸면 두 페이지도 같이 바꾼다.)

## 흐름

```
plus.html ──POST /v1/checkout/session {email, install_id}──▶ 서버
   ◀── {checkout_url}  (토스 빌링키 발급 창: customerKey = customer.id)
토스 successUrl ──▶ GET /v1/billing/issue?customerKey&authKey ──▶ 빌링키 발급(POST /v1/billing/authorizations/issue)
   └─▶ 첫 승인 6,000원 (POST /v1/billing/{billingKey}, orderId = sub_{id}_1)
   └─▶ subscriptions.status = active, current_period_end = +3개월
   └─▶ 302 → https://donna.co.kr/plus-done.html
확장 ──GET /v1/license?install_id──▶ {tier:"plus", status:"active", current_period_end}
스케줄러(매시) ──▶ current_period_end - 7d: 안내 메일 / current_period_end 도래: 다음 회차 승인
```

## API

모든 응답 `Content-Type: application/json`. `Access-Control-Allow-Origin`은 `https://donna.co.kr`과 `chrome-extension://<확장 ID>` 두 개만. `/v1/license`는 확장이 서비스 워커에서 `fetch`로 부르므로 CORS 헤더가 없으면 실패한다.

### `POST /v1/checkout/session`
요청 `{ email, install_id?, plan: "plus_3m", return_url, cancel_url }`
- email 검증, `customers` upsert, install_id가 있으면 `installations`에 연결(없으면 결제 뒤 확장에서 '상태 다시 확인'을 눌러도 연결이 안 되므로 plus-done에서 이메일 인증 링크를 보낸다).
- 토스 빌링키 발급 창 주소를 만든다. `customerKey`는 `customers.id`(UUID). `successUrl = /v1/billing/issue?sid=...`, `failUrl = cancel_url`.
- 응답 `{ checkout_url }`. 실패 시 4xx + `{ error }`.

### `GET /v1/billing/issue?sid&customerKey&authKey` (토스 successUrl)
- `POST https://api.tosspayments.com/v1/billing/authorizations/issue` → billingKey. 암호화해 `subscriptions.billing_key_encrypted`에 저장.
- 첫 승인 `POST https://api.tosspayments.com/v1/billing/{billingKey}` `{ customerKey, amount: 6000, orderId: "sub_{subscription_id}_1", orderName: "Donna Plus 3개월 이용권", customerEmail }`. `Idempotency-Key = orderId`.
- 성공: `subscriptions.status = active`, `current_period_start = now`, `current_period_end = now + 3개월`; `payments` 기록; 영수증 메일; 302 `return_url`.
- 실패: `subscriptions.status = incomplete`; 302 `cancel_url?error=payment`.

### `GET /v1/license?install_id=`
확장이 하루 한 번 부른다. 응답은 항상 200(설치를 못 찾으면 무료).
```json
{ "tier": "plus", "status": "active", "current_period_end": "2026-12-06T00:00:00Z",
  "cancel_at_period_end": false, "manage_url": "https://donna.co.kr/plus-manage.html?token=...", "email": "a@b.c" }
```
- `status`: `active` | `canceled`(기간 끝까지 이용) | `past_due` | `expired` | `none`
- `manage_url`: 확장 설정의 '관리' 버튼이 연다. 토큰은 24시간짜리 서명 링크. 해지·결제수단 변경 페이지(아직 없음, `plus-manage.html`).
- 캐시 금지 헤더. 응답에 구독 내용을 넣을 일은 없다.

### `POST /v1/subscription/cancel` (manage 페이지·메일 링크)
`{ token }` → `cancel_at_period_end = true`, `status = canceled`. 즉시 해지가 아니라 다음 갱신 중단. 확인 메일.

### `POST /v1/subscription/refund` (7일 이내 환불)
토스 `POST /v1/payments/{paymentKey}/cancel`. 조건 검증은 서버가 한다(결제일 +7일, 확장이 보고한 구독 수는 서버가 모른다 → 사용자 신고 기반, 분쟁 시 수동).

## 데이터

```sql
customers      (id uuid pk, email text unique, created_at)
installations  (id uuid pk, customer_id fk null, public_install_id text unique, last_seen_at, created_at)
subscriptions  (id uuid pk, customer_id fk, plan text, status text,
                billing_key_encrypted bytea, toss_customer_key text,
                current_period_start, current_period_end, cancel_at_period_end bool,
                fail_count int default 0, next_retry_at, created_at, updated_at)
payments       (id uuid pk, subscription_id fk, order_id text unique, payment_key text,
                amount int, status text, approved_at, receipt_url, raw jsonb)
audit          (id, subject, action, at, meta jsonb)
```
- `public_install_id`는 확장이 만든 26자 문자열. 한 고객에 최대 3개.
- 빌링키는 KMS 또는 libsodium secretbox로 암호화. 키는 환경변수가 아닌 KMS 우선.

## 스케줄러 (매시)

1. `current_period_end - 7일` 안에 들어온 `active` 구독 → 갱신 안내 메일(한 번만, `audit`로 중복 방지).
2. `current_period_end <= now` and not `cancel_at_period_end` → 승인 시도. `orderId = sub_{id}_{n}`, `Idempotency-Key = orderId`. 성공하면 기간 +3개월, 실패하면 `fail_count++`, `next_retry_at = +24h`, 실패 메일.
3. `fail_count >= 7` → `status = past_due`. 확장은 다음 라이선스 확인 때 무료 한도로 돌아간다(데이터는 그대로).
4. `cancel_at_period_end` and `current_period_end <= now` → `status = expired`.

## 보안 체크리스트

- [ ] install_id는 추측 불가(26자 base36 ≈ 134bit). 로그에 남기지 않는다.
- [ ] `/v1/checkout/session`은 이메일 rate limit(IP당 10/시간).
- [ ] 토스 시크릿 키는 서버에만. 클라이언트 키는 plus.html에도 넣지 않는다(결제창은 서버가 만든 URL로 연다).
- [ ] 모든 승인은 orderId + Idempotency-Key. 재시도해도 이중 결제가 없다.
- [ ] 웹훅(`/v1/webhooks/toss`)은 서명 검증 후 `payments` 상태만 갱신. 상태 변경의 근원은 서버 자체 호출 결과.
- [ ] 라이선스 응답에 캐시 금지. 확장의 유예 7일이 있으므로 서버 장애가 곧바로 사용자 제한으로 이어지지 않는다.

## 환경변수

```
TOSS_SECRET_KEY, TOSS_CLIENT_KEY, DATABASE_URL, BILLING_KEY_KMS_ID (또는 BILLING_KEY_SECRET),
MAIL_API_KEY, MAIL_FROM=Donna <no-reply@donna.co.kr>, SITE_URL=https://donna.co.kr,
EXTENSION_ID=<웹스토어 ID>, LICENSE_TOKEN_SECRET
```

## 남은 페이지

- `plus-manage.html` — 상태, 다음 결제일, 해지, 결제수단 변경, 영수증 목록. `manage_url` 토큰으로 진입.
- 이메일 4종: 결제 완료(영수증), 갱신 7일 전, 결제 실패, 해지 확인.

## 확장 쪽 계약 요약 (`extension/plan.js`)

- `FREE_LIMIT = 3`, 해지 확인된 구독은 세지 않는다.
- `isPlus(plan)`: `tier=plus` 이고 (`active` 이면서 `current_period_end + 7일 > now`) 또는 (`canceled` 이면서 `current_period_end > now`).
- 하루 한 번 `/v1/license` 호출. 404·네트워크 오류는 이전 상태 유지, 유예 지나면 무료.
- Plus 진입 URL: `https://donna.co.kr/plus.html?install=<id>&utm_source=extension&utm_medium=sidepanel&utm_campaign=<gate|settings|manage>`
