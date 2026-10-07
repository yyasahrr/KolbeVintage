import { useCallback, useEffect, useState } from "react";
import { BarChart3, Layers, MousePointerClick, Plus, Sparkles, Trash2 } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { recommendationsApi } from "../data/api";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Segmented, Select, Switch } from "./primitives";

const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const num = (value: unknown) => fmtNum(Number(value ?? 0));
const rial = (value: unknown) => `${fmtNum(Number(String(value ?? "0")))} ریال`;

/** Persian labels for server-owned strategy codes (items 110-121). */
const STRATEGY_LABEL: Record<string, string> = {
  personalized: "شخصی‌سازی‌شده", similar: "محصولات مشابه", collaborative: "خرید مشترک کاربران", popular: "پرفروش‌ها",
  trending: "داغ‌های روز", rule_based: "قانون‌محور", seasonal: "فصلی", manual_campaign: "کمپین دستی", new_arrivals: "تازه‌رسیده‌ها",
};
const strategyLabel = (value: unknown) => STRATEGY_LABEL[String(value ?? "")] ?? text(value);

type Tab = "slots" | "analytics";
const TABS: { v: Tab; label: string }[] = [
  { v: "slots", label: "جایگاه‌ها و استراتژی‌ها" },
  { v: "analytics", label: "تحلیل عملکرد" },
];

/** Recommendations admin (items 110-121): server-owned slots with their
 *  strategies, manual pinning and the impressions/clicks/CTR/revenue report. */
export function RecommendationsPanel({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("slots");
  const [slots, setSlots] = useState<Record<string, unknown>[]>([]);
  const [strategies, setStrategies] = useState<string[]>([]);
  const [picking, setPicking] = useState<Record<string, unknown> | null>(null);
  const [productIds, setProductIds] = useState("");
  const [replace, setReplace] = useState<"true" | "false">("true");
  const [removeId, setRemoveId] = useState("");
  const [days, setDays] = useState(30);
  const [analytics, setAnalytics] = useState<{ items: Record<string, unknown>[]; totals: Record<string, unknown>; privacyNote?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [slotsResponse, analytic] = await Promise.all([
        recommendationsApi.adminSlots(),
        recommendationsApi.analytics({ days }),
      ]);
      setSlots(slotsResponse.items); setStrategies(slotsResponse.strategies); setAnalytics(analytic);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری توصیه‌گر"); }
    finally { setLoading(false); }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); flash(`${label} انجام شد`); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); }
  };

  const asStringArray = (value: unknown): string[] => Array.isArray(value) ? (value as string[]) : [];

  if (loading && !slots.length) return <LoadingState label="در حال بارگذاری توصیه‌گر…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented options={TABS} value={tab} onChange={setTab} />
        {tab === "analytics" && (
          <div className="flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]">
            بازه:
            <Select options={["7", "30", "90", "180"]} value={String(days)} onChange={(v) => setDays(Number(v))} />
          </div>
        )}
      </Card>

      {tab === "slots" && (
        <div className="grid gap-3 lg:grid-cols-2">
          {slots.map((slot) => {
            const code = String(slot.code);
            const activeStrategies = asStringArray(slot.strategies);
            return (
              <Card key={code} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 text-[13px] font-extrabold"><Layers size={15} />{text(slot.title)}</p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                      <code>{code}</code> · صفحه {text(slot.page_scope)} · پیش‌فرض {strategyLabel(slot.default_strategy)} · {num(slot.manual_items)} آیتم دستی
                    </p>
                  </div>
                  <Switch on={Boolean(slot.active)} onToggle={() => void run("تغییر وضعیت جایگاه", () => recommendationsApi.updateSlot(code, { active: !slot.active }))} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
                  <span className="text-[var(--kv-muted)]">استراتژی پیش‌فرض:</span>
                  <Select options={strategies} labels={STRATEGY_LABEL} value={text(slot.default_strategy)} className="w-44"
                    onChange={(v) => void run("تغییر استراتژی", () => recommendationsApi.updateSlot(code, { defaultStrategy: v }))} />
                  <span className="text-[var(--kv-muted)]">فعال: {activeStrategies.length ? activeStrategies.map((item) => strategyLabel(item)).join("، ") : "همه"}</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Btn variant="soft" size="sm" icon={<Plus size={13} />} onClick={() => { setPicking(slot); setProductIds(""); setReplace("true"); }}>مدیریت پین دستی</Btn>
                </div>
              </Card>
            );
          })}
          {!slots.length && <Empty title="جایگاهی ثبت نشده" desc="جایگاه‌های استاندارد (home.for_you، product.similar، cart.you_may_like و…) در مایگریشن ساخته می‌شوند." />}
        </div>
      )}

      {tab === "analytics" && analytics && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {[["نمایش", num(analytics.totals.impressions)], ["کلیک", num(analytics.totals.clicks)], ["CTR", `${text(analytics.totals.ctr, "0")}٪`],
              ["افزودن به سبد", num(analytics.totals.addToCart)], ["درآمد", rial(analytics.totals.revenueRial)]].map(([label, value]) => (
              <Card key={label as string} className="p-4">
                <p className="text-[11.5px] text-[var(--kv-muted)]">{label as string}</p>
                <p className="mt-1 text-[18px] font-extrabold tabular-nums">{value}</p>
              </Card>
            ))}
          </div>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><BarChart3 size={15} />عملکرد به تفکیک جایگاه و استراتژی</div>
            <div className="kv-scroll overflow-x-auto">
              <table className="w-full min-w-[820px] text-right text-[12.5px]">
                <thead><tr className="text-[11.5px] text-[var(--kv-muted)]">
                  <th className="pb-2">جایگاه</th><th className="pb-2">استراتژی</th><th className="pb-2">نمایش</th><th className="pb-2">کلیک</th>
                  <th className="pb-2">CTR</th><th className="pb-2">افزودن به سبد</th><th className="pb-2">تبدیل</th><th className="pb-2">خرید</th><th className="pb-2">درآمد</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--kv-line)]">
                  {analytics.items.map((row) => (
                    <tr key={`${row.slotCode}-${row.strategy}`}>
                      <td className="py-2 font-semibold"><code>{text(row.slotCode)}</code></td>
                      <td className="py-2">{strategyLabel(row.strategy)}</td>
                      <td className="py-2 tabular-nums">{num(row.impressions)}</td>
                      <td className="py-2 tabular-nums">{num(row.clicks)}</td>
                      <td className="py-2 tabular-nums">{text(row.ctr, "0")}٪</td>
                      <td className="py-2 tabular-nums">{num(row.addToCart)} <span className="text-[10.5px] text-[var(--kv-muted)]">({text(row.addToCartRate, "0")}٪)</span></td>
                      <td className="py-2 tabular-nums">{text(row.conversion, "0")}٪</td>
                      <td className="py-2 tabular-nums">{num(row.purchases)}</td>
                      <td className="py-2 tabular-nums">{rial(row.revenueRial)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!analytics.items.length && <Empty title="رویدادی ثبت نشده" desc="با نمایش جایگاه‌ها در فروشگاه، رویدادها اینجا جمع می‌شوند." />}
            </div>
            <p className="mt-3 flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]">
              <MousePointerClick size={13} />{text(analytics.privacyNote, "")}
            </p>
          </Card>
          <Card className="p-5 text-[12px] text-[var(--kv-muted)]">
            <p className="mb-1 flex items-center gap-2 font-extrabold text-[var(--kv-ink)]"><Sparkles size={15} />سیگنال‌های شخصی‌سازی</p>
            خریدهای گذشته، بازدیدها، علاقه‌مندی‌ها، سبد، دسته/رنگ/سایز، بازه قیمت، امتیازها، مرجوعی‌ها و جست‌وجو — برای کاربر مهمان: پرطرفدار، پرفروش، جدید، فصل و موجودی.
            قیمت و موجودی از موتور قیمت و WMS خوانده می‌شود و کالاهای ناموجود حذف می‌شوند.
          </Card>
        </div>
      )}

      <Modal open={!!picking} onClose={() => setPicking(null)} title={picking ? `پین دستی در ${text(picking.code)}` : "پین دستی"}>
        <div className="space-y-3">
          <Field label="شناسه محصولات (هر خط یک UUID)" hint="این آیتم‌ها همیشه در ابتدای جایگاه نمایش داده می‌شوند.">
            <Input value={productIds} onChange={setProductIds} placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>
          <Field label="جایگزینی پین‌های قبلی">
            <Select options={["true", "false"]} labels={{ true: "جایگزینی کامل فهرست", false: "افزودن به فهرست فعلی" }} value={replace} onChange={(v) => setReplace(v as "true" | "false")} />
          </Field>
          <Btn variant="accent" className="w-full" disabled={!productIds.trim()}
            onClick={() => void run("پین محصولات", async () => {
              const ids = productIds.split("\n").map((line) => line.trim()).filter(Boolean);
              await recommendationsApi.setManualItems(String(picking?.code), { productIds: ids, replace: replace === "true" });
              setPicking(null);
            })}>ثبت پین‌ها</Btn>
          <hr className="border-[var(--kv-line)]" />
          <Field label="حذف یک پین (UUID محصول)" hint="اگر آیتمی از جایگاه حذف شود، استراتژی خودکار جای آن را می‌گیرد.">
            <Input value={removeId} onChange={setRemoveId} placeholder="00000000-0000-0000-0000-000000000000" icon={<Trash2 size={14} />} />
          </Field>
          <Btn variant="soft" className="w-full" disabled={!removeId.trim()}
            onClick={() => void run("حذف پین", async () => {
              await recommendationsApi.removeManualItem(String(picking?.code), removeId.trim());
              setRemoveId("");
            })}>حذف پین</Btn>
        </div>
      </Modal>
    </div>
  );
}
