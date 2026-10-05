/** §8-§10: Category = Source of Truth.
 *  Connects a canonical category to its spec template, size guide and allowed sizes.
 *  The templates themselves are defined in «ساختار محصولات و سری‌ها».
 *
 *  Extracted verbatim from the retired `catalog-hub.tsx` when «محصولات کلبه»
 *  became the canonical Product management surface (§3) — same behaviour, new home.
 */
import { useCallback, useEffect, useState } from "react";
import { Btn, Card, Empty, ErrorState, Field, LoadingState, Modal } from "./primitives";
import { catalogOpsApi, sizeGuidesApi, specsApi } from "../data/api";
import { siteApi } from "../data/experience-api";
import { cn } from "../utils/cn";

type F = (message: string) => void;
const SELECT_CLS = "h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";
const NUM_CLS = "h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";
const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

export function CategoryProfilesPanel({ flash }: { flash: F }) {
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [profiles, setProfiles] = useState<Record<string, unknown>[] | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [guides, setGuides] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ category: string; specTemplateId: string; sizeGuideId: string; sizes: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    Promise.all([
      catalogOpsApi.categoryProfiles(),
      specsApi.templates().catch(() => ({ items: [] as unknown[] })),
      sizeGuidesApi.adminList().catch(() => ({ items: [] as unknown[] })),
      siteApi.categories(),
    ]).then(([p, t, g, c]) => {
      setCategories(c.items);
      setProfiles(p.items);
      setTemplates((t.items as { id: string; name: string }[]).filter((x) => x?.id));
      setGuides((g.items as { id: string; name: string }[]).filter((x) => x?.id));
    }).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!profiles) return <LoadingState label="در حال دریافت پروفایل دسته‌بندی‌ها..." />;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">پروفایل دسته‌بندی‌ها (اتصال دسته به ساختار محصول)</h3>
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
            دسته‌بندی تعیین می‌کند چه مشخصاتی الزامی است، چه سایزهایی مجازند و کدام راهنمای سایز نمایش داده می‌شود.
            خودِ قالب‌های مشخصات و راهنمای سایز در بخش «ساختار محصولات و سری‌ها» (منوی محصول و انبار) تعریف می‌شوند؛ این‌جا فقط به دسته متصل می‌شوند.
          </p>
        </div>
        <Btn size="sm" variant="accent" onClick={() => setEditing({ category: "", specTemplateId: "", sizeGuideId: "", sizes: "" })}>پروفایل جدید</Btn>
      </div>
      {!profiles.length && <Empty title="پروفایلی تعریف نشده" desc="برای هر دسته‌بندی، قالب مشخصات و سایزهای مجاز را تعریف کنید." />}
      {profiles.length > 0 && (
        <div className="overflow-x-auto">
          <table className="kv-table w-full text-xs">
            <thead><tr><th>دسته‌بندی</th><th>قالب مشخصات</th><th>راهنمای سایز</th><th>سایزهای مجاز</th><th>محصولات</th><th>اقدام</th></tr></thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={String(p.id)}>
                  <td className="font-bold">{String(p.category)}</td>
                  <td>{String(p.spec_template_name ?? "—")}</td>
                  <td>{String(p.size_guide_name ?? "—")}</td>
                  <td dir="ltr">{Array.isArray(p.allowed_sizes) && p.allowed_sizes.length ? (p.allowed_sizes as string[]).join("، ") : "آزاد"}</td>
                  <td>{fa(Number(p.product_count ?? 0))}</td>
                  <td><Btn size="sm" variant="soft" onClick={() => setEditing({
                    category: String(p.category),
                    specTemplateId: String(p.spec_template_id ?? ""),
                    sizeGuideId: String(p.size_guide_id ?? ""),
                    sizes: Array.isArray(p.allowed_sizes) ? (p.allowed_sizes as string[]).join(",") : "",
                  })}>ویرایش</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal open onClose={() => setEditing(null)} title="پروفایل دسته‌بندی">
          <h3 className="mb-3 text-sm font-bold">پروفایل دسته‌بندی</h3>
          <div className="space-y-3">
            <Field label="دسته‌بندی" hint="دسته جدید را در استودیو محصول بسازید؛ این بخش پیش‌فرض‌های همان دسته را تنظیم می‌کند.">
              <select className={SELECT_CLS} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} aria-label="دسته‌بندی">
                <option value="">انتخاب دسته‌بندی…</option>
                {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="قالب مشخصات فنی">
              <select className={SELECT_CLS} value={editing.specTemplateId} onChange={(e) => setEditing({ ...editing, specTemplateId: e.target.value })} aria-label="قالب مشخصات">
                <option value="">بدون قالب</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="راهنمای سایز">
              <select className={SELECT_CLS} value={editing.sizeGuideId} onChange={(e) => setEditing({ ...editing, sizeGuideId: e.target.value })} aria-label="راهنمای سایز">
                <option value="">بدون راهنما</option>
                {guides.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            <Field label="سایزهای مجاز (با ویرگول جدا کنید؛ خالی = آزاد)" hint="مثال: S,M,L,XL">
              <input dir="ltr" className={cn(NUM_CLS, "w-full")} value={editing.sizes} onChange={(e) => setEditing({ ...editing, sizes: e.target.value })} aria-label="سایزهای مجاز" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setEditing(null)}>انصراف</Btn>
            <Btn variant="accent" disabled={busy || !editing.category.trim()} onClick={async () => {
              setBusy(true);
              try {
                await catalogOpsApi.saveCategoryProfile(editing.category.trim(), {
                  specTemplateId: editing.specTemplateId || null,
                  sizeGuideId: editing.sizeGuideId || null,
                  allowedSizes: editing.sizes.split(",").map((x) => x.trim()).filter(Boolean),
                });
                flash("پروفایل دسته‌بندی ذخیره شد.");
                setEditing(null); load();
              } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(false); }
            }}>{busy ? "..." : "ذخیره"}</Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}
