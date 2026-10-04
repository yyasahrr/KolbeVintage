# پیگیری اصلاح محصول و WMS

مبنا: Arena `c49bb6e`؛ شاخه `codex/product-wms-wholesale-remediation`؛ تاریخ 2026-10-04.

| ID | Domain / Requirement | Current state / Root cause | Change / Files | Migration | Tests | Browser | Status |
|---|---|---|---|---|---|---|---|
| CAT-04 | category validation روی edit | PATCH مشخصات اجباری را حذف می‌کرد؛ بازتولید 200 به‌جای 400 | validate merged category/specs/active variants؛ backend/src/catalog.ts، product-wms-foundation.test.ts | ندارد | exact reproduction ابتدا FAIL سپس PASS؛ persisted specs ثابت؛ rename PASS | NOT VERIFIED | CODE_COMPLETE |
| CAT-01 | canonical category | legacy validator هم‌زمان با category فعال بود | schema دسته بر legacy validator تقدم دارد؛ create/variant/PATCH | ندارد در این گام؛ همگرایی identity باقی است | category regression PASS؛ broader NOT VERIFIED | NOT VERIFIED | IN_PROGRESS |
| DISCOVER | gap matrix | بررسی source/DTO/schema/tests و frozen QA | CODEX_PRODUCT_WMS_GAP_MATRIX.md؛ 39 ردیف | ندارد | runtime discovery در جریان | NOT VERIFIED | CODE_COMPLETE |

پشتهٔ مستقل توسعه: PGlite روی 55459 و API روی 4011؛ پورت 55449 از قبل اشغال بود و سرویس موجود دست‌کاری نشد. migrationهای 001 تا 068 در DB تازه اعمال شدند. تغییرات کش node_modules متعلق به وضعیت اولیه‌اند و commit نمی‌شوند.
