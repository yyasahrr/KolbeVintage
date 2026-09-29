import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Trash2, Truck } from "lucide-react";
import { Btn, Card, Drawer, Empty, ErrorState, Field, Input, LoadingState, Select, Switch } from "./primitives";
import { cn } from "../utils/cn";
import { shippingApi, inventoryApi } from "../data/api";
import { fmtMoney } from "../data/catalog";
import {
  SHIPPING_TYPES, SHIPPING_TYPE_LABEL, buildShippingMethodPayload, normalizeShippingSettings, normalizeWarehouses,
  type ShippingMethod, type ShippingMethodInput, type ShippingSettings, type ShippingType, type Warehouse,
} from "../data/contracts";

/** Persian digits for read-only money/eta display. */
const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

const blankMethod = (): ShippingMethodInput => ({
  code: "", name: "", type: "standard", active: true,
  baseFeeRial: "0", freeAboveRial: null, estimatedMinDays: 1, estimatedMaxDays: 3, config: {},
});

/**
 * Shipping management — speaks the canonical backend contract:
 * `code, name, active, type, baseFeeRial, freeAboveRial, estimatedMinDays, estimatedMaxDays, config`
 * plus the global rules in site_settings (default fulfillment warehouse is a real warehouse UUID).
 *
 * The legacy carrier/scope/price/freeAbove/eta/zones model is gone.
 */
export function ShippingAdmin({ flash }: { flash: (message: string) => void }) {
  const [items, setItems] = useState<ShippingMethod[] | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [settings, setSettings] = useState<ShippingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<ShippingMethodInput | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [methods, warehouseList, shippingSettings] = await Promise.all([
        shippingApi.adminList(),
        inventoryApi.warehouses().then(normalizeWarehouses).catch(() => [] as Warehouse[]),
        shippingApi.settings().catch(() => null),
      ]);
      setItems(methods.items);
      setWarehouses(warehouseList);
      setSettings(shippingSettings ? normalizeShippingSettings({ settings: shippingSettings }) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در بارگذاری روش‌های ارسال");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!edit) return;
    try {
      setBusy(true);
      const payload = buildShippingMethodPayload(edit);
      if (editId) await shippingApi.update(editId, payload);
      else await shippingApi.create(payload);
      await load();
      setEdit(null); setEditId(null);
      flash(editId ? `روش ارسال «${payload.name}» به‌روزرسانی شد` : `روش ارسال «${payload.name}» ثبت شد`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ذخیره روش ارسال");
    } finally { setBusy(false); }
  };

  const toggle = async (method: ShippingMethod) => {
    try {
      await shippingApi.update(method.id, { active: !method.active });
      await load();
      flash(`${method.name} ${method.active ? "غیرفعال" : "فعال"} شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در تغییر وضعیت"); }
  };

  const remove = async (method: ShippingMethod) => {
    try {
      await shippingApi.remove(method.id);
      await load();
      flash(`روش ارسال «${method.name}» غیرفعال شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در حذف روش ارسال"); }
  };

  const saveSettings = async () => {
    if (!settings) return;
    try {
      setBusy(true);
      const next = await shippingApi.saveSettings(settings);
      setSettings(next); setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      flash("قوانین سراسری ارسال ذخیره شد");
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ذخیره قوانین ارسال");
    } finally { setBusy(false); }
  };

  if (loading) return <LoadingState label="در حال بارگذاری روش‌های ارسال…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const activeCount = (items ?? []).filter((method) => method.active).length;

  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_340px]">
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-[var(--kv-muted)]">
            روش‌های فعال در تسویه‌حساب خرده و ثبت سفارش عمده نمایش داده می‌شوند. ({fa(activeCount)} فعال از {fa(items?.length ?? 0)})
          </p>
          <div className="flex gap-2">
            <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
            <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setEditId(null); setEdit(blankMethod()); }}>روش ارسال جدید</Btn>
          </div>
        </div>

        {!items || items.length === 0 ? (
          <Card className="p-2">
            <Empty
              title="روش ارسالی ثبت نشده است"
              desc="برای فعال شدن ارسال در فروشگاه، نخستین روش ارسال را با کد، هزینه پایه و بازه تحویل بسازید."
              action={<Btn variant="accent" onClick={() => { setEditId(null); setEdit(blankMethod()); }} icon={<Truck size={15} />}>ایجاد اولین روش ارسال</Btn>}
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table min-w-[880px]">
                <thead>
                  <tr>
                    <th>کد روش ارسال</th><th>نام روش</th><th>نوع ارسال</th><th>هزینه پایه</th>
                    <th>ارسال رایگان از مبلغ</th><th>زمان تحویل</th><th>فعال</th><th>عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((method) => (
                    <tr key={method.id}>
                      <td className="font-mono text-[12px]" dir="ltr">{method.code}</td>
                      <td><b>{method.name}</b></td>
                      <td>
                        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold",
                          method.type === "express" ? "bg-[#C1613B]/12 text-[#8A3B30]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
                          {SHIPPING_TYPE_LABEL[method.type]}
                        </span>
                      </td>
                      <td className="tabular-nums">{Number(method.baseFeeRial) === 0 ? "رایگان" : fmtMoney(Number(method.baseFeeRial))}</td>
                      <td className="tabular-nums">{method.freeAboveRial ? fmtMoney(Number(method.freeAboveRial)) : "—"}</td>
                      <td className="tabular-nums">{fa(`${method.estimatedMinDays} تا ${method.estimatedMaxDays} روز`)}</td>
                      <td><Switch on={method.active} onToggle={() => void toggle(method)} /></td>
                      <td>
                        <span className="flex gap-2">
                          <button
                            onClick={() => { setEditId(method.id); setEdit({ ...method }); }}
                            className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" aria-label={`ویرایش ${method.name}`}
                          ><Pencil size={15} /></button>
                          <button
                            onClick={() => void remove(method)}
                            className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label={`غیرفعال کردن ${method.name}`}
                          ><Trash2 size={15} /></button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      <Card className="h-fit p-5">
        <p className="text-sm font-bold">قوانین سراسری ارسال</p>
        {!settings ? (
          <p className="mt-3 text-[12.5px] text-[var(--kv-muted)]">قوانین سراسری از سرور خوانده نشد؛ بازخوانی کنید.</p>
        ) : (
          <div className="mt-3 space-y-3">
            <Field label="ارسال رایگان از مبلغ (ریال)" hint="۰ = غیرفعال">
              <Input
                value={settings.freeShippingThresholdRial}
                onChange={(v) => setSettings({ ...settings, freeShippingThresholdRial: v.replace(/\D/g, "") || "0" })}
              />
            </Field>
            <Field label="انبار پیش‌فرض ارسال" hint="از فهرست واقعی انبارهای ثبت‌شده انتخاب می‌شود">
              <Select
                options={["انتخاب انبار…", ...(warehouses ?? []).map((w) => `${w.code} — ${w.name}`)]}
                value={settings.defaultWarehouseId
                  ? (warehouses ?? []).find((w) => w.id === settings.defaultWarehouseId)
                    ? `${(warehouses ?? []).find((w) => w.id === settings.defaultWarehouseId)!.code} — ${(warehouses ?? []).find((w) => w.id === settings.defaultWarehouseId)!.name}`
                    : "انتخاب انبار…"
                  : "انتخاب انبار…"}
                onChange={(label) => {
                  const match = (warehouses ?? []).find((w) => `${w.code} — ${w.name}` === label);
                  setSettings({ ...settings, defaultWarehouseId: match?.id ?? null });
                }}
              />
            </Field>
            {settings.defaultWarehouseId && (
              <p className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{settings.defaultWarehouseId}</p>
            )}
            {!(warehouses ?? []).length && (
              <p className="text-[11.5px] leading-6 text-[var(--kv-warn,#B7791F)]">
                هنوز انباری ثبت نشده است؛ از بخش «انبار و موجودی» نخستین انبار را بسازید.
              </p>
            )}
            <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">
              رهگیری خودکار از API حامل
              <Switch on={settings.autoTracking} onToggle={() => setSettings({ ...settings, autoTracking: !settings.autoTracking })} />
            </label>
            <Btn variant="soft" size="sm" disabled={busy} onClick={() => void saveSettings()}>
              {saved ? "ذخیره شد ✓" : "ذخیره قوانین"}
            </Btn>
          </div>
        )}
      </Card>

      <Drawer open={!!edit} onClose={() => { setEdit(null); setEditId(null); }} title={editId ? `ویرایش ${edit?.name ?? ""}` : "روش ارسال جدید"}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کد روش ارسال" hint="حروف انگلیسی کوچک، عدد، - و _">
                <Input value={edit.code} onChange={(v) => setEdit({ ...edit, code: v.toLowerCase() })} placeholder="post-pishtaz" />
              </Field>
              <Field label="نام روش"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="مثلاً پست پیشتاز" /></Field>
            </div>
            <Field label="نوع ارسال">
              <Select
                options={SHIPPING_TYPES.map((type) => SHIPPING_TYPE_LABEL[type])}
                value={SHIPPING_TYPE_LABEL[edit.type]}
                onChange={(label) => {
                  const type = (Object.keys(SHIPPING_TYPE_LABEL) as ShippingType[]).find((key) => SHIPPING_TYPE_LABEL[key] === label);
                  if (type) setEdit({ ...edit, type });
                }}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="هزینه پایه (ریال)" hint="۰ = ارسال رایگان">
                <Input value={edit.baseFeeRial} onChange={(v) => setEdit({ ...edit, baseFeeRial: v.replace(/\D/g, "") || "0" })} />
              </Field>
              <Field label="ارسال رایگان از مبلغ (ریال)" hint="خالی = بدون ارسال رایگان">
                <Input
                  value={edit.freeAboveRial ?? ""}
                  onChange={(v) => setEdit({ ...edit, freeAboveRial: v.replace(/\D/g, "") || null })}
                  placeholder="—"
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="حداقل زمان تحویل (روز)">
                <Input value={String(edit.estimatedMinDays)} onChange={(v) => setEdit({ ...edit, estimatedMinDays: Number(v.replace(/\D/g, "")) || 0 })} />
              </Field>
              <Field label="حداکثر زمان تحویل (روز)">
                <Input value={String(edit.estimatedMaxDays)} onChange={(v) => setEdit({ ...edit, estimatedMaxDays: Number(v.replace(/\D/g, "")) || 0 })} />
              </Field>
            </div>
            <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">
              فعال در فروشگاه
              <Switch on={edit.active} onToggle={() => setEdit({ ...edit, active: !edit.active })} />
            </label>
            <Btn variant="accent" className="w-full" disabled={busy || !edit.name.trim() || !edit.code.trim()} onClick={() => void save()}>
              ذخیره روش ارسال
            </Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}
