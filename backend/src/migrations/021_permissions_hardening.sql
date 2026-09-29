-- Permissions for the requirement groups delivered in this stage (15-24, 85-121, 136-143, 313-314).
INSERT INTO permissions(code, title) VALUES
  ('buyers:manage', 'مدیریت خریداران ۳۶۰ و اعتبار'),
  ('automation:manage', 'مدیریت مرکز اتوماسیون'),
  ('tracking:manage', 'مدیریت پیگیری مرسولات'),
  ('reviews:moderate', 'مدیریت و بازبینی نظرات محصول'),
  ('recommendations:manage', 'مدیریت موتور پیشنهاد'),
  ('media:manage', 'مدیریت رسانه و ویدیوی محصول'),
  ('profile:manage', 'اصلاح پروفایل کاربران'),
  ('security:manage', 'مدیریت امنیت حساب و 2FA')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(role_code, permission_code) VALUES
  ('admin', 'buyers:manage'), ('admin', 'automation:manage'), ('admin', 'tracking:manage'),
  ('admin', 'reviews:moderate'), ('admin', 'recommendations:manage'), ('admin', 'media:manage'),
  ('admin', 'profile:manage'), ('admin', 'security:manage'),
  ('operations', 'tracking:manage'), ('operations', 'automation:manage'),
  ('support', 'reviews:moderate'), ('support', 'profile:manage'),
  ('finance', 'buyers:manage')
ON CONFLICT DO NOTHING;

-- The automation event catalog (item 86/87) is product state, not code: external
-- workflow builders need to discover which events exist and what they carry.
CREATE TABLE IF NOT EXISTS automation_event_catalog (
  event_type text PRIMARY KEY,
  title text NOT NULL,
  domain text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  description text NOT NULL DEFAULT '',
  payload_example jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO automation_event_catalog(event_type, title, domain, description, payload_example) VALUES
  ('order.created', 'ایجاد سفارش', 'orders', 'سفارش جدید ثبت شد.', '{"orderId":"uuid","reference":"KV-1001"}'),
  ('order.paid', 'پرداخت سفارش', 'orders', 'پرداخت سفارش با تأیید درگاه نهایی شد.', '{"orderId":"uuid","paymentIntentId":"uuid"}'),
  ('order.shipped', 'ارسال سفارش', 'orders', 'سفارش تحویل شرکت حمل شد.', '{"orderId":"uuid","trackingCode":"TPX-1"}'),
  ('order.delivered', 'تحویل سفارش', 'orders', 'سفارش به مشتری تحویل شد.', '{"orderId":"uuid"}'),
  ('product.created', 'ایجاد محصول', 'catalog', 'محصول جدید ساخته شد.', '{"productId":"uuid","status":"draft"}'),
  ('product.reviewed', 'بازبینی محصول', 'catalog', 'نتیجه بازبینی محصول بازارچه ثبت شد.', '{"productId":"uuid","decision":"approved"}'),
  ('customer.created', 'ثبت‌نام مشتری', 'crm', 'کاربر جدید ثبت‌نام کرد.', '{"userId":"uuid"}'),
  ('customer.updated', 'به‌روزرسانی مشتری', 'crm', 'اطلاعات مشتری تغییر کرد.', '{"userId":"uuid","fields":["displayName"]}'),
  ('membership.activated', 'فعال‌سازی عضویت', 'membership', 'عضویت پس از پرداخت تأییدشده فعال شد.', '{"membershipId":"uuid","userId":"uuid"}'),
  ('membership.expiring', 'نزدیک به انقضای عضویت', 'membership', 'کمتر از ۷ روز تا انقضای عضویت باقی است.', '{"membershipId":"uuid","endsAt":"2026-01-01T00:00:00Z"}'),
  ('membership.expired', 'انقضای عضویت', 'membership', 'عضویت منقضی شد.', '{"membershipId":"uuid"}'),
  ('cart.abandoned', 'سبد رهاشده', 'cart', 'سبد خرید بدون تکمیل رها شد.', '{"userId":"uuid","cartValueRial":"1000000"}'),
  ('coupon.used', 'استفاده از کوپن', 'promotion', 'کوپن در سفارش مصرف شد.', '{"couponId":"uuid","orderId":"uuid"}'),
  ('review.created', 'ثبت نظر محصول', 'reviews', 'مشتری نظر و امتیاز ثبت کرد.', '{"reviewId":"uuid","productId":"uuid","rating":5}'),
  ('ticket.created', 'ایجاد تیکت', 'support', 'تیکت پشتیبانی جدید ثبت شد.', '{"ticketId":"uuid"}'),
  ('invoice.issued', 'صدور فاکتور', 'finance', 'فاکتور رسمی صادر شد.', '{"invoiceId":"uuid","number":"INV-1001"}'),
  ('shipment.tracking.updated', 'به‌روزرسانی رهگیری', 'logistics', 'وضعیت مرسوله تغییر کرد.', '{"shipmentId":"uuid","status":"in_transit"}'),
  ('recommendation.purchased', 'خرید از پیشنهاد', 'recommendation', 'محصول پیشنهادی خریداری شد.', '{"slot":"home.for_you","productId":"uuid"}')
ON CONFLICT (event_type) DO NOTHING;

-- Targeted SMS campaigns (requirement 22): the audience may be a CRM segment or
-- a smart label, not only one of the legacy buckets.
ALTER TABLE sms_campaigns DROP CONSTRAINT IF EXISTS sms_campaigns_audience_check;
ALTER TABLE sms_campaigns ADD CONSTRAINT sms_campaigns_audience_check
  CHECK (audience IN ('all', 'retail', 'wholesale', 'vip', 'suppliers')
      OR audience LIKE 'segment:%' OR audience LIKE 'label:%');
