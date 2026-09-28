import { useEffect, useState } from "react";
import { Card, LoadingState, ErrorState, Empty } from "../components/primitives";
import { financeApi, invoicesApi } from "../data/api";
import { fmtMoney } from "../data/catalog";

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
  if (journal.items.length === 0) return <Empty title="دفتر کل خالی" desc="هنوز رویداد مالی ثبت نشده است." />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="grid gap-4 md:grid-cols-3">
        {(accounts.items as { code: string; title: string; account_type: string; total_debit: string; total_credit: string; balance: string }[]).slice(0,6).map((a) => (
          <Card key={a.code} className="p-4">
            <p className="text-xs text-[var(--kv-muted)]">{a.code}</p>
            <p className="text-[13px] font-bold">{a.title}</p>
            <div className="mt-2 flex justify-between text-xs tabular-nums">
              <span>بدهکار: {fmtMoney(Number(a.total_debit))}</span>
              <span>بستانکار: {fmtMoney(Number(a.total_credit))}</span>
            </div>
            <p className="mt-1 text-xs font-extrabold tabular-nums">مانده: {fmtMoney(Number(a.balance))}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">روزنامه (Journal Entries)</p></div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[900px] text-xs">
            <thead><tr><th>Reference</th><th>Source</th><th>تاریخ</th><th>سطرها (حساب/بدهکار/بستانکار)</th></tr></thead>
            <tbody>
              {(journal.items as { id: string; reference: string; source_type: string; source_id: string; created_at: string; lines: { account: string; title: string; debitRial: string; creditRial: string }[] }[]).map((e) => (
                <tr key={e.id}>
                  <td className="font-mono">{e.reference}</td>
                  <td>{e.source_type}:{e.source_id.slice(0,8)}</td>
                  <td className="tabular-nums">{new Date(e.created_at).toLocaleString("fa-IR")}</td>
                  <td>
                    <div className="space-y-1">
                      {e.lines.map((l) => (
                        <div key={l.account} className="flex justify-between rounded bg-[var(--kv-surface-2)]/60 px-2 py-1">
                          <span>{l.title} ({l.account})</span>
                          <span className="tabular-nums">Dr:{fmtMoney(Number(l.debitRial))} Cr:{fmtMoney(Number(l.creditRial))}</span>
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
        <div className="px-4 py-3"><p className="text-[13px] font-bold">فاکتورها (Invoice Ledger)</p></div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[700px] text-xs">
            <thead><tr><th>شماره</th><th>نوع</th><th>وضعیت</th><th>مبلغ کل</th><th>پرداخت‌شده</th><th>PDF</th></tr></thead>
            <tbody>
              {(invoices.items as { id: string; reference: string; kind: string; status: string; total_rial: string; paid_rial: string }[]).slice(0,20).map((inv) => (
                <tr key={inv.id}>
                  <td className="font-mono">{inv.reference}</td>
                  <td>{inv.kind}</td>
                  <td>{inv.status}</td>
                  <td className="tabular-nums">{fmtMoney(Number(inv.total_rial))}</td>
                  <td className="tabular-nums">{fmtMoney(Number(inv.paid_rial))}</td>
                  <td><a href={invoicesApi.pdfUrl(inv.id)} target="_blank" rel="noopener" className="text-[var(--kv-accent)] underline">PDF</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
