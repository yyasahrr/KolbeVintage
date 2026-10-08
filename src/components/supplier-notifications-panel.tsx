import { useCallback, useEffect, useState } from "react";
import { Bell, CheckCheck, RefreshCw } from "lucide-react";
import { Btn, Card, Empty, ErrorState, LoadingState } from "./primitives";
import { notificationsApi } from "../data/api";

type SupplierNotification = {
  id: string;
  title: string;
  body: string;
  priority: "low" | "normal" | "high" | "critical";
  read_at: string | null;
  created_at: string;
};

const PRIORITY: Record<SupplierNotification["priority"], string> = {
  low: "عادی", normal: "عادی", high: "مهم", critical: "فوری",
};

export function SupplierNotificationsPanel() {
  const [items, setItems] = useState<SupplierNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [list, count] = await Promise.all([
        notificationsApi.list({ limit: "100" }) as Promise<{ items: SupplierNotification[] }>,
        notificationsApi.unreadCount(),
      ]);
      setItems(list.items);
      setUnread(count.count);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "خطا در دریافت اعلان‌ها");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const markRead = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await notificationsApi.read(id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "خطا در به‌روزرسانی اعلان");
    } finally {
      setBusyId(null);
    }
  };

  const markAllRead = async () => {
    setBusyId("all");
    setError(null);
    try {
      await notificationsApi.readAll();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "خطا در خواندن همه اعلان‌ها");
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !items) return <LoadingState label="در حال بارگذاری اعلان‌های حساب شما…" />;
  if (error && !items) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[14px] font-extrabold"><Bell size={16} />صندوق اعلان‌های حساب</h2>
          <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">فقط اعلان‌های متعلق به حساب تأمین‌کننده شما نمایش داده می‌شود.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11px] font-bold">خوانده‌نشده: {unread.toLocaleString("fa-IR")}</span>
          <Btn size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void load()}>به‌روزرسانی</Btn>
          <Btn size="sm" variant="soft" disabled={unread === 0 || busyId !== null}
            icon={<CheckCheck size={13} />} onClick={() => void markAllRead()}>خواندن همه</Btn>
        </div>
      </div>
      {error && <p role="alert" className="rounded-[10px] bg-[var(--kv-danger)]/[0.08] px-3 py-2 text-[12px] text-[var(--kv-danger)]">{error}</p>}
      <Card className="divide-y divide-[var(--kv-line)] overflow-hidden">
        {items?.length ? items.map((item) => (
          <article key={item.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-bold">{item.title}</h3>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${item.read_at ? "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]" : "bg-[var(--kv-accent)] text-white"}`}>
                  {item.read_at ? "خوانده‌شده" : "جدید"}
                </span>
                <span className="text-[10.5px] text-[var(--kv-muted)]">{PRIORITY[item.priority] ?? item.priority}</span>
              </div>
              <p className="mt-1 text-[12px] leading-6 text-[var(--kv-ink-2)]">{item.body}</p>
              <time className="mt-1 block text-[10.5px] tabular-nums text-[var(--kv-faint)]" dateTime={item.created_at}>
                {new Date(item.created_at).toLocaleString("fa-IR")}
              </time>
            </div>
            {!item.read_at && <Btn size="sm" variant="ghost" disabled={busyId !== null} onClick={() => void markRead(item.id)}>خوانده شد</Btn>}
          </article>
        )) : <div className="p-5"><Empty title="اعلانی ندارید" desc="اعلان‌های حساب تأمین‌کننده در اینجا نمایش داده می‌شود." /></div>}
      </Card>
    </div>
  );
}
