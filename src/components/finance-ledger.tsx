import { useEffect, useState } from "react";
import { Card, LoadingState, ErrorState, Btn } from "../components/primitives";
import { Link2, ReceiptText, ScrollText } from "lucide-react";
import { formatPersianDateTime } from "../data/persian-date";
import { financeApi, invoicesApi } from "../data/api";
import { fmtToman } from "../data/contracts";

export function FinanceLedgerPanel() {
  const [journal, setJournal] = useState<{ items: unknown[] } | null>(null);
  const [accounts, setAccounts] = useState<{ items: unknown[] } | null>(null);
  const [invoices, setInvoices] = useState<{ items: unknown[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      const [j, a, inv] = await Promise.all([
        financeApi.journal() as Promise<{ items: unknown[] }>,
        financeApi.accounts() as Promise<{ items: unknown[] }>,
        invoicesApi.list() as Promise<{ items: unknown[] }>,
      ]);
      setJournal(j); setAccounts(a); setInvoices(inv);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  useEffect(() => { void load(); }, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!journal || !accounts || !invoices) return <LoadingState label="در حال بارگذاری دفتر کل…" />;
  if (journal.items.length === 0) {
    // No fabricated ledger rows: an empty ledger is a legitimate operational state on a fresh install.
    return (
      <div className="space-y-4">
        <Card className="p-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-[14px] bg-[var(--kv-surface-2)]"><ScrollText size={22} className="text-[var(--kv-muted)]" /></span>
          <p className="mt-3 text-[15px] font-extrabold">هنوز رویداد مالی واقعی ایجاد نشده است.</p>
          <p className="mx-auto mt-2 max-w-[640px] text-[12.5px] leading-7 text-[var(--kv-muted)]">
            دفتر کل به‌صورت خودکار و فقط بر پایه رویدادهای واقعی ساخته می‌شود: پرداخت سفارش، بازگشت وجه، تسویه با تأمین‌کننده یا بازارچه و برداشت از کیف پول.
            هیچ سطر ساختگی نمایش داده نمی‌شود؛ پس از نخستین پرداخت واقعی، سطرهای بدهکار/بستانکار همین‌جا ظاهر می‌شوند.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Btn variant="accent" size="sm" icon={<ReceiptText size={14} />} onClick={() => { window.location.hash = "#/admin"; }}>مشاهده سفارش‌ها</Btn>
            <Btn variant="soft" size="sm" icon={<ReceiptText size={14} />} onClick={() => void load()}>فاکتورها ({invoices.items.length.toLocaleString("fa-IR")})</Btn>
            <Btn variant="soft" size="sm" icon={<Link2 size={14} />} onClick={() => void load()}>تسویه‌ها</Btn>
          </div>
          {invoices.items.length > 0 && (
            <p className="mt-3 text-[11.5px] text-[var(--kv-muted)]">
              در این حساب {invoices.items.length.toLocaleString("fa-IR")} فاکتور ثبت شده است؛ با ثبت پرداخت روی فاکتور، سطرهای دفتر کل ساخته می‌شوند.
            </p>
          )}
        </Card>
      </div>
    );
  }
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="grid gap-4 md:grid-cols-3">
        {(accounts.items as { code: string; title: string; account_type: string; total_debit: string; total_credit: string; balance: string }[]).slice(0,6).map((a) => (
          <Card key={a.code} className="p-4">
            <p className="text-[13px] font-bold" title={a.code}>{a.title}</p>
            <p className="text-[11px] text-[var(--kv-muted)]">حساب دفتر کل</p>
            <div className="mt-2 flex justify-between text-xs tabular-nums">
              <span>بدهکار: {fmtToman(a.total_debit)}</span>
              <span>بستانکار: {fmtToman(a.total_credit)}</span>
            </div>
            <p className="mt-1 text-xs font-extrabold tabular-nums">مانده: {fmtToman(a.balance)}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">روزنامه دفتر کل</p></div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[900px] text-xs">
            <thead><tr><th>شماره مرجع</th><th>منبع رویداد</th><th>تاریخ</th><th>سطرها (حساب / بدهکار / بستانکار)</th></tr></thead>
            <tbody>
              {(journal.items as { id: string; reference: string; source_type: string; source_id: string; created_at: string; lines: { account: string; title: string; debitRial: string; creditRial: string }[] }[]).map((e) => (
                <tr key={e.id}>
                  <td className="font-mono">{e.reference}</td>
                  <td>{e.source_type}:{e.source_id.slice(0,8)}</td>
                  <td className="tabular-nums">{formatPersianDateTime(e.created_at)}</td>
                  <td>
                    <div className="space-y-1">
                      {e.lines.map((l) => (
                        <div key={l.account} className="flex justify-between rounded bg-[var(--kv-surface-2)]/60 px-2 py-1">
                          <span title={l.account}>{l.title}</span>
                          <span className="tabular-nums">بدهکار: {fmtToman(l.debitRial)} · بستانکار: {fmtToman(l.creditRial)}</span>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">دفتر فاکتورها</p></div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[700px] text-xs">
            <thead><tr><th>شماره</th><th>نوع</th><th>وضعیت</th><th>مبلغ کل</th><th>پرداخت‌شده</th><th>فایل فاکتور</th></tr></thead>
            <tbody>
              {(invoices.items as { id: string; reference: string; kind: string; status: string; total_rial: string; paid_rial: string }[]).slice(0,20).map((inv) => (
                <tr key={inv.id}>
                  <td className="font-mono">{inv.reference}</td>
                  <td>{inv.kind}</td>
                  <td>{inv.status}</td>
                  <td className="tabular-nums">{fmtToman(inv.total_rial)}</td>
                  <td className="tabular-nums">{fmtToman(inv.paid_rial)}</td>
                  <td><a href={invoicesApi.pdfUrl(inv.id)} target="_blank" rel="noopener" className="text-[var(--kv-accent)] underline">دانلود فاکتور</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
