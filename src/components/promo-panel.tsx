import { useCallback, useEffect, useState } from "react";
import { Percent, RefreshCw, Sparkles, Tag } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Select } from "./primitives";
import { PersianDatePicker } from "./persian-date-picker";
import { promoApi, promotionRulesApi } from "../data/api";
import { fmtMoney } from "../data/catalog";
import { formatPersianDate, formatPersianDateTime, todayIso, addDaysIso } from "../data/persian-date";
import { COUPON_SOURCE_LABEL, COUPON_TYPE_LABEL, PROMO_AUDIENCE_LABEL, PROMO_SCOPE_LABEL, labelOf } from "../data/contracts";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

type Coupon = {
  id: string; code: string; type: string; value: string; min_order_rial: string; used_count: number;
  usage_limit_total: number | null; ends_at: string; source: string; daily_start_time?: string | null;
};
type Festival = {
  id: string; code: string | null; name: string; starts_at: string | null; ends_at: string | null;
  kind: string; channel: string; exclusive_policy: string; active: boolean;
};

/** Coupons and festivals — every visible term is Persian; API values stay English. */
export type PromoFocus = { productId: string; productName: string; anchor?: "discount" | "festival" };
export function PromoPanel({ focus }: { focus?: PromoFocus | null } = {}) {
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [festivals, setFestivals] = useState<Festival[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"coupons" | "festivals">(focus?.anchor === "festival" ? "festivals" : "coupons");
  // Percent and fixed amounts are kept in SEPARATE fields: switching the type must never carry a
  // rial amount into the percent box (the old single `value` produced «۱۰۰۰۰۰ درصد» coupons).
  const [newCoupon, setNewCoupon] = useState({
    code: "", type: "percent" as "percent" | "fixed", percentValue: "10", fixedValue: "100000",
    minOrderRial: "0", endsAt: addDaysIso(todayIso(), 7), dailyStartTime: "",
    audience: "customer" as "customer" | "vip" | "wholesale", scope: "productIds" as "productIds" | "categories",
  });
  const percentInvalid = newCoupon.type === "percent" && (!newCoupon.percentValue || Number(newCoupon.percentValue) < 1 || Number(newCoupon.percentValue) > 100);
  const fixedInvalid = newCoupon.type === "fixed" && (!newCoupon.fixedValue || Number(newCoupon.fixedValue) <= 0);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, p] = await Promise.all([promoApi.coupons(), promotionRulesApi.list()]);
      setCoupons(c.items as Coupon[]);
      setFestivals((p.promotions ?? []).filter((promotion) => promotion.kind === "festival") as unknown as Festival[]);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری کدهای تخفیف و جشنواره‌ها"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const createCoupon = async () => {
    try {
      setBusy(true); setError(null);
      await promoApi.createCoupon({
        ...(newCoupon.code ? { code: newCoupon.code.toUpperCase() } : {}),
        campaignName: newCoupon.code ? `کمپین ${newCoupon.code.toUpperCase()}` : undefined,
        type: newCoupon.type,
        value: newCoupon.type === "percent" ? newCoupon.percentValue : newCoupon.fixedValue,
        minOrderRial: newCoupon.minOrderRial || "0",
        audience: [newCoupon.audience],
        scope: { productIds: [], categories: [] },
        dailyStartTime: newCoupon.dailyStartTime || null,
        startsAt: todayIso(),
        endsAt: newCoupon.endsAt,
      });
      setNotice("کد تخفیف ساخته شد.");
      setNewCoupon({ ...newCoupon, code: "", percentValue: "10", fixedValue: "100000" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ساخت کد تخفیف"); }
    finally { setBusy(false); }
  };

  const toggleFestival = async (festival: Festival) => {
    try {
      setBusy(true); setError(null);
      await promotionRulesApi.updatePromotion(festival.id, { active: !festival.active });
      setNotice(festival.active ? "تعریف مرکزی خاموش شد؛ قوانین معلق دوباره فعال نمی‌شوند." : "تعریف مرکزی روشن شد؛ وضعیت قوانین معلق تغییری نکرد.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تغییر وضعیت جشنواره مرکزی ناموفق بود."); }
    finally { setBusy(false); }
  };

  if (error && !coupons) return <ErrorState message={error} onRetry={load} />;
  if (!coupons || !festivals) return <LoadingState label="در حال بارگذاری کدهای تخفیف و Festivalهای مرکزی…" />;

  const channelLabel = (channel: string) => channel === "retail" ? "خرده" : channel === "wholesale" ? "عمده" : "همه کانال‌ها";
  const exclusivityLabel = (policy: string) => policy === "override_all" ? "بازنویسی کامل"
    : policy === "festival_exclusive" ? "انحصاری با Festival" : "رقابت بر اساس اولویت";

  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-2">
          <Btn variant={tab === "coupons" ? "accent" : "soft"} size="sm" icon={<Tag size={14} />} onClick={() => setTab("coupons")}>کدهای تخفیف</Btn>
          <Btn variant={tab === "festivals" ? "accent" : "soft"} size="sm" icon={<Sparkles size={14} />} onClick={() => setTab("festivals")}>جشنواره‌ها</Btn>
        </div>
        <span className="flex-1" />
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>

      {/* §2: the pricing workspace deep-links here FOR a specific product — say so explicitly so
          the operator never wonders which product the discount/festival being edited belongs to. */}
      {focus && (
        <p role="status" className="rounded-[12px] border border-[var(--kv-accent)]/40 bg-[var(--kv-accent)]/[0.06] px-4 py-2 text-[12.5px] font-semibold">
          {focus.anchor === "festival" ? "جشنواره‌های اعمال‌شده بر" : "تخفیف‌های"} محصول «{focus.productName}» از همین‌جا مدیریت می‌شود.
        </p>
      )}
      {error && <ErrorState message={error} onRetry={load} />}
      {notice && <p role="status" className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2 text-[12.5px] font-semibold">{notice}</p>}

      {tab === "coupons" ? (
        <>
          <Card className="p-4">
            <p className="text-[13px] font-bold">ایجاد کد تخفیف</p>
            <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
              اعتبارسنجی فقط روی سرور انجام می‌شود و با کدهای جشنواره/خوش‌آمدگویی تجمیع نمی‌شود.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Field label="کد تخفیف (اختیاری)" hint="خالی بماند، سرور می‌سازد">
                <Input value={newCoupon.code} onChange={(v) => setNewCoupon({ ...newCoupon, code: v.toUpperCase() })} placeholder="مثلاً SUMMER15" />
              </Field>
              <Field label="نوع تخفیف">
                <Select
                  options={[COUPON_TYPE_LABEL.percent!, COUPON_TYPE_LABEL.fixed!]}
                  value={COUPON_TYPE_LABEL[newCoupon.type]}
                  onChange={(label) => setNewCoupon({ ...newCoupon, type: label === COUPON_TYPE_LABEL.percent ? "percent" : "fixed" })}
                />
              </Field>
              {newCoupon.type === "percent" ? (
                <Field label="درصد تخفیف (۱ تا ۱۰۰)" hint={percentInvalid ? "عدد بین ۱ تا ۱۰۰ وارد کنید" : undefined}>
                  <Input value={newCoupon.percentValue} onChange={(v) => setNewCoupon({ ...newCoupon, percentValue: v.replace(/\D/g, "").slice(0, 3) })} placeholder="مثلاً ۱۵" />
                </Field>
              ) : (
                <Field label="مبلغ ثابت (ریال)" hint={fixedInvalid ? "مبلغ ریالی بزرگ‌تر از صفر وارد کنید" : undefined}>
                  <Input value={newCoupon.fixedValue} onChange={(v) => setNewCoupon({ ...newCoupon, fixedValue: v.replace(/\D/g, "") })} placeholder="مثلاً ۱۰۰۰۰۰" />
                </Field>
              )}
              <Field label="حداقل مبلغ سفارش (ریال)">
                <Input value={newCoupon.minOrderRial} onChange={(v) => setNewCoupon({ ...newCoupon, minOrderRial: v.replace(/\D/g, "") })} />
              </Field>
              <PersianDatePicker label="تاریخ انقضا" value={newCoupon.endsAt} onChange={(iso) => setNewCoupon({ ...newCoupon, endsAt: iso ?? newCoupon.endsAt })} />
              <Field label="ساعت شروع روزانه (اختیاری)" hint="مثلاً ۱۸:۰۰ برای تخفیف ساعتی">
                <Input value={newCoupon.dailyStartTime} onChange={(v) => setNewCoupon({ ...newCoupon, dailyStartTime: v })} placeholder="۱۸:۰۰ — خالی یعنی تمام روز" />
              </Field>
              <Field label="مخاطب">
                <Select
                  options={["مشتری عادی", "ویژه", "عمده"]}
                  value={labelOf(PROMO_AUDIENCE_LABEL, newCoupon.audience)}
                  onChange={(label) => {
                    const entry = Object.entries(PROMO_AUDIENCE_LABEL).find(([, value]) => value === label);
                    if (entry) setNewCoupon({ ...newCoupon, audience: entry[0] as typeof newCoupon.audience });
                  }}
                />
              </Field>
              <Field label="محدوده اعمال" hint="در این صفحه فقط نوع محدوده انتخاب می‌شود؛ فهرست جزئیات در سرور نگه‌داری می‌شود">
                <Select
                  options={[PROMO_SCOPE_LABEL.productIds!, PROMO_SCOPE_LABEL.categories!]}
                  value={PROMO_SCOPE_LABEL[newCoupon.scope]}
                  onChange={(label) => setNewCoupon({ ...newCoupon, scope: label === PROMO_SCOPE_LABEL.categories ? "categories" : "productIds" })}
                />
              </Field>
              <div className="flex items-end"><Btn variant="accent" disabled={busy || percentInvalid || fixedInvalid} onClick={() => void createCoupon()} icon={<Percent size={15} />}>ایجاد کد تخفیف</Btn></div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3"><p className="text-[13px] font-bold">فهرست کدهای تخفیف ({fa(coupons.length)})</p></div>
            <div className="overflow-x-auto">
              <table className="kv-table min-w-[900px] text-xs">
                <thead>
                  <tr><th>کد</th><th>نوع</th><th>مقدار</th><th>حداقل سفارش</th><th>مصرف</th><th>تاریخ انقضا</th><th>منبع</th></tr>
                </thead>
                <tbody>
                  {coupons.map((coupon) => (
                    <tr key={coupon.id}>
                      <td className="font-mono" dir="ltr">{coupon.code}</td>
                      <td>{labelOf(COUPON_TYPE_LABEL, coupon.type)}</td>
                      <td className="tabular-nums">{coupon.type === "percent" ? `${fa(Number(coupon.value))}٪` : fmtMoney(Number(coupon.value))}</td>
                      <td className="tabular-nums">{fmtMoney(Number(coupon.min_order_rial))}</td>
                      <td className="tabular-nums">{fa(coupon.used_count)}/{coupon.usage_limit_total ? fa(coupon.usage_limit_total) : "بی‌نهایت"}</td>
                      <td className="tabular-nums">{formatPersianDate(coupon.ends_at)}</td>
                      <td className="text-[var(--kv-muted)]">{labelOf(COUPON_SOURCE_LABEL, coupon.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {coupons.length === 0 && <Empty title="کد تخفیفی ثبت نشده است" desc="نخستین کد تخفیف را با نوع درصدی یا مبلغ ثابت بسازید." />}
          </Card>
        </>
      ) : (
        <>
          <Card className="p-4">
            <p className="text-[13px] font-bold">جشنواره‌های قیمت‌گذاری مرکزی</p>
            <p className="mt-1 text-[11.5px] leading-6 text-[var(--kv-muted)]">
              این فهرست دقیقاً از رکوردهای canonical موتور قیمت‌گذاری خوانده می‌شود و همان گزینه‌ها در Product Studio، Product 360 و Resolver در دسترس‌اند. ساخت تعریف و قوانین محصول از «پروموشن‌های سرور» انجام می‌شود.
            </p>
          </Card>
          <Card className="overflow-hidden">
            <div className="px-4 py-3"><p className="text-[13px] font-bold">فهرست Festivalهای مرکزی ({fa(festivals.length)})</p></div>
            <div className="overflow-x-auto">
              <table className="kv-table min-w-[780px] text-xs">
                <thead><tr><th>کد</th><th>نام</th><th>کانال</th><th>شروع</th><th>پایان</th><th>سیاست انحصار</th><th>وضعیت</th><th>اقدام</th></tr></thead>
                <tbody>
                  {festivals.map((festival) => <tr key={festival.id}>
                    <td className="font-mono" dir="ltr">{festival.code ?? "—"}</td>
                    <td className="font-bold">{festival.name}</td>
                    <td>{channelLabel(festival.channel)}</td>
                    <td className="tabular-nums">{festival.starts_at ? formatPersianDateTime(festival.starts_at) : "—"}</td>
                    <td className="tabular-nums">{festival.ends_at ? formatPersianDateTime(festival.ends_at) : "بدون پایان"}</td>
                    <td>{exclusivityLabel(festival.exclusive_policy)}</td>
                    <td>{festival.active ? "فعال" : "خاموش"}</td>
                    <td><button type="button" disabled={busy} onClick={() => void toggleFestival(festival)} className="font-bold text-[var(--kv-accent)] underline">{festival.active ? "خاموش‌کردن" : "روشن‌کردن"}</button></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            {festivals.length === 0 && <Empty title="Festival مرکزی ثبت نشده است" desc="ابتدا از تب «پروموشن‌های سرور» یک تعریف Festival بسازید." />}
          </Card>
        </>
      )}
    </div>
  );
}
