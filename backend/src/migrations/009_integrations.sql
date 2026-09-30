-- Integration center with protected secrets and delivery logs (item 23).
CREATE TABLE integrations (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  category text NOT NULL CHECK (category IN ('payment', 'sms', 'shipping', 'marketplace', 'finance', 'crm', 'other')),
  provider text NOT NULL DEFAULT 'generic',
  environment text NOT NULL DEFAULT 'test' CHECK (environment IN ('test', 'production')),
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext bytea,
  secret_iv bytea,
  secret_tag bytea,
  secret_hint text,
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'error')),
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  webhook_url text,
  callback_url text,
  sync_status text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'synced', 'failed')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE integration_logs (
  id uuid PRIMARY KEY,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'failure', 'retry', 'rejected')),
  http_status integer,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_logs_idx ON integration_logs(integration_id, created_at DESC);

-- Notification routing by event type, role and priority (item 24).
CREATE TABLE notification_routes (
  id uuid PRIMARY KEY,
  event_type text NOT NULL UNIQUE,
  title text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  channels text[] NOT NULL DEFAULT '{in_app}',
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO notification_routes(id, event_type, title, roles, priority, channels) VALUES
  (gen_random_uuid(), 'order.created', 'سفارش جدید', '{operations,admin}', 'normal', '{in_app,sms}'),
  (gen_random_uuid(), 'order.paid', 'پرداخت سفارش', '{operations,finance,admin}', 'normal', '{in_app}'),
  (gen_random_uuid(), 'order.wholesale', 'سفارش عمده جدید', '{operations,finance,admin}', 'high', '{in_app,sms}'),
  (gen_random_uuid(), 'payment.failed', 'خطای پرداخت', '{finance,admin}', 'high', '{in_app}'),
  (gen_random_uuid(), 'cooperation_request.created', 'درخواست همکاری جدید', '{admin}', 'normal', '{in_app}'),
  (gen_random_uuid(), 'supplier.request', 'درخواست تأمین‌کننده', '{operations,admin}', 'normal', '{in_app}'),
  (gen_random_uuid(), 'ticket.created', 'تیکت جدید', '{support,admin}', 'high', '{in_app}'),
  (gen_random_uuid(), 'ticket.status_changed', 'تغییر وضعیت تیکت', '{support,admin}', 'normal', '{in_app}'),
  (gen_random_uuid(), 'inventory.low', 'کمبود موجودی', '{operations,admin}', 'high', '{in_app}'),
  (gen_random_uuid(), 'integration.error', 'خطای اتصال', '{admin}', 'critical', '{in_app,sms}'),
  (gen_random_uuid(), 'settlement.created', 'تسویه جدید', '{finance,admin}', 'normal', '{in_app}'),
  (gen_random_uuid(), 'invoice.payment', 'پرداخت فاکتور', '{finance,admin}', 'normal', '{in_app}'),
  (gen_random_uuid(), 'campaign.event', 'رویداد کمپین', '{admin}', 'low', '{in_app}'),
  (gen_random_uuid(), 'crm.event', 'رویداد CRM', '{admin}', 'low', '{in_app}'),
  (gen_random_uuid(), 'withdrawal.requested', 'درخواست برداشت', '{finance,admin}', 'high', '{in_app}'),
  (gen_random_uuid(), 'withdrawal.status_changed', 'تغییر وضعیت برداشت', '{finance,admin}', 'normal', '{in_app}')
ON CONFLICT (event_type) DO NOTHING;

INSERT INTO permissions(code, title) VALUES
  ('notifications:manage', 'مدیریت مسیر اعلان‌ها')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'notifications:manage')
ON CONFLICT DO NOTHING;
