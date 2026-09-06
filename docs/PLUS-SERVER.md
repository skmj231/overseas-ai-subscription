# Donna Plus 결제 서버 설계 (api.donna.co.kr)

작성 2026-09-06. 구현: `server/` (Node 22 + Express 5 + Postgres). 확장 1.5.0·plus.html·plus-manage.html과 계약이 맞춰져 있다. 배포 순서는 `docs/PLUS-LAUNCH.md`.

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
| 갱신 안내 | 갱신 7일 전·3일 전 이메일 |
| 실패 재시도 | 실패 즉시 메일, 3일 뒤·7일 뒤 재시도. 그 뒤 `past_due` → 확장은 무료 한도로 |
| 환불 | 결제 후 7일 이내이고 4개 이상 구독을 등록하지 않았으면 전액. 그 외 남은 기간 이용 |
| 기기 | 같은 이메일로 확인한 install_id 3개까지 |

(환불·기기 수는 plus.html·terms.html에 이미 적혀 있다. 바꾸면 두 페이지도 같이 바꾼다.)

## 흐름

```
plus.html ──POST /v1/checkout/session {email, install_id}──▶ 서버: customers upsert, subscriptions(pending), checkout_sessions
   ◀── {client_key, customer_key, customer_email, success_url, fail_url}
plus.js: TossPayments(client_key).payment({customerKey}).requestBillingAuth({method:"CARD", successUrl, failUrl, customerEmail})
토스 → GET /v1/billing/issue?sid&customerKey&authKey
   └─▶ POST tosspayments /v1/billing/authorizations/issue → billingKey(AES-256-GCM으로 저장)
   └─▶ POST tosspayments /v1/billing/{billingKey} 6,000원, orderId = sub_<id>_1, Idempotency-Key = orderId
   └─▶ active, current_period_end = +3개월, 영수증 메일, install_id 연결 → 302 plus-done.html
확장 ──GET /v1/license?install_id──▶ {tier, status, current_period_end, cancel_at_period_end, manage_url, email(마스킹)}
스케줄러(매시, advisory lock) ──▶ 7일·3일 전 안내 메일 / 만료일 승인 / 실패 3일·7일 뒤 재시도 / 해지 예약 만료 처리
```

## API (구현됨: `server/src/app.js`)

CORS: `https://donna.co.kr`과 `chrome-extension://<EXTENSION_ID>`만. 모든 응답 `Cache-Control: no-store`.

| 메서드·경로 | 누가 | 하는 일 |
|---|---|---|
| `POST /v1/checkout/session` | plus.html | `{email, install_id?, return_url?, cancel_url?}` → 결제창 파라미터. 이미 Plus면 `{already:true, manage_url}`. IP당 10회/시간 |
| `GET /v1/billing/issue?sid&customerKey&authKey` | 토스 successUrl | 빌링키 발급 + (새 구독) 첫 승인 / (카드 변경) 교체 후 past_due면 즉시 재시도 → 302 |
| `GET /v1/billing/fail?sid&message` | 토스 failUrl | plus.html?error=canceled로 302 |
| `GET /v1/license?install_id` | 확장 | 라이선스 뷰. 모르는 설치는 free. IP당 120회/시간 |
| `GET /v1/subscription?token` | plus-manage | 상태·카드·결제내역·연결 기기·환불 가능 여부 |
| `POST /v1/subscription/cancel` `{token}` | plus-manage·메일 | 다음 갱신 중단(기간 끝까지 이용), 확인 메일 |
| `POST /v1/subscription/resume` `{token}` | plus-manage | 해지 예약 취소 |
| `POST /v1/subscription/refund` `{token}` | plus-manage | 첫 결제 7일 이내 전액 환불, 즉시 종료 |
| `POST /v1/subscription/change-card` `{token, return_url?}` | plus-manage | 카드 변경용 결제창 파라미터 |
| `POST /v1/installations/link` `{token, install_id}` | plus-manage | 기기 연결(3대 초과 시 가장 오래 안 본 것 해제) |
| `POST /v1/webhooks/toss` | 토스 | `PAYMENT_STATUS_CHANGED` → 결제를 다시 조회해 payments 상태만 갱신 |
| `GET /healthz` | Railway | DB 핑 |

관리 토큰: HMAC-SHA256 서명, 30일. 라이선스 응답의 `manage_url`과 모든 메일 하단에 들어간다.

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
- 빌링키는 AES-256-GCM(`BILLING_KEY_SECRET`)으로 암호화해 저장. 키를 바꾸면 기존 빌링키를 못 읽는다.

## 스케줄러 (`service.tick`, 매시)

1. `canceled`이고 `current_period_end <= now` → `expired`.
2. `active`이고 해지 예약이 아니면 만료 7일·3일 전에 안내 메일(단계별 한 번, `audit` unique index로 중복 방지).
3. `active`이고 `current_period_end <= now` → 승인. 성공하면 기간을 **원래 만료일부터** +3개월(늦게 성공해도 손해 없음), `period_no++`.
4. 실패 → `past_due`, `fail_count=1`, `next_retry_at = 첫 실패 + 3일`. 두 번째 실패 → `+7일`. 세 번째 실패 또는 카드 자체 문제(`HARD_FAIL` 코드) → 재시도 중단. 매 실패마다 메일. 카드를 바꾸면 그 자리에서 재시도.
5. 첫 결제(회차 1) 실패는 재시도하지 않고 `incomplete`로 두고 plus.html로 돌려보낸다.

## 보안 체크리스트

- [ ] install_id는 추측 불가(26자 base36 ≈ 134bit). 로그에 남기지 않는다.
- [ ] `/v1/checkout/session`은 이메일 rate limit(IP당 10/시간).
- [ ] 토스 시크릿 키는 서버에만. 클라이언트 키는 plus.html에도 넣지 않는다(결제창은 서버가 만든 URL로 연다).
- [ ] 모든 승인은 orderId + Idempotency-Key. 재시도해도 이중 결제가 없다.
- [ ] 웹훅(`/v1/webhooks/toss`)은 서명 검증 후 `payments` 상태만 갱신. 상태 변경의 근원은 서버 자체 호출 결과.
- [ ] 라이선스 응답에 캐시 금지. 확장의 유예 7일이 있으므로 서버 장애가 곧바로 사용자 제한으로 이어지지 않는다.

## 환경변수

```
TOSS_SECRET_KEY, TOSS_CLIENT_KEY, DATABASE_URL, BILLING_KEY_SECRET(32바이트 hex),
MAIL_API_KEY, MAIL_FROM=Donna <no-reply@donna.co.kr>, SITE_URL=https://donna.co.kr,
EXTENSION_ID=<웹스토어 ID>, LICENSE_TOKEN_SECRET
```

## 페이지·메일

- `plus-manage.html` — 상태, 다음 결제일, 해지·재개, 결제수단 변경, 7일 환불, 결제 내역, 기기 연결.
- 메일 6종(`server/src/mail.js`, Resend): 결제 완료·갱신 영수증, 갱신 안내(7일·3일 전), 결제 실패, 해지 확인, 환불 완료, 카드 변경.

## 확장 쪽 계약 요약 (`extension/plan.js`)

- `FREE_LIMIT = 3`, 해지 확인된 구독은 세지 않는다.
- `isPlus(plan)`: `tier=plus` 이고 (`active` 이면서 `current_period_end + 7일 > now`) 또는 (`canceled` 이면서 `current_period_end > now`).
- 하루 한 번 `/v1/license` 호출. 404·네트워크 오류는 이전 상태 유지, 유예 지나면 무료.
- Plus 진입 URL: `https://donna.co.kr/plus.html?install=<id>&utm_source=extension&utm_medium=sidepanel&utm_campaign=<gate|settings|manage>`
