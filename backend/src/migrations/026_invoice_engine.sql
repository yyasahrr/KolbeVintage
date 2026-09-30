-- 026 — Unified invoice engine (items 25-34)
--
-- Owner: agent B — Supplier 360 / finance branch (reserved range 025-034).
-- Runs after 025; depends on 004_invoices (invoices, invoice_events) and
-- 013_shipping_returns_files (files) from the shared base.
--
-- Scope: server-stored versioned invoice templates, document kinds and lifecycle,
-- the snapshot a document is issued with (history is never rewritten), the
-- permission-gated PDF reference and the default template set.

-- ----------------------------------------------------------- items 27-34 ----
-- Admin-defined invoice templates, versioned. A document keeps the version it
-- was issued with, so changing a template never rewrites history.
CREATE TABLE invoice_templates (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,40}$'),
  title text NOT NULL,
  kind text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  current_version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invoice_template_versions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES invoice_templates(id),
  version integer NOT NULL,
  definition jsonb NOT NULL,
  change_note text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

ALTER TABLE invoices ADD COLUMN template_version_id uuid REFERENCES invoice_template_versions(id);
ALTER TABLE invoices ADD COLUMN snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE invoices ADD COLUMN pdf_file_id uuid REFERENCES files(id);
ALTER TABLE invoices ADD COLUMN party_user_id uuid REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN order_reference text;
ALTER TABLE invoices ADD COLUMN issued_at timestamptz;
ALTER TABLE invoices ADD COLUMN voided_at timestamptz;
ALTER TABLE invoices ADD COLUMN refunded_at timestamptz;

-- Lifecycle (item 32): draft → issued → partially_paid → paid, plus cancelled,
-- refunded, void and the existing credited/revised chain.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'issued',
  'partially_paid', 'paid', 'cancelled', 'credited', 'revised', 'refunded', 'void'));

-- Document kinds (item 26) — one engine, several legal documents.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_kind_check CHECK (kind IN ('retail_sale', 'wholesale_sale',
  'vip_sale', 'supplier_purchase', 'supplier_statement', 'settlement', 'refund', 'return_credit',
  'credit_note', 'installment_plan', 'other'));
ALTER TABLE invoice_events DROP CONSTRAINT IF EXISTS invoice_events_event_type_check;
ALTER TABLE invoice_events ADD CONSTRAINT invoice_events_event_type_check CHECK (event_type IN ('created',
  'amount_corrected', 'discount_added', 'payment', 'partial_payment', 'cancelled', 'refunded',
  'status_changed', 'credit_note', 'revised', 'issued', 'voided', 'rendered', 'snapshot'));

-- Refunds/credit notes are separate documents that point at the original invoice.
ALTER TABLE invoices ADD COLUMN credit_note_for uuid REFERENCES invoices(id);
ALTER TABLE invoices ADD COLUMN refund_reference text;
CREATE INDEX invoices_party_idx ON invoices(party_user_id, created_at DESC);

-- Default invoice templates (version 1) so the engine works out of the box and
-- admins can extend them without touching code.
INSERT INTO invoice_templates(id, code, title, kind, current_version) VALUES
  ('7e3f8c50-0001-4a11-8c01-000000000001', 'official-invoice', 'فاکتور رسمی فروش', 'retail_sale', 1),
  ('7e3f8c50-0002-4a11-8c02-000000000002', 'wholesale-invoice', 'فاکتور فروش عمده', 'wholesale_sale', 1),
  ('7e3f8c50-0003-4a11-8c03-000000000003', 'supplier-statement', 'صورت‌حساب تأمین‌کننده', 'supplier_statement', 1),
  ('7e3f8c50-0004-4a11-8c04-000000000004', 'settlement-statement', 'صورت‌حساب تسویه', 'settlement', 1)
ON CONFLICT (code) DO NOTHING;

INSERT INTO invoice_template_versions(id, template_id, version, definition, change_note) VALUES
  ('8f4a9d60-0001-4a11-8c01-000000000001', '7e3f8c50-0001-4a11-8c01-000000000001', 1, '{
     "paperSize": "A4",
     "accent": { "r": 0.76, "g": 0.38, "b": 0.23 },
     "sections": [
       { "id": "seller", "type": "keyValues", "title": "فروشنده", "order": 1, "visible": true,
         "fields": ["seller.name", "seller.address", "seller.phone"] },
       { "id": "buyer", "type": "keyValues", "title": "خریدار", "order": 2, "visible": true,
         "fields": ["customer.name", "customer.phone", "customer.address"] },
       { "id": "items", "type": "table", "title": "اقلام", "order": 3, "visible": true },
       { "id": "totals", "type": "totals", "order": 4, "visible": true },
       { "id": "payment", "type": "keyValues", "title": "اطلاعات پرداخت", "order": 5, "visible": true,
         "fields": ["payment.method", "invoice.paid", "invoice.remaining"] },
       { "id": "notes", "type": "paragraph", "title": "توضیحات", "order": 6, "visible": true,
         "text": "{{invoice.notes}}" },
       { "id": "terms", "type": "paragraph", "title": "شرایط", "order": 7, "visible": true,
         "text": "این سند به‌صورت سروری از دفتر کل کلبه وینتج تولید شده است." },
       { "id": "signature", "type": "signature", "order": 8, "visible": true,
         "lines": ["مهر و امضای فروشنده", "امضای خریدار"] }
     ],
     "footer": "کلبه وینتج — سامانه مالی"
   }'::jsonb, 'قالب پیش‌فرض فاکتور رسمی'),
  ('8f4a9d60-0002-4a11-8c02-000000000002', '7e3f8c50-0002-4a11-8c02-000000000002', 1, '{
     "paperSize": "A4",
     "accent": { "r": 0.16, "g": 0.24, "b": 0.4 },
     "sections": [
       { "id": "seller", "type": "keyValues", "title": "فروشنده", "order": 1, "visible": true,
         "fields": ["seller.name", "seller.address"] },
       { "id": "buyer", "type": "keyValues", "title": "خریدار عمده", "order": 2, "visible": true,
         "fields": ["customer.name", "customer.phone", "customer.address", "order.reference"] },
       { "id": "items", "type": "table", "title": "اقلام سفارش", "order": 3, "visible": true },
       { "id": "totals", "type": "totals", "order": 4, "visible": true },
       { "id": "payment", "type": "keyValues", "title": "پرداخت", "order": 5, "visible": true,
         "fields": ["payment.method", "invoice.paid", "invoice.remaining", "invoice.dueDate"] },
       { "id": "signature", "type": "signature", "order": 6, "visible": true,
         "lines": ["مهر فروشنده", "امضای خریدار"] }
     ],
     "footer": "کلبه وینتج — واحد عمده"
   }'::jsonb, 'قالب پیش‌فرض فاکتور عمده'),
  ('8f4a9d60-0003-4a11-8c03-000000000003', '7e3f8c50-0003-4a11-8c03-000000000003', 1, '{
     "paperSize": "A4",
     "accent": { "r": 0.16, "g": 0.35, "b": 0.3 },
     "sections": [
       { "id": "supplier", "type": "keyValues", "title": "تأمین‌کننده", "order": 1, "visible": true,
         "fields": ["supplier.name", "supplier.legalName", "supplier.iban"] },
       { "id": "statement", "type": "table", "title": "گردش حساب", "order": 2, "visible": true },
       { "id": "totals", "type": "totals", "order": 3, "visible": true },
       { "id": "terms", "type": "paragraph", "title": "توضیحات", "order": 4, "visible": true,
         "text": "{{invoice.notes}}" }
     ],
     "footer": "کلبه وینتج — صورت‌حساب تأمین‌کننده"
   }'::jsonb, 'قالب پیش‌فرض صورت‌حساب تأمین‌کننده'),
  ('8f4a9d60-0004-4a11-8c04-000000000004', '7e3f8c50-0004-4a11-8c04-000000000004', 1, '{
     "paperSize": "A4",
     "accent": { "r": 0.5, "g": 0.3, "b": 0.1 },
     "sections": [
       { "id": "supplier", "type": "keyValues", "title": "تأمین‌کننده", "order": 1, "visible": true,
         "fields": ["supplier.name", "supplier.iban"] },
       { "id": "items", "type": "table", "title": "سفارش‌های تسویه", "order": 2, "visible": true },
       { "id": "totals", "type": "totals", "order": 3, "visible": true },
       { "id": "signature", "type": "signature", "order": 4, "visible": true,
         "lines": ["مهر و امضای مالی کلبه", "امضای تأمین‌کننده"] }
     ],
     "footer": "کلبه وینتج — سند تسویه"
   }'::jsonb, 'قالب پیش‌فرض سند تسویه')
ON CONFLICT (template_id, version) DO NOTHING;
