-- Donna Plus · 스키마. 부팅 때마다 실행해도 안전하다(IF NOT EXISTS).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS installations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid REFERENCES customers(id) ON DELETE SET NULL,
  public_install_id  text NOT NULL UNIQUE,
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS installations_customer_idx ON installations(customer_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan                   text NOT NULL DEFAULT 'plus_3m',
  -- pending(빌링키 발급 전) | active | canceled(기간 끝까지 이용) | past_due | expired | incomplete(첫 승인 실패)
  status                 text NOT NULL DEFAULT 'pending',
  billing_key_encrypted  text,
  card_summary           text,           -- "신한 **** 1234" 같은 표시용
  toss_customer_key      text NOT NULL,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  period_no              int NOT NULL DEFAULT 0,      -- 몇 번째 회차까지 결제됐나
  fail_count             int NOT NULL DEFAULT 0,
  first_failed_at        timestamptz,
  next_retry_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_due_idx ON subscriptions(status, current_period_end);

CREATE TABLE IF NOT EXISTS payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  order_id         text NOT NULL UNIQUE,
  payment_key      text,
  amount           int NOT NULL,
  status           text NOT NULL,     -- done | failed | canceled(환불)
  approved_at      timestamptz,
  receipt_url      text,
  fail_reason      text,
  raw              jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_sub_idx ON payments(subscription_id);

-- 메일 중복 방지, 감사 기록
CREATE TABLE IF NOT EXISTS audit (
  id       bigserial PRIMARY KEY,
  subject  text NOT NULL,      -- sub:<id> / cust:<id>
  action   text NOT NULL,      -- renew_reminder_7d 등
  at       timestamptz NOT NULL DEFAULT now(),
  meta     jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS audit_once_idx ON audit(subject, action) WHERE action LIKE 'once:%';

-- 결제 세션 (plus.html → 토스 결제창 사이)
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  install_id   text,
  purpose      text NOT NULL DEFAULT 'new',   -- new | change_card
  return_url   text,
  cancel_url   text,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
