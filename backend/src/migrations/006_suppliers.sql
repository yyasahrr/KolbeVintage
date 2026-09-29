-- Complete supplier profiles with versioning and managed cooperation form
-- (items 5, 6, 43).
ALTER TABLE supplier_profiles ADD COLUMN person_type text NOT NULL DEFAULT 'legal'
  CHECK (person_type IN ('individual', 'legal'));
ALTER TABLE supplier_profiles ADD COLUMN registration_number text;
ALTER TABLE supplier_profiles ADD COLUMN tax_info text;
ALTER TABLE supplier_profiles ADD COLUMN mobile varchar(20);
ALTER TABLE supplier_profiles ADD COLUMN email text;
ALTER TABLE supplier_profiles ADD COLUMN website text;
ALTER TABLE supplier_profiles ADD COLUMN office_address text;
ALTER TABLE supplier_profiles ADD COLUMN warehouse_address text;
ALTER TABLE supplier_profiles ADD COLUMN bank_name text;
ALTER TABLE supplier_profiles ADD COLUMN account_number text;
ALTER TABLE supplier_profiles ADD COLUMN account_holder text;
ALTER TABLE supplier_profiles ADD COLUMN product_categories text[] NOT NULL DEFAULT '{}';
ALTER TABLE supplier_profiles ADD COLUMN supply_capacity text;
ALTER TABLE supplier_profiles ADD COLUMN lead_time_days integer CHECK (lead_time_days >= 0);
ALTER TABLE supplier_profiles ADD COLUMN min_order_quantity integer CHECK (min_order_quantity >= 0);
ALTER TABLE supplier_profiles ADD COLUMN shipping_cities text[] NOT NULL DEFAULT '{}';
ALTER TABLE supplier_profiles ADD COLUMN shipping_methods text[] NOT NULL DEFAULT '{}';
ALTER TABLE supplier_profiles ADD COLUMN collaboration_start_date date;
ALTER TABLE supplier_profiles ADD COLUMN contract_status text NOT NULL DEFAULT 'none'
  CHECK (contract_status IN ('none', 'draft', 'active', 'suspended', 'terminated'));
ALTER TABLE supplier_profiles ADD COLUMN settlement_terms text;
ALTER TABLE supplier_profiles ADD COLUMN sla text;

-- Every profile change keeps an immutable snapshot (versioning + audit trail).
CREATE TABLE supplier_profile_versions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text,
  changed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version)
);

CREATE TABLE supplier_documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  doc_type text NOT NULL CHECK (doc_type IN ('license', 'company_doc', 'bank_doc', 'contract', 'identity', 'other')),
  title text NOT NULL,
  file_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_documents_user_idx ON supplier_documents(user_id, created_at DESC);

-- Admin-defined cooperation form (item 6): the fields are managed from the panel.
CREATE TABLE cooperation_form_fields (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  field_type text NOT NULL CHECK (field_type IN ('text', 'textarea', 'number', 'select', 'file', 'boolean', 'date')),
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cooperation_requests (
  id uuid PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewing', 'approved', 'rejected')),
  user_id uuid REFERENCES users(id),
  reviewer_id uuid REFERENCES users(id),
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cooperation_requests_status_idx ON cooperation_requests(status, created_at DESC);

INSERT INTO cooperation_form_fields(id, code, label, field_type, required, options, position) VALUES
  (gen_random_uuid(), 'brand_name', 'نام تجاری', 'text', true, '[]'::jsonb, 1),
  (gen_random_uuid(), 'legal_name', 'نام حقوقی', 'text', true, '[]'::jsonb, 2),
  (gen_random_uuid(), 'person_type', 'نوع شخصیت', 'select', true, '["individual","legal"]'::jsonb, 3),
  (gen_random_uuid(), 'national_id', 'شناسه ملی', 'text', true, '[]'::jsonb, 4),
  (gen_random_uuid(), 'registration_number', 'شماره ثبت', 'text', false, '[]'::jsonb, 5),
  (gen_random_uuid(), 'economic_code', 'کد اقتصادی', 'text', false, '[]'::jsonb, 6),
  (gen_random_uuid(), 'phone', 'شماره تماس', 'text', true, '[]'::jsonb, 7),
  (gen_random_uuid(), 'mobile', 'موبایل', 'text', true, '[]'::jsonb, 8),
  (gen_random_uuid(), 'email', 'ایمیل', 'text', false, '[]'::jsonb, 9),
  (gen_random_uuid(), 'website', 'وب‌سایت', 'text', false, '[]'::jsonb, 10),
  (gen_random_uuid(), 'office_address', 'آدرس دفتر', 'textarea', true, '[]'::jsonb, 11),
  (gen_random_uuid(), 'warehouse_address', 'آدرس انبار', 'textarea', false, '[]'::jsonb, 12),
  (gen_random_uuid(), 'bank_name', 'نام بانک', 'text', true, '[]'::jsonb, 13),
  (gen_random_uuid(), 'iban', 'شماره شبا', 'text', true, '[]'::jsonb, 14),
  (gen_random_uuid(), 'account_holder', 'صاحب حساب', 'text', true, '[]'::jsonb, 15),
  (gen_random_uuid(), 'product_categories', 'دسته محصولات', 'text', true, '[]'::jsonb, 16),
  (gen_random_uuid(), 'supply_capacity', 'ظرفیت تأمین', 'textarea', false, '[]'::jsonb, 17),
  (gen_random_uuid(), 'lead_time_days', 'زمان آماده‌سازی (روز)', 'number', false, '[]'::jsonb, 18),
  (gen_random_uuid(), 'min_order_quantity', 'حداقل سفارش', 'number', false, '[]'::jsonb, 19),
  (gen_random_uuid(), 'shipping_cities', 'شهرهای ارسال', 'text', false, '[]'::jsonb, 20),
  (gen_random_uuid(), 'shipping_methods', 'روش‌های ارسال', 'text', false, '[]'::jsonb, 21),
  (gen_random_uuid(), 'settlement_terms', 'شرایط تسویه', 'textarea', false, '[]'::jsonb, 22),
  (gen_random_uuid(), 'sla', 'توافق‌نامه سطح خدمات', 'textarea', false, '[]'::jsonb, 23),
  (gen_random_uuid(), 'notes', 'توضیحات', 'textarea', false, '[]'::jsonb, 24)
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions(code, title) VALUES
  ('cooperation:manage', 'مدیریت درخواست‌های همکاری')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'cooperation:manage')
ON CONFLICT DO NOTHING;
