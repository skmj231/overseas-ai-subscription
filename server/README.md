# donna-plus-api

Donna Plus 결제·라이선스 서버. 설계는 `../docs/PLUS-SERVER.md`, 배포 순서는 `../docs/PLUS-LAUNCH.md`.

```
npm install
DATABASE_URL_TEST=postgresql://user@localhost:5432/donna_test npm test   # 정책 단위 테스트 + Postgres 통합 테스트
cp .env.example .env && node --env-file=.env src/index.js               # 로컬 실행
```

- `src/policy.js` 상품·날짜·재시도 규칙 (순수 함수)
- `src/service.js` 결제 세션 → 빌링키 → 승인 → 라이선스 → 관리 → 스케줄러
- `src/app.js` HTTP 라우트·CORS·rate limit
- `src/toss.js` 토스페이먼츠 빌링 API, `src/mail.js` Resend, `src/crypto.js` 빌링키 암호화·토큰
- `sql/` 스키마(부팅 때 자동 적용)
