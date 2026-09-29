import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Percent, RefreshCw, Sparkles, Tag } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Select } from "./primitives";
import { PersianDatePicker } from "./persian-date-picker";
import { promoApi } from "../data/api";
import { fmtMoney } from "../data/catalog";
import { formatPersianDate, formatPersianDateTime, todayIso, addDaysIso } from "../data/persian-date";
import { COUPON_SOURCE_LABEL, COUPON_TYPE_LABEL, PROMO_AUDIENCE_LABEL, PROMO_SCOPE_LABEL, labelOf } from "../data/contracts";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

type Coupon = {
  id: string; code: string; type: string; value: string; min_order_rial: string; used_count: number;
  usage_limit_total: number | null; ends_at: string; source: string; daily_start_time?: string | null;
};
type Festival = {
  id: string; code: string; name: string; starts_at: string; ends_at: string;
  discount_percent: number | null; discount_fixed_rial?: string | null; theme_palette_code: string | null; active: boolean;
};

/** Coupons and festivals — every visible term is Persian; API values stay English. */
export function PromoPanel() {
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [festivals, setFestivals] = useState<Festival[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"coupons" | "festivals">("coupons");
  const [newCoupon, setNewCoupon] = useState({
    code: "", type: "percent" as "percent" | "fixed", value: "100000",
    minOrderRial: "0", endsAt: addDaysIso(todayIso(), 7), dailyStartTime: "",
    audience: "customer" as "customer" | "vip" | "wholesale", scope: "productIds" as "productIds" | "categories",
  });
  const [newFestival, setNewFestival] = useState({
    code: "", name: "", startsAt: todayIso(), endsAt: addDaysIso(todayIso(), 7),
    discountPercent: "15", themePaletteCode: "", audience: "customer" as "customer" | "vip" | "wholesale",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, f] = await Promise.all([promoApi.coupons(), promoApi.festivals()]);
      setCoupons(c.items as Coupon[]);
      setFestivals(f.items as Festival[]);
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
        value: newCoupon.value,
        minOrderRial: newCoupon.minOrderRial || "0",
        audience: [newCoupon.audience],
        scope: { productIds: [], categories: [] },
        dailyStartTime: newCoupon.dailyStartTime || null,
        startsAt: todayIso(),
        endsAt: newCoupon.endsAt,
      });
      setNotice("کد تخفیف ساخته شد.");
      setNewCoupon({ ...newCoupon, code: "", value: "100000" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ساخت کد تخفیف"); }
    finally { setBusy(false); }
  };

  const createFestival = async () => {
    try {
      setBusy(true); setError(null);
      await promoApi.createFestival({
        code: newFestival.code.trim(),
        name: newFestival.name.trim(),
        startsAt: newFestival.startsAt,
        endsAt: newFestival.endsAt,
        discountPercent: Number(newFestival.discountPercent) || undefined,
        audience: [newFestival.audience],
        scope: { productIds: [], categories: [] },
        themePaletteCode: newFestival.themePaletteCode || null,
        active: true,
      });
      setNotice("جشنواره ساخته شد.");
      setNewFestival({ ...newFestival, code: "", name: "" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ساخت جشنواره"); }
    finally { setBusy(false); }
  };

  if (error && !coupons) return <ErrorState message={error} onRetry={load} />;
  if (!coupons || !festivals) return <LoadingState label="در حال بارگذاری کدهای تخفیف و جشنواره‌ها…" />;

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
              <Field label={newCoupon.type === "percent" ? "درصد تخفیف (۱ تا ۱۰۰)" : "مبلغ ثابت (ریال)"}>
                <Input value={newCoupon.value} onChange={(v) => setNewCoupon({ ...newCoupon, value: v.replace(/\D/g, "") })} />
              </Field>
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
              <div className="flex items-end"><Btn variant="accent" disabled={busy} onClick={() => void createCoupon()} icon={<Percent size={15} />}>ایجاد کد تخفیف</Btn></div>
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
            <p className="text-[13px] font-bold">ایجاد جشنواره</p>
            <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
              جشنواره فعال (بازه زمانی + مخاطب) بر پالت رنگ سایت اولویت دارد: جشنواره → زمان‌بندی‌شده → دستی.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <Field label="کد جشنواره" hint="حروف انگلیسی کوچک، عدد، - و _"><Input value={newFestival.code} onChange={(v) => setNewFestival({ ...newFestival, code: v.toLowerCase() })} placeholder="yald-1404" /></Field>
              <Field label="نام جشنواره"><Input value={newFestival.name} onChange={(v) => setNewFestival({ ...newFestival, name: v })} placeholder="جشنواره یلدا" /></Field>
              <PersianDatePicker label="شروع جشنواره" value={newFestival.startsAt} withTime onChange={(iso) => setNewFestival({ ...newFestival, startsAt: iso ?? newFestival.startsAt })} />
              <PersianDatePicker label="پایان جشنواره" value={newFestival.endsAt} withTime onChange={(iso) => setNewFestival({ ...newFestival, endsAt: iso ?? newFestival.endsAt })} />
              <Field label="درصد تخفیف"><Input value={newFestival.discountPercent} onChange={(v) => setNewFestival({ ...newFestival, discountPercent: v.replace(/\D/g, "") })} /></Field>
              <Field label="کد پالت تم (اختیاری)" hint="برای اعمال رنگ جشنواره روی سایت"><Input value={newFestival.themePaletteCode} onChange={(v) => setNewFestival({ ...newFestival, themePaletteCode: v })} placeholder="kolbe-default" /></Field>
              <Field label="مخاطب">
                <Select
                  options={["مشتری عادی", "ویژه", "عمده"]}
                  value={labelOf(PROMO_AUDIENCE_LABEL, newFestival.audience)}
                  onChange={(label) => {
                    const entry = Object.entries(PROMO_AUDIENCE_LABEL).find(([, value]) => value === label);
                    if (entry) setNewFestival({ ...newFestival, audience: entry[0] as typeof newFestival.audience });
                  }}
                />
              </Field>
              <div className="flex items-end"><Btn variant="accent" disabled={busy || newFestival.code.trim().length < 3 || newFestival.name.trim().length < 2} onClick={() => void createFestival()} icon={<CalendarDays size={15} />}>ایجاد جشنواره</Btn></div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3"><p className="text-[13px] font-bold">فهرست جشنواره‌ها ({fa(festivals.length)})</p></div>
            <div className="overflow-x-auto">
              <table className="kv-table min-w-[900px] text-xs">
                <thead>
                  <tr><th>کد</th><th>نام</th><th>شروع</th><th>پایان</th><th>درصد تخفیف</th><th>پالت رنگ</th><th>وضعیت</th></tr>
                </thead>
                <tbody>
                  {festivals.map((festival) => (
                    <tr key={festival.id}>
                      <td className="font-mono" dir="ltr">{festival.code}</td>
                      <td className="font-bold">{festival.name}</td>
                      <td className="tabular-nums">{formatPersianDateTime(festival.starts_at)}</td>
                      <td className="tabular-nums">{formatPersianDateTime(festival.ends_at)}</td>
                      <td className="tabular-nums">{festival.discount_percent === null ? "—" : `${fa(festival.discount_percent)}٪`}</td>
                      <td className="font-mono" dir="ltr">{festival.theme_palette_code ?? "—"}</td>
                      <td>{festival.active ? "فعال" : "غیرفعال"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {festivals.length === 0 && <Empty title="جشنواره‌ای ثبت نشده است" desc="نخستین جشنواره را با بازه تاریخ جلالی بسازید تا روی سایت اعمال شود." />}
          </Card>
        </>
      )}
    </div>
  );
}
