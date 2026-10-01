import { useCallback, useEffect, useState } from "react";
import { inventoryApi } from "../data/api";
import { Btn, Empty, ErrorState, Field, Input, LoadingState } from "./primitives";

type Warehouse = { id: string; code: string; name: string; owner_id: string | null };
type Location = { id: string; code: string; name: string; active: boolean };
export type LowStock = { variant_id: string; warehouse_id: string; inventory_domain: string; sku: string; warehouse_name: string; available: number };

/** Configuration only. Location API supports list/create, but no edit or disable. */
export function WarehouseSettings({ onReport }: { onReport: (rows: LowStock[]) => void }) {
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [selected, setSelected] = useState("");
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [newWh, setNewWh] = useState({ code: "", name: "" });
  const [newLoc, setNewLoc] = useState({ code: "", name: "" });
  const [threshold, setThreshold] = useState("10");
  const loadWarehouses = useCallback(async () => {
    setError(null);
    try { const result = await inventoryApi.warehouses(); setWarehouses(result.items); setSelected((current) => current || result.items[0]?.id || ""); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری انبارها"); }
  }, []);
  useEffect(() => { void loadWarehouses(); }, [loadWarehouses]);
  const loadLocations = useCallback(async () => {
    if (!selected) { setLocations([]); return; }
    setLocations(null);
    try { setLocations((await inventoryApi.locations(selected)).items as Location[]); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری مکان‌ها"); }
  }, [selected]);
  useEffect(() => { let active = true; setLocations(null); if (!selected) return;
    inventoryApi.locations(selected).then((result) => { if (active) setLocations(result.items as Location[]); }).catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "خطا در بارگذاری مکان‌ها"); });
    return () => { active = false; };
  }, [selected]);
  const warehouse = warehouses?.find((item) => item.id === selected);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(null); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "خطا در ذخیره تنظیمات"); } finally { setBusy(false); } };
  if (!warehouses && !error) return <LoadingState />;
  return <div className="space-y-5">
    {error && <ErrorState message={error} onRetry={() => { void loadWarehouses(); void loadLocations(); }} />}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <section className="space-y-3">
      <h3 className="text-sm font-bold">اطلاعات انبار</h3>
      <Field label="انبار انتخاب‌شده"><select aria-label="انبار انتخاب‌شده" disabled={busy} value={selected} onChange={(e) => { setSelected(e.target.value); setNewLoc({ code: "", name: "" }); }} className="w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3">
        {(warehouses ?? []).map((item) => <option key={item.id} value={item.id}>{item.code} — {item.name}</option>)}
      </select></Field>
      {warehouse && <p className="text-sm text-[var(--kv-muted)]">نام: {warehouse.name} · کد: <span dir="ltr">{warehouse.code}</span></p>}
      {!warehouses?.length && <Empty title="هنوز انباری ثبت نشده است" desc="اولین انبار را از فرم زیر ایجاد کنید." />}
      <details className="rounded-lg border border-[var(--kv-line)] p-3" open={!warehouses?.length}>
        <summary className="cursor-pointer text-sm font-bold">افزودن انبار</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="کد انبار"><Input value={newWh.code} onChange={(code) => setNewWh({ ...newWh, code: code.toUpperCase() })} /></Field>
          <Field label="نام انبار"><Input value={newWh.name} onChange={(name) => setNewWh({ ...newWh, name })} /></Field>
        </div><Btn size="sm" variant="accent" className="mt-3" disabled={busy || newWh.code.trim().length < 3 || newWh.name.trim().length < 2} onClick={() => void run(async () => {
          const created = await inventoryApi.createWarehouse({ code: newWh.code.trim(), name: newWh.name.trim() }); await loadWarehouses(); setSelected(created.id); setNewWh({ code: "", name: "" }); setNotice("انبار ساخته شد.");
        })}>ساخت انبار</Btn>
      </details>
    </section>
    {selected && <section className="space-y-3 border-t border-[var(--kv-line)] pt-4">
      <h3 className="text-sm font-bold">مکان‌ها / قفسه‌های {warehouse?.name}</h3>
      {!locations ? <LoadingState /> : !locations.length ? <p className="text-sm text-[var(--kv-muted)]">مکانی ثبت نشده است.</p> : <div className="overflow-x-auto"><table className="kv-table w-full text-sm"><thead><tr><th>کد</th><th>نام</th><th>وضعیت</th></tr></thead><tbody>{locations.map((location) => <tr key={location.id}><td dir="ltr">{location.code}</td><td>{location.name}</td><td>{location.active ? "فعال" : "غیرفعال"}</td></tr>)}</tbody></table></div>}
      <div className="grid gap-3 sm:grid-cols-2"><Field label="کد مکان"><Input value={newLoc.code} onChange={(code) => setNewLoc({ ...newLoc, code: code.toUpperCase() })} /></Field><Field label="نام مکان"><Input value={newLoc.name} onChange={(name) => setNewLoc({ ...newLoc, name })} /></Field></div>
      <Btn size="sm" variant="soft" disabled={busy || !newLoc.code.trim() || !newLoc.name.trim()} onClick={() => void run(async () => { await inventoryApi.createLocation(selected, { code: newLoc.code.trim(), name: newLoc.name.trim() }); setNewLoc({ code: "", name: "" }); await loadLocations(); setNotice("مکان انبار ثبت شد."); })}>افزودن مکان</Btn>
    </section>}
    <section className="space-y-3 border-t border-[var(--kv-line)] pt-4">
      <h3 className="text-sm font-bold">قواعد موجودی</h3>
      <p className="text-xs leading-6 text-[var(--kv-muted)]">آستانه هشدار «رو به اتمام» در کل سامانه ثابت و سمت سرور است (۵ عدد قابل فروش یا کمتر). وضعیت موجودی همیشه خودکار محاسبه می‌شود و قابل ویرایش دستی نیست.</p>
      <h4 className="text-xs font-bold">فیلتر گزارش موجودی کم — همه انبارها و دامنه‌ها</h4>
      <p className="text-xs leading-6 text-[var(--kv-muted)]">این عدد ذخیره نمی‌شود؛ فقط اقلام با موجودی قابل فروش کمتر یا مساوی آن را در گزارش نشان می‌دهد و آستانه هشدار خودکار را تغییر نمی‌دهد.</p>
      <Field label="حد موجودی قابل فروش برای گزارش"><Input type="number" value={threshold} onChange={(value) => { if (/^\d*$/.test(value)) setThreshold(value); }} /></Field>
      <Btn size="sm" variant="soft" disabled={busy || !threshold || Number(threshold) > 100000} onClick={() => void run(async () => { onReport((await inventoryApi.lowStock(Number(threshold))).items as LowStock[]); })}>گزارش موجودی کم</Btn>

    </section>
  </div>;
}
