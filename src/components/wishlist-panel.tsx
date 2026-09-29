import { useEffect, useState } from "react";
import { Btn, Card, Field, Input, LoadingState, ErrorState, Empty } from "../components/primitives";
import { wishlistApi } from "../data/api";

export function WishlistPanel() {
  const [cols, setCols] = useState<{ id: string; title: string; item_count: number; items: { id: string; productId: string }[] }[] | null>(null);
  const [alerts, setAlerts] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("لیست من");
  const [addProduct, setAddProduct] = useState("");
  const load = async () => {
    setError(null);
    try {
      const c = await wishlistApi.collections() as { items: typeof cols };
      const a = await wishlistApi.alerts() as { items: unknown[] };
      setCols(c.items as never); setAlerts(a.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  useEffect(() => { void load(); }, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!cols || !alerts) return <LoadingState label="در حال بارگذاری علاقه‌مندی‌ها…" />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap gap-2">
        <Field label="عنوان مجموعه جدید"><Input value={title} onChange={setTitle} placeholder="مثلاً ست پاییز" /></Field>
        <Btn variant="accent" size="sm" className="mt-6" onClick={async () => { await wishlistApi.createCollection(title); void load(); }}>ساخت کالکشن</Btn>
      </div>
      {cols.length === 0 ? <Empty title="لیستی ندارید" desc="مجموعه‌های چندگانه بسازید، محصول و برند ذخیره کنید و اعلان کاهش قیمت بگیرید." /> : (
        <div className="grid gap-4 md:grid-cols-2">
          {cols.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-[13px] font-bold">{c.title} <span className="text-[var(--kv-muted)]">({c.item_count})</span></p>
                <Btn variant="ghost" size="sm" onClick={async () => { await wishlistApi.deleteCollection(c.id); void load(); }}>حذف</Btn>
              </div>
              <div className="mt-3 space-y-1 text-xs">
                {c.items.length === 0 ? <p className="text-[var(--kv-muted)]">محصولی اضافه نشده</p> : c.items.slice(0,5).map((it) => (
                  <div key={it.id} className="flex justify-between rounded bg-[var(--kv-surface-2)] px-2 py-1">
                    <span className="font-mono">{it.productId.slice(0,8)}</span>
                    <button onClick={async () => { await wishlistApi.removeItem(it.id); void load(); }} className="text-[var(--kv-danger)]">حذف</button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Input value={addProduct} onChange={setAddProduct} placeholder="productId uuid" />
                <Btn variant="soft" size="sm" onClick={async () => { if (!addProduct) return; await wishlistApi.addItem(c.id, { productId: addProduct }); setAddProduct(""); void load(); }}>افزودن</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Card className="p-4">
        <p className="text-[13px] font-bold">اعلان‌ها: کاهش قیمت / موجودی مجدد</p>
        <div className="mt-2 space-y-1 text-xs">
          {alerts.length === 0 ? <p className="text-[var(--kv-muted)]">هشدار فعالی ندارید.</p> : (alerts as { id: string; product_id: string; kind: string; active: boolean }[]).map((a) => (
            <div key={a.id} className="flex justify-between rounded bg-[var(--kv-surface-2)] px-3 py-2">
              <span>{a.product_id.slice(0,8)} — {a.kind}</span><span className={a.active ? "text-[#3E6B4A]" : "text-[var(--kv-muted)]"}>{a.active ? "فعال" : "غیرفعال"}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-[var(--kv-muted)]">Wishlist server-side است و در CRM segmentation قابل استفاده است.</p>
      </Card>
    </div>
  );
}
