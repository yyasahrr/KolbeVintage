import { useEffect, useState } from "react";
import { Btn, Card, Field, Input, LoadingState, ErrorState, Empty } from "../components/primitives";
import { addressesApi } from "../data/api";

export function CustomerAddressesPanel() {
  const [items, setItems] = useState<{ id: string; title: string; recipient: string; city: string; line: string; is_default: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "خانه", recipient: "", phone: "09123456789", province: "تهران", city: "تهران", line: "خیابان نمونه پلاک ۱", postalCode: "1234567890", isDefault: false });
  const load = async () => {
    setError(null);
    try { const r = await addressesApi.list() as { items: typeof items }; setItems(r.items); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  useEffect(() => { void load(); }, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState label="در حال بارگذاری آدرس‌ها…" />;
  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <div className="grid gap-4 md:grid-cols-2">
        {items.length === 0 ? <Empty title="آدرسی ثبت نشده" desc="برای ارسال سفارش‌ها آدرس خود را اضافه کنید." /> : items.map((a) => (
          <Card key={a.id} className="p-4">
            <p className="text-[13px] font-bold">{a.title} {a.is_default && <span className="rounded bg-[#E7F0E6] px-2 py-0.5 text-[10px] text-[#3E6B4A]">پیش‌فرض</span>}</p>
            <p className="mt-1 text-xs text-[var(--kv-muted)]">{a.recipient} — {a.city}</p>
            <p className="text-xs">{a.line}</p>
            <Btn variant="ghost" size="sm" className="mt-2" onClick={async () => { await addressesApi.remove(a.id); void load(); }}>حذف</Btn>
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <p className="text-[13px] font-bold">افزودن آدرس جدید</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <Field label="عنوان"><Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} /></Field>
          <Field label="گیرنده"><Input value={form.recipient} onChange={(v) => setForm({ ...form, recipient: v })} /></Field>
          <Field label="شهر"><Input value={form.city} onChange={(v) => setForm({ ...form, city: v })} /></Field>
          <Field label="کد پستی"><Input value={form.postalCode} onChange={(v) => setForm({ ...form, postalCode: v })} /></Field>
          <Field label="آدرس کامل"><Input value={form.line} onChange={(v) => setForm({ ...form, line: v })} /></Field>
        </div>
        <Btn variant="accent" size="sm" className="mt-3" onClick={async () => { await addressesApi.create(form); void load(); }}>ذخیره آدرس</Btn>
      </Card>
    </div>
  );
}
