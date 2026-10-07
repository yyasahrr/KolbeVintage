# بازممیزی نیازمندی‌ها (Prompt 4 §174-§176)

منابع: `docs/KOLBE_REQUIREMENTS_1-356_FA.md` و `docs/IMPLEMENTATION_173-356_FA.md` + متن Master Prompt 4.
وضعیت‌ها: **DONE** (کد+داده+API+UI+تست)، **PARTIAL**، **NOT DONE**، **SUPERSEDED**، **N/A**.
ممیزی به تفکیک دامنه است؛ شماره‌های § به Master Prompt 4 ارجاع دارند. شواهد = فایل/تست واقعی.

## 1. معماری و Consolidation (§11-§14)
| مورد | وضعیت | شواهد |
|---|---|---|
| یک قابلیت = یک ورودی سایدبار؛ حذف سطوح تکراری | DONE | admin.tsx: finance = یک `FinanceOpsPanel`؛ CRM = ۴ تب؛ tabهای legacy redirect |
| حذف UI قدیمی فقط پس از مهاجرت/جست‌وجوی مرجع | DONE | CrmPanel حذف پس از zero-ref search (ca20f7f)؛ UsersDirectory منتقل به تنظیمات |
| هیچ قابلیت backend حذف نشده | DONE | endpointهای crm قدیمی برقرارند؛ فقط UI جمع شد |

## 2. مرکز مالی (§15-§39)
| مورد | وضعیت | شواهد |
|---|---|---|
| IA شش‌دامنه‌ای | DONE | finance-ops.tsx GROUPS (95fa7e6) |
| داشبورد business-facing بدون بدهی مشتری/VIP credit | DONE | FinanceDashboard — هیچ منبع customer-debt ندارد |
| مالی Marketplace از دادهٔ canonical | DONE | /admin/finance/suppliers + statement V2 از supplier_child_payables |
| درآمدها و خدمات جانبی صادقانه | DONE | /admin/finance/revenue-streams؛ fee streams «پشتیبانی‌شده · غیرفعال» (§41) |
| Supplier Finance 360 بدون تب برداشت | DONE | finance-ops.tsx — withdrawal فقط برچسب «قدیمی» در رویدادها |
| تب‌های تسویه §26 | DONE | settlement-center.tsx (Prompt 3) زیر «پرداخت و تسویه» |
| فرم واریز دستی §29 + ضد-auto-payout §30 | DONE | settlement.test.ts: zero %payout% outbox؛ CHECK schema |
| برداشت قدیمی فقط‌خواندنی §31؛ پیش‌پرداخت بایگانی §32 | DONE | تب «تاریخچه (قدیمی)» و AdvancesTab read-only |
| reconciliation صادقانه §33-§35 | DONE | provider_reconciliations (api/statement/manual) |
| سیاست حمل زیر تنظیمات مالی §36-§39 | DONE | تب shipping + نسخه‌دار/snapshot (065) |

## 3. پرو مجازی (§40-§47) — Prompt 4 C4
| مورد | وضعیت | شواهد |
|---|---|---|
| بسته/سهمیه قابل تنظیم ادمین (نه هاردکد) | DONE | migration 066 + admin CRUD + UI؛ tryon.test.ts |
| پرداخت→اعتبار→مصرف با تراکنش canonical | DONE | payment_intents purpose=tryon؛ grant در applyVerifiedPayment |
| exactly-once §199 | DONE | تست replay=duplicate، grant یک‌بار (171/171) |
| درآمد واقعی + هزینه صادقانه §45-§46 | DONE | /admin/tryon/finance: costStatus؛ NULL = Not Connected |
| fee streams دسته مجاز ≠ کسر فعال §41 | DONE | revenue-streams: supported/enabled تفکیک؛ هیچ کسری فعال نیست |

## 4. حسابداری (§48-§55)
| مورد | وضعیت | شواهد |
|---|---|---|
| لایه حسابداری زیر «حسابداری» | DONE | GL/periods/adjustments/events یک‌جا |
| گزارش‌های فراتر از دادهٔ موجود | PARTIAL — DATA MODEL INCOMPLETE (§49) | گزارش‌هایی مثل P&L کامل با COGS واقعی پشتیبانی نمی‌شوند و همین‌طور برچسب می‌خورند |
| یک سیستم audit §54 | DONE | audit_logs یکتا |

## 5. بازبینی محصول (§56-§63) — C5
| مورد | وضعیت | شواهد |
|---|---|---|
| دومرحله‌ای + فعل‌های صریح | DONE | marketplace-review-panel.tsx (ca20f7f) |
| تأیید هرگز موجودی نمی‌سازد (تست رگرسیون) | DONE | crm-hub.test.ts «approval never mutates stock» |
| دلایل مشترک + snapshot | DONE | review_reasons + product_reviews (reason/note ذخیره) |

## 6. WorkspaceModal (§64-§67)
| مورد | وضعیت | شواهد |
|---|---|---|
| ویرایشگرهای بزرگ در WorkspaceModal | DONE | ویرایشگر محصول (P1)، Statement V2 (537e2ce) |
| همه drawerهای قدیمی | PARTIAL | drawerهای کوچک کم‌اهمیت (مثلاً جزئیات سفارش) تغییر داده نشدند — ریسک UX پایین، redesign ممنوع بود (§141) |

## 7. پروموشن (§68-§79)
وضعیت کلی: **DONE در Prompt 2/3** و در Prompt 4 دوباره‌سازی نشد (مطابق دستور). یک موتور، ماتریس exact-variant، festival authority، اقساط server-resolved، BNPL=بدهی provider. شواهد: promo/wholesale tests سبز در 171/171.

## 8. اسناد مالی V2 (§80-§92)
| مورد | وضعیت | شواهد |
|---|---|---|
| PDF سرور canonical؛ فاکتور A4 V2 | DONE (P3) | pdf.ts + pdf.test.ts |
| Statement تأمین‌کننده V2 §87-§90 | DONE | 537e2ce: موقعیت شش‌بخشی + شواهد پرداخت |
| QA بصری PDF | **NOT RUN** | محیط بدون مرورگر/نمایشگر — صادقانه گزارش شد |

## 9. CRM (§93-§111)
| مورد | وضعیت | شواهد |
|---|---|---|
| یک هاب، ۴ تب | DONE | admin.tsx (ca20f7f) |
| migrate-or-remove legacy §109 | DONE | CrmPanel حذف (superseded: CrmCenter + rules + مرکز اتوماسیون)؛ UsersDirectory→تنظیمات |
| باگ قرارداد consent §100 | DONE | buyer360.ts reason پذیرفته + تست رگرسیون |
| VIP بدون credit §102 | DONE | هیچ مدل اعتباری وجود ندارد |
| CRM تأمین‌کننده: موجود نزد کلبه/ظرفیت اعلامی/در جریان سفارش §106 | DONE (P1-P3) | crm-suppliers-panel + supplier360 |

## 10. بومی‌سازی (§112-§121)
| مورد | وضعیت | شواهد |
|---|---|---|
| برچسب‌های مالی canonical §113 | DONE | finance-ops/settlement-center/supplier-wallet همگی واژگان §113 |
| UI فارسی بدون status خام | PARTIAL | سطح‌های اصلی label-map دارند؛ fallbackهای `?? status` در جداول فرعی ممکن است کد خام نشان دهند — sweep کامل پیکسل‌به‌پیکسل بدون مرورگر ممکن نبود |
| ریال backend / تومان UI | DONE | قرارداد سراسری ÷۱۰ |
| allowedActions سمت سرور §122 | PARTIAL (P2/P3) | در OMS/تسویه اعمال شده؛ همه ماژول‌های قدیمی مهاجرت نکرده‌اند |

## 11. امنیت (§123-§135)
DONE برای RBAC endpointهای جدید، archive-not-delete، عدم ویرایش مستقیم موجودی؛ شواهد در prompt4-security-invariants.md. pen-test دستی: NOT RUN.

## 12. تست و QA (§156-§171, §208-§219)
| مورد | وضعیت |
|---|---|
| ماتریس رگرسیون backend (171 embedded + 102 contract + migrations fresh/upgrade) | DONE — خروجی واقعی در گزارش نهایی |
| ده سفر QA §208-§219 در مرورگر | **NOT RUN** (§225) — پوشش معادل API-level در تست‌ها |
| QA بصری PDF | **NOT RUN** |

## 13. موارد N/A / SUPERSEDED
- Withdrawal به‌عنوان قابلیت فعال: **SUPERSEDED** توسط تسویه زمان‌بندی‌شده (فقط Legacy Withdrawal).
- کیف‌پول به‌عنوان source of truth: **SUPERSEDED** توسط ledger (projection باقی است).
- CrmPanel/اتوماسیون ساده CRM (UI): **SUPERSEDED** توسط CRM rules + مرکز اتوماسیون؛ API باقی است.
- پیش‌پرداخت (advance) ایجاد جدید: **SUPERSEDED**؛ تاریخچه بایگانی.
