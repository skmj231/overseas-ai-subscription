# Donna Plus 도입 순서 — 토스페이먼츠 + Railway

코드는 다 있다(`server/`, `plus.html`, `plus-manage.html`, 확장 1.5.0). 이 문서는 **사람이 손으로 해야 하는 일**을 순서대로 적은 것이다. 위에서부터 하면 된다. 예상 소요: 계약 심사를 빼면 반나절.

## 0. 준비물

- 토스페이먼츠 가입에 필요한 것: 사업자등록증(659-13-02509), 통신판매업신고증(2025-서울강남-02655), 대표자 신분증, 정산 계좌(사업자 명의), 서비스 URL(https://donna.co.kr), 이용약관·개인정보처리방침 URL(이미 있음).
- Railway 계정(GitHub 로그인), Resend 계정(이메일), donna.co.kr DNS 관리 화면(Cloudflare로 보임).
- 이 저장소가 GitHub `skmj231/overseas-ai-subscription`에 푸시돼 있을 것. `server/` 폴더가 배포 대상이다.

## 1. 토스페이먼츠 — 테스트 키로 먼저 (30분)

1. https://developers.tosspayments.com 가입 → 로그인 → **내 개발정보**.
2. **API 키** 탭에서 테스트 키 두 개를 복사한다.
   - 클라이언트 키 `test_ck_…` → `TOSS_CLIENT_KEY`
   - 시크릿 키 `test_sk_…` → `TOSS_SECRET_KEY`
   - 테스트 키는 계약 없이 빌링(자동결제)까지 전부 동작한다. 실제 결제는 일어나지 않는다.
3. **웹훅** 탭에서 웹훅 URL 등록: `https://api.donna.co.kr/v1/webhooks/toss`, 이벤트 `PAYMENT_STATUS_CHANGED`. (서버가 뜬 뒤에 해도 된다.)

## 2. Railway — 서버 띄우기 (30분)

1. https://railway.app → **New Project** → **Deploy from GitHub repo** → `skmj231/overseas-ai-subscription` 선택.
2. 서비스 **Settings → Source**: Root Directory를 `server`로 바꾼다. (railway.json이 빌드·시작 명령을 갖고 있다.)
3. 프로젝트에 **+ New → Database → PostgreSQL** 추가. 생성되면 서비스의 **Variables**에 `DATABASE_URL`을 참조로 넣는다: `${{Postgres.DATABASE_URL}}`.
4. 서비스 **Variables**에 `.env.example`의 항목을 전부 넣는다. 비밀 두 개는 터미널에서 만든다:
   ```
   openssl rand -hex 32   # BILLING_KEY_SECRET
   openssl rand -hex 32   # LICENSE_TOKEN_SECRET
   ```
   `BILLING_KEY_SECRET`은 한 번 정하면 **절대 바꾸지 않는다**(바꾸면 저장된 빌링키를 못 읽어 모든 갱신이 실패한다). 두 값은 1Password 같은 곳에 따로 보관.
   `EXTENSION_ID`는 웹 스토어 항목 ID(`jkecjjpgplgpcfdbllaldllcliliojfn`).
5. **Settings → Networking → Custom Domain**에 `api.donna.co.kr`을 추가하면 CNAME 대상이 나온다.
6. Cloudflare DNS에 `api` CNAME → Railway가 준 값. Proxy는 **DNS only(회색 구름)** 로 두는 편이 단순하다(Railway가 TLS를 낸다).
7. 배포 로그에 `donna-plus-api :8787 (production)`이 보이고 `https://api.donna.co.kr/healthz`가 `{"ok":true}`를 주면 끝. 마이그레이션은 부팅 때 자동으로 돈다.

## 3. Resend — 이메일 (20분)

1. https://resend.com 가입 → **Domains → Add Domain** `donna.co.kr` → 나오는 DKIM·SPF 레코드를 Cloudflare DNS에 추가 → Verified.
2. **API Keys**에서 키 생성 → Railway `MAIL_API_KEY`. `MAIL_FROM=Donna <no-reply@donna.co.kr>`.
3. 키가 비어 있으면 서버는 메일을 보내지 않고 로그에만 찍는다(테스트 중에는 그래도 된다).

## 4. 사이트 배포 (10분)

`feature/sidepanel-onboarding-1.4`를 `main`에 머지하면 GitHub Pages가 donna.co.kr을 갱신한다. `plus.html`, `plus-done.html`, `plus-manage.html`, `terms.html`, `privacy.html`이 올라가 있는지 브라우저로 확인.

## 5. 테스트 결제 E2E (20분)

1. Chrome에 확장 1.5.0을 압축해제 로드. 구독 3개 등록 → 4번째에서 Plus 시트 → **Plus 시작하기** → `donna.co.kr/plus.html?install=…` 열림.
2. 이메일 입력 → 동의 → **카드 등록하고 시작하기** → 토스 테스트 결제창. 테스트 카드: 아무 카드번호(예 `4330-1234-1234-1234`), 유효기간 미래, 생년월일 아무 값. 
3. `plus-done.html`로 돌아오면 확장 설정 → Plus → **상태 다시 확인** → "Plus · 12월 6일까지"로 바뀌고 등록이 열린다.
4. 관리 페이지(설정 → 관리): 결제 내역에 6,000원 1건, 영수증 링크. 해지 → 메일 도착 → 다시 켜기. 7일 이내 환불 → 토스 대시보드에 취소 표시.
5. Railway 로그에서 `tick {"reminded":0,"charged":0,…}`이 매시 찍히는지 확인.
6. 갱신을 미리 보고 싶으면 Railway Postgres에서 `UPDATE subscriptions SET current_period_end = now() - interval '1 minute';` 뒤 한 시간 안에(또는 서버 재시작 15초 뒤) 승인이 한 번 더 일어난다. 실패 흐름은 토스 개발자센터의 "테스트 결제 실패 시뮬레이션" 카드번호로.

## 6. 라이브 전환 — 토스 계약 (심사 3~7영업일)

1. 토스페이먼츠 **상점 관리자** https://app.tosspayments.com 에서 **가맹점 등록(전자결제 신청)**. 업종은 "소프트웨어/SaaS 구독", 정산 주기 선택.
2. 같은 화면에서 **자동결제(빌링)** 사용 신청. 토스가 리스크 검토 후 별도 계약을 요구한다. 준비해 둘 답: 상품은 3개월 6,000원 정액, 해지는 즉시(다음 갱신 중단), 환불 규정은 terms.html 제4조, 고객센터 이메일.
3. 승인되면 **라이브 키**(`live_ck_…`, `live_sk_…`)가 나온다. Railway Variables의 `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`만 바꾸고 재배포. 코드는 그대로.
4. 웹훅 URL을 라이브 상점에도 등록.
5. 실제 카드로 6,000원 결제 한 번 → 영수증 메일 → 환불(7일 이내)로 전 구간 확인. 토스 대시보드에서 취소 확인.

## 7. 웹 스토어 제출

`store-submission/README.md` 순서대로. 설명문에 가격이 이미 들어 있고, "앱 내 결제"는 **아니오**(결제는 웹사이트).

## 운영에서 알아 둘 것

- 상태 흐름: `pending`(카드 등록 전) → `active` → (만료일) 승인 성공 `active` / 실패 `past_due`(3일·7일 뒤 재시도) → 두 번 더 실패하면 재시도 중단, 카드 변경 시 즉시 재시도 → `canceled`(기간 끝까지 이용) → `expired`.
- 확장은 하루 한 번 `/v1/license`를 부른다. 서버가 죽어도 7일은 마지막 상태를 유지하므로 배포 몇 분 중단은 사용자에게 보이지 않는다.
- 사람이 처리하는 것: 7일 지난 환불 요청(토스 대시보드에서 수동 취소 후 `UPDATE subscriptions SET status='expired'`), 세금계산서 발행 요청, 이메일 변경(customers.email 수정).
- 로그에 카드번호·빌링키·install_id 전체는 찍지 않는다. `raw` 컬럼의 토스 응답에는 마스킹된 카드번호만 들어 있다.
- 백업: Railway Postgres 자동 백업 켜기(Settings → Backups). 빌링키가 여기 있으므로 DB를 잃으면 모든 갱신이 멈춘다.

## 로컬에서 돌려보기

```
cd server && npm install
# Postgres가 있으면
DATABASE_URL_TEST=postgresql://user@localhost:5432/donna_test npm test
# 서버
cp .env.example .env  # 값 채우기
node --env-file=.env src/index.js
```
