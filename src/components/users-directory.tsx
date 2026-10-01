import { useEffect, useState } from "react";
import { Btn, Card, Empty, Field, Input, LoadingState, Select } from "./primitives";
import { adminApi } from "../data/api";

type F = (message: string) => void;

const ROLE_LABEL: Record<string, string> = {
  customer: "مشتری", supplier: "تأمین‌کننده", support: "پشتیبانی", operations: "عملیات", finance: "مالی", admin: "مدیر کل",
};
const SORT_LABEL: Record<string, string> = {
  newest: "جدیدترین", oldest: "قدیمی‌ترین", orders: "بیشترین سفارش", spent: "بیشترین خرید", last_order: "آخرین سفارش",
};
const fmtToman = (rial: unknown) => `${(Number(rial ?? 0) / 10).toLocaleString("fa-IR")} تومان`;
const fmtDate = (value: unknown) => value ? new Date(String(value)).toLocaleDateString("fa-IR") : "—";

/**
 * Server-side user directory (Requirements 19-20): search and every filter run
 * in PostgreSQL through GET /admin/users — the client never pretends a local
 * slice of rows is "search".
 */
export function UsersDirectoryPanel({ flash }: { flash: F }) {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const [filters, setFilters] = useState({
    search: "", role: "", status: "", city: "", minOrders: "", minSpentToman: "", sort: "newest",
  });

  const load = async (nextOffset = 0) => {
    try {
      const res = await adminApi.users({
        ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
        ...(filters.role ? { role: filters.role } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.city.trim() ? { city: filters.city.trim() } : {}),
        ...(filters.minOrders ? { minOrders: filters.minOrders } : {}),
        ...(filters.minSpentToman ? { minSpentRial: String(Number(filters.minSpentToman) * 10) } : {}),
        sort: filters.sort, limit, offset: nextOffset,
      });
      setItems(res.items ?? []); setTotal(res.total ?? 0); setOffset(nextOffset);
    } catch (e) { setItems([]); flash(e instanceof Error ? e.message : "خطا در دریافت فهرست کاربران"); }
  };
  useEffect(() => { void load(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filters.role, filters.status, filters.sort]);

  return (
    <div className="animate-[fadeUp_0.35s_ease] space-y-4">
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="sm:col-span-2">
            <Field label="جست‌وجو (نام، تلفن، ایمیل، شناسه)">
              <Input value={filters.search} onChange={(v) => setFilters({ ...filters, search: v })} placeholder="مثلاً ۰۹۱۲…" />
            </Field>
          </div>
          <Field label="نقش">
            <Select options={["همه", ...Object.values(ROLE_LABEL)]}
              value={filters.role ? ROLE_LABEL[filters.role] : "همه"}
              onChange={(label) => setFilters({ ...filters, role: Object.entries(ROLE_LABEL).find(([, l]) => l === label)?.[0] ?? "" })} />
          </Field>
          <Field label="وضعیت">
            <Select options={["همه", "فعال", "معلق"]}
              value={filters.status === "active" ? "فعال" : filters.status === "suspended" ? "معلق" : "همه"}
              onChange={(label) => setFilters({ ...filters, status: label === "فعال" ? "active" : label === "معلق" ? "suspended" : "" })} />
          </Field>
          <Field label="شهر"><Input value={filters.city} onChange={(v) => setFilters({ ...filters, city: v })} /></Field>
          <Field label="مرتب‌سازی">
            <Select options={Object.values(SORT_LABEL)} value={SORT_LABEL[filters.sort]}
              onChange={(label) => setFilters({ ...filters, sort: Object.entries(SORT_LABEL).find(([, l]) => l === label)?.[0] ?? "newest" })} />
          </Field>
          <Field label="حداقل تعداد سفارش"><Input value={filters.minOrders} onChange={(v) => setFilters({ ...filters, minOrders: v.replace(/\D/g, "") })} /></Field>
          <Field label="حداقل مجموع خرید (تومان)"><Input value={filters.minSpentToman} onChange={(v) => setFilters({ ...filters, minSpentToman: v.replace(/\D/g, "") })} /></Field>
          <div className="flex items-end"><Btn variant="accent" size="sm" onClick={() => void load(0)}>اعمال جست‌وجو</Btn></div>
        </div>
        <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
          جست‌وجو و همه فیلترها سمت سرور (PostgreSQL) اجرا می‌شوند؛ «سگمنت» در CRM و «منبع جذب» هنوز در دامنه کاربر تعریف نشده‌اند.
        </p>
      </Card>

      {items === null ? <LoadingState label="در حال دریافت کاربران…" /> : items.length === 0 ? (
        <Empty title="کاربری مطابق فیلترها پیدا نشد" desc="عبارت جست‌وجو یا فیلترها را تغییر دهید." />
      ) : (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[960px]">
              <thead><tr><th>کاربر</th><th>تماس</th><th>نقش‌ها</th><th>وضعیت</th><th>شهر</th><th>سفارش‌ها</th><th>مجموع خرید</th><th>آخرین سفارش</th><th>عضویت</th></tr></thead>
              <tbody>
                {items.map((u) => (
                  <tr key={String(u.id)}>
                    <td><b>{String(u.display_name ?? "—")}</b><span className="block text-[10.5px] text-[var(--kv-muted)]" dir="ltr">{String(u.id).slice(0, 8)}…</span></td>
                    <td className="text-[12px]" dir="ltr">{String(u.phone ?? u.email ?? "—")}</td>
                    <td className="text-[11.5px]">{((u.roles ?? []) as string[]).map((r) => ROLE_LABEL[r] ?? r).join("، ") || "—"}</td>
                    <td>{String(u.status) === "active" ? "فعال" : "معلق"}</td>
                    <td>{String(u.city ?? "—")}</td>
                    <td className="tabular-nums">{Number(u.order_count ?? 0).toLocaleString("fa-IR")}</td>
                    <td className="tabular-nums">{fmtToman(u.total_spent_rial)}</td>
                    <td className="text-[12px]">{fmtDate(u.last_order_at)}</td>
                    <td className="text-[12px]">{fmtDate(u.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-3 text-[12px] text-[var(--kv-muted)]">
            <span>{total.toLocaleString("fa-IR")} کاربر · صفحه {(Math.floor(offset / limit) + 1).toLocaleString("fa-IR")} از {Math.max(1, Math.ceil(total / limit)).toLocaleString("fa-IR")}</span>
            <span className="flex gap-2">
              <Btn variant="soft" size="sm" disabled={offset === 0} onClick={() => void load(Math.max(0, offset - limit))}>قبلی</Btn>
              <Btn variant="soft" size="sm" disabled={offset + limit >= total} onClick={() => void load(offset + limit)}>بعدی</Btn>
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
