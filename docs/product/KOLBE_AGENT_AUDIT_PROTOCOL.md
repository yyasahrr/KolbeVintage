# پروتکل Agent برای QA کسب‌وکارمحور

این فایل نحوهٔ استفاده از Business Knowledge Pack را تعریف می‌کند.

---

# 1. Agent Role

Agent ترکیبی است از:

- Product QA
- Business Analyst
- UX Reviewer
- Domain Reviewer
- Browser QA
- Debugger
- Remediation Engineer

اما این نقش‌ها باید مرحله‌بندی شوند.

---

# 2. Three-Pass Model

## PASS 1 — DISCOVER

هیچ Production Fix انجام نده.

برای Domain:

- Business purpose را بخوان.
- Current UI/API/Data را Map کن.
- Journeyها را اجرا کن.
- Counterexample بساز.
- Findings را ثبت کن.

سپس `FINDINGS FREEZE`.

## PASS 2 — REMEDIATE

فقط Findings verified را اصلاح کن.

هر Fix:
- کوچک
- Root-cause based
- Domain-scoped
- Regression-covered

## PASS 3 — VERIFY

بدون اتکا به ذهنیت implementation:

- Journey را دوباره اجرا کن.
- Counterexample را دوباره اجرا کن.
- Invariantها را assert کن.
- Responsive/RTL/UI را بررسی کن.
- API/domain state را verify کن.

---

# 3. Finding Types

## BUG
رفتار مورد انتظار وجود دارد اما implementation خراب است.

مثال:
«همه کالاها» 500 می‌دهد.

## UX_DEFECT
کار می‌کند اما استفاده از آن سخت/گمراه‌کننده/ناهماهنگ است.

مثال:
SearchBox در هر صفحه شکل متفاوت دارد.

## DOMAIN_DEFECT
Feature کار می‌کند اما مفهوم دنیای واقعی را کافی مدل نمی‌کند.

مثال:
Size Guide فقط Key/Value است.

## ARCHITECTURE_DEFECT
قابلیت duplicate/misplaced/parallel/source-of-truth-wrong است.

مثال:
دو Category system.

## PRODUCT_DECISION_REQUIRED
چند رفتار معتبر وجود دارد و Product Owner باید انتخاب کند.

---

# 4. Confidence

هر Finding:

```text
HIGH
MEDIUM
LOW
PRODUCT_DECISION_REQUIRED
```

## HIGH
Reproduced + evidence + business rule clear.
Auto-fix allowed.

## MEDIUM
Evidence وجود دارد ولی Root Cause/intent نیاز به verification بیشتر دارد.

## LOW
Observation فقط؛ Fix ممنوع تا verify شود.

---

# 5. Reproduction Contract

هر Finding باید داشته باشد:

```text
Role:
Route:
Precondition/Data:
Action:
Expected:
Actual:
Evidence:
Finding Type:
Severity:
Confidence:
```

---

# 6. Semantic Test

برای هر Feature مهم:

1. آیا دادهٔ واقعی را می‌تواند مدل کند؟
2. آیا فقط Happy Path ساده را پشتیبانی می‌کند؟
3. آیا multidimensional concept به key/value ساده تقلیل یافته؟
4. آیا category variation را پشتیبانی می‌کند؟
5. آیا scale بیشتر feature را می‌شکند؟

---

# 7. Counterexample Test

قبل از PASS کردن Feature بپرس:

> چه نمونه‌ای می‌تواند این طراحی را بشکند؟

حداقل یک Counterexample اجرا کن.

مثال Size Guide:
- T-shirt
- Pants
- Shoes
- Ring

---

# 8. Cross-layer Verification

برای عملیات مهم صرف Toast کافی نیست.

```text
UI Result
→ API Result
→ Domain/Persisted State
```

مثال Transfer:
- UI success
- transfer document status
- source balance
- destination balance
- movement history

---

# 9. Invariant Verification

بعد از هر Fix Domain-specific invariantها را از `KOLBE_DOMAIN_RULES.md` اجرا کن.

مثلاً پس از Pricing fix:

- Product Studio stock را تغییر نداده؟
- Retail/Wholesale inventory قاطی نشده؟
- Festival precedence حفظ شده؟
- Server هنوز price authority است؟

---

# 10. Risk-based Browser Matrix

Critical Flow:
- Desktop + Mobile
- representative tablet
- light/dark sample
- required roles

Low-risk page:
- representative desktop/mobile کافی است.

از ضرب کورکورانهٔ همه Route×Role×Theme×Viewport جلوگیری کن.

---

# 11. UI Measurement

فقط Screenshot impression کافی نیست.

در صورت امکان اندازه‌گیری کن:

- document overflow
- clipped element bounds
- overlap
- control height
- touch target
- hidden action
- table scroll
- modal viewport fit

---

# 12. Deterministic Test State

هر Flow باید Precondition مشخص داشته باشد.

Destructive scenarioها:
- isolated seed/state
- unique test entity
- deterministic ID/reference where practical

تست قبلی نباید تست بعدی را تصادفی خراب کند.

---

# 13. Fix Budget

اگر Fix:

- بیش از یک Domain اصلی را تغییر می‌دهد،
- schema مالی حساس را جابه‌جا می‌کند،
- migration بزرگ می‌خواهد،
- رفتار Business را تغییر می‌دهد،

برچسب:

```text
CROSS_DOMAIN_CHANGE
```

و ابتدا impact analysis انجام بده.

---

# 14. Rollback Rule

اگر Fix باعث Regression با Severity بالاتر شد:

- Fix chain نساز.
- تغییر خودت را rollback/revert کن.
- Root Cause را دوباره بررسی کن.

---

# 15. Industry Benchmark Rule

الگوهای Shopify/SAP/WMS/CRM رایج فقط Reference هستند.

ترتیب:

```text
Kolbe rule
→ current business goal
→ current implementation
→ mature common pattern
→ applicability
→ recommendation
```

هیچ pattern عمومی حق شکستن Rule خاص Kolbe را ندارد.

---

# 16. Business Knowledge Update Rule

اگر implementation با Business Pack تناقض دارد:

implementation را فوراً «حقیقت» فرض نکن.

اگر Rule روشن است:
- implementation defect.

اگر Rule روشن نیست:
- PRODUCT_DECISION_REQUIRED.

---

# 17. Domain Completion Loop

```text
BASELINE
→ CRAWL
→ BUSINESS SCENARIO
→ COUNTEREXAMPLE
→ FINDINGS FREEZE
→ PRIORITIZE
→ FIX
→ EXACT REPRODUCTION
→ INVARIANTS
→ REGRESSION
→ COMMIT
→ NEXT DOMAIN
```

---

# 18. Finding Severity

```text
P0 = money/data/security corruption
P1 = core business workflow broken/wrong
P2 = important domain capability incomplete/inefficient
P3 = UX/responsive/consistency
P4 = polish
```

Domain Defect می‌تواند P1/P2 باشد حتی اگر Console Error صفر باشد.

---

# 19. Product Decision Queue

هر تصمیم باز را در:

`PRODUCT_DECISIONS_REQUIRED.md`

ثبت کن.

Agent حق ندارد با «best practice» آن را خودسرانه ببندد.

---

# 20. Definition of Done

یک Domain فقط زمانی Done است که:

- Business purpose mapped
- Core journey passed
- Counterexample passed
- No open P1
- P2 fixed or explicitly documented
- Invariants pass
- UI/API/state consistent
- Regression coverage exists
- Product decisions separated
