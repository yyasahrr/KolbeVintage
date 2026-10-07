-- Console domains: user restrictions, SMS campaigns, membership admin support.
CREATE TABLE user_restrictions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  scope text NOT NULL CHECK (scope IN ('purchase','ticket','return','withdrawal','all')),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  created_by uuid REFERENCES users(id),
  lifted_by uuid REFERENCES users(id),
  lifted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_restrictions_active_idx ON user_restrictions(user_id, scope) WHERE status = 'active';
CREATE UNIQUE INDEX user_restrictions_one_active_scope ON user_restrictions(user_id, scope) WHERE status = 'active';

CREATE TABLE sms_campaigns (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  message text NOT NULL,
  audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all','retail','wholesale','vip','suppliers')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','queued','sent','failed')),
  scheduled_at timestamptz,
  provider text,
  provider_reference text,
  failure_reason text,
  recipients integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX sms_campaigns_status_idx ON sms_campaigns(status, scheduled_at);

-- Repair legacy non-v4 shipping method ids (they failed API UUID validation on checkout).
UPDATE orders SET shipping_method_id = '5b1c9a10-0001-4a11-8c01-000000000001' WHERE shipping_method_id = '00000000-0000-0000-0000-000000000001';
UPDATE orders SET shipping_method_id = '5b1c9a10-0002-4a11-8c02-000000000002' WHERE shipping_method_id = '00000000-0000-0000-0000-000000000002';
UPDATE orders SET shipping_method_id = '5b1c9a10-0003-4a11-8c03-000000000003' WHERE shipping_method_id = '00000000-0000-0000-0000-000000000003';
UPDATE shipping_methods SET id = '5b1c9a10-0001-4a11-8c01-000000000001' WHERE id = '00000000-0000-0000-0000-000000000001';
UPDATE shipping_methods SET id = '5b1c9a10-0002-4a11-8c02-000000000002' WHERE id = '00000000-0000-0000-0000-000000000002';
UPDATE shipping_methods SET id = '5b1c9a10-0003-4a11-8c03-000000000003' WHERE id = '00000000-0000-0000-0000-000000000003';

-- Permissions for the console domains
INSERT INTO permissions(code, title) VALUES
  ('admin:read', 'مشاهده داشبورد مدیریت'),
  ('memberships:manage', 'مدیریت عضویت‌ها'),
  ('campaigns:manage', 'مدیریت کمپین پیامک'),
  ('restrictions:manage', 'مدیریت محدودیت کاربران')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'admin:read'), ('admin', 'memberships:manage'), ('admin', 'campaigns:manage'), ('admin', 'restrictions:manage'),
  ('operations', 'admin:read'), ('support', 'admin:read'),
  ('finance', 'memberships:manage')
ON CONFLICT DO NOTHING;
