-- Fine-grained access control and ticket workflow support (items 26, 31, 45).
ALTER TABLE tickets ADD COLUMN first_response_at timestamptz;
ALTER TABLE tickets ADD COLUMN resolved_at timestamptz;

CREATE TABLE ticket_attachments (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id uuid REFERENCES ticket_messages(id) ON DELETE CASCADE,
  title text NOT NULL,
  file_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_attachments_ticket_idx ON ticket_attachments(ticket_id, created_at);

INSERT INTO permissions(code, title) VALUES
  ('customers:read', 'مشاهده اطلاعات مشتریان'), ('reports:read', 'مشاهده گزارش‌ها'),
  ('finance:read', 'مشاهده اطلاعات مالی'), ('tickets:read', 'مشاهده تیکت‌ها'),
  ('orders:edit', 'ویرایش سفارش‌ها'), ('access:manage', 'مدیریت دسترسی‌ها')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'access:manage'),
  ('finance', 'finance:read'), ('finance', 'reports:read'),
  ('operations', 'orders:edit'), ('operations', 'customers:read'),
  ('support', 'tickets:read'), ('support', 'customers:read')
ON CONFLICT DO NOTHING;
