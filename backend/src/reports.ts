/* Report centre (items 166-168).
 *
 * Every report is defined once as SQL + column metadata. The same definition
 * produces the JSON the UI renders, the CSV/XLSX/PDF exports — so an exported
 * number can always be traced back to the ledger row that produced it.
 */
import type { PoolClient } from 'pg';
import { renderTablePdf, type PdfColumn } from './pdf.js';
import { buildCsv, buildXlsx } from './xlsx.js';

export type ReportColumn = { key: string; label: string; kind?: 'text' | 'money' | 'count' | 'date' | 'percent' };

export type ReportDefinition = {
  code: string;
  title: string;
  description: string;
  category: 'revenue' | 'settlement' | 'receivable' | 'payable' | 'operations' | 'ledger';
  columns: ReportColumn[];
  sql: string;
  /** Documents every number in the export so finance can audit the report. */
  drilldown?: string;
};

export type ReportFormat = 'csv' | 'xlsx' | 'pdf';

export type ReportResult = {
  code: string; title: string; description: string; category: string;
  range: { from: string; to: string };
  rows: Array<Record<string, unknown>>; totals: Record<string, string>;
  generatedAt: string; columns: ReportColumn[];
};

export type ReportQuery = {
  from: Date; to: Date; supplierId?: string; status?: string; groupBy?: string; limit?: number;
};

/** All report SQL accepts ($1 from, $2 to, $3 supplierId|NULL, $4 limit). */
export const REPORT_DEFINITIONS: ReportDefinition[] = [
  {
    code: 'revenue',
    title: 'گزارش درآمد',
    description: 'درآمد ثبت‌شده در دفتر کل به تفکیک حساب و کانال فروش',
    category: 'revenue',
    drilldown: 'journal_lines',
    columns: [
      { key: 'day', label: 'تاریخ', kind: 'date' },
      { key: 'account', label: 'حساب' },
      { key: 'channel', label: 'کانال' },
      { key: 'amount', label: 'مبلغ (ریال)', kind: 'money' },
      { key: 'entries', label: 'تعداد سند', kind: 'count' },
    ],
    sql: `SELECT to_char(je.created_at, 'YYYY-MM-DD') AS day, la.title AS account,
                 COALESCE(NULLIF(jl.dimensions->>'channel',''), 'retail') AS channel,
                 SUM(jl.credit_rial - jl.debit_rial)::text AS amount, COUNT(DISTINCT je.id)::int AS entries
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.entry_id
            JOIN ledger_accounts la ON la.id = jl.account_id
           WHERE la.account_type = 'revenue' AND je.created_at >= $1 AND je.created_at < $2
             AND ($3::uuid IS NULL OR jl.supplier_id = $3)
           GROUP BY 1,2,3 ORDER BY 1 DESC, 4 DESC LIMIT $4`,
  },
  {
    code: 'gross_sales',
    title: 'فروش ناخالص به تفکیک کانال',
    description: 'فروش خرده/عمده/ویژه از سفارش‌های پرداخت‌شده، با تفکیک تأمین‌کننده',
    category: 'revenue',
    drilldown: 'order_lines',
    columns: [
      { key: 'day', label: 'تاریخ', kind: 'date' },
      { key: 'channel', label: 'کانال' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'orders', label: 'سفارش', kind: 'count' },
      { key: 'quantity', label: 'تعداد', kind: 'count' },
      { key: 'gross', label: 'فروش ناخالص (ریال)', kind: 'money' },
    ],
    sql: `SELECT to_char(o.created_at, 'YYYY-MM-DD') AS day,
                 CASE WHEN o.order_type = 'wholesale' THEN 'wholesale' ELSE 'retail' END AS channel,
                 COALESCE(u.display_name, 'کلبه وینتج') AS supplier,
                 COUNT(DISTINCT o.id)::int AS orders, SUM(ol.quantity)::int AS quantity,
                 SUM(ol.line_total_rial)::text AS gross
            FROM order_lines ol JOIN orders o ON o.id = ol.order_id
            LEFT JOIN users u ON u.id = ol.supplier_id
           WHERE o.status NOT IN ('cancelled','pending_payment') AND o.created_at >= $1 AND o.created_at < $2
             AND ($3::uuid IS NULL OR ol.supplier_id = $3)
           GROUP BY 1,2,3 ORDER BY 1 DESC, 6 DESC LIMIT $4`,
  },
  {
    code: 'commission',
    title: 'کارمزد کلبه',
    description: 'کارمزد بازارچه به تفکیک تأمین‌کننده از دفتر معین تأمین‌کنندگان',
    category: 'revenue',
    drilldown: 'supplier_ledger_entries',
    columns: [
      { key: 'month', label: 'ماه' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'entries', label: 'تعداد', kind: 'count' },
      { key: 'commission', label: 'کارمزد (ریال)', kind: 'money' },
    ],
    sql: `SELECT to_char(e.occurred_at, 'YYYY-MM') AS month, u.display_name AS supplier,
                 COUNT(*)::int AS entries, SUM(e.amount_rial)::text AS commission
            FROM supplier_ledger_entries e JOIN users u ON u.id = e.supplier_id
           WHERE e.event = 'commission' AND e.occurred_at >= $1 AND e.occurred_at < $2
             AND ($3::uuid IS NULL OR e.supplier_id = $3)
           GROUP BY 1,2 ORDER BY 4 DESC LIMIT $4`,
  },
  {
    code: 'returns',
    title: 'مرجوعی و بازپرداخت',
    description: 'مرجوعی‌های تأییدشده و کسر آن از مطالبات تأمین‌کننده',
    category: 'revenue',
    columns: [
      { key: 'day', label: 'تاریخ', kind: 'date' },
      { key: 'reference', label: 'سفارش' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'status', label: 'وضعیت' },
      { key: 'amount', label: 'مبلغ (ریال)', kind: 'money' },
    ],
    sql: `SELECT to_char(r.created_at, 'YYYY-MM-DD') AS day, o.reference,
                 COALESCE(u.display_name, '—') AS supplier, r.status, r.amount_rial::text AS amount
            FROM return_requests r JOIN orders o ON o.id = r.order_id
            LEFT JOIN order_lines ol ON ol.id = r.order_line_id
            LEFT JOIN users u ON u.id = ol.supplier_id
           WHERE r.created_at >= $1 AND r.created_at < $2 AND ($3::uuid IS NULL OR ol.supplier_id = $3)
           ORDER BY 1 DESC LIMIT $4`,
  },
  {
    code: 'shipping_cost',
    title: 'هزینه ارسال و سهم تأمین‌کنندگان',
    description: 'ارسال سفارش‌ها و تخصیص هزینه بر اساس قاعده ثبت‌شده',
    category: 'operations',
    columns: [
      { key: 'day', label: 'تاریخ', kind: 'date' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'orders', label: 'سفارش', kind: 'count' },
      { key: 'charged', label: 'سهم تأمین‌کننده (ریال)', kind: 'money' },
    ],
    sql: `SELECT to_char(a.created_at, 'YYYY-MM-DD') AS day, COALESCE(u.display_name, '—') AS supplier,
                 COUNT(DISTINCT a.id)::int AS orders, COALESCE(SUM(l.amount_rial), 0)::text AS charged
            FROM shipping_allocations a
            LEFT JOIN shipping_allocation_lines l ON l.allocation_id = a.id
            LEFT JOIN users u ON u.id = l.supplier_id
           WHERE a.created_at >= $1 AND a.created_at < $2 AND ($3::uuid IS NULL OR l.supplier_id = $3)
           GROUP BY 1,2 ORDER BY 1 DESC LIMIT $4`,
  },
  {
    code: 'supplier_statement',
    title: 'صورت‌حساب تأمین‌کننده',
    description: 'گردش بدهکار/بستانکار با مانده جاری برای هر تأمین‌کننده',
    category: 'payable',
    drilldown: 'supplier_ledger_entries',
    columns: [
      { key: 'occurred_at', label: 'تاریخ', kind: 'date' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'event', label: 'رویداد' },
      { key: 'debit', label: 'بدهکار', kind: 'money' },
      { key: 'credit', label: 'بستانکار', kind: 'money' },
      { key: 'balance', label: 'مانده', kind: 'money' },
      { key: 'reference', label: 'مرجع' },
    ],
    sql: `SELECT to_char(e.occurred_at, 'YYYY-MM-DD') AS occurred_at, u.display_name AS supplier, e.event,
                 CASE WHEN e.direction = 'debit' THEN e.amount_rial ELSE 0 END::text AS debit,
                 CASE WHEN e.direction = 'credit' THEN e.amount_rial ELSE 0 END::text AS credit,
                 e.balance_after_rial::text AS balance, e.reference
            FROM supplier_ledger_entries e JOIN users u ON u.id = e.supplier_id
           WHERE e.occurred_at >= $1 AND e.occurred_at < $2 AND ($3::uuid IS NULL OR e.supplier_id = $3)
           ORDER BY e.occurred_at DESC, e.id DESC LIMIT $4`,
  },
  {
    code: 'payables_aging',
    title: 'سن مطالبات تأمین‌کنندگان',
    description: 'مانده پرداختنی در سبدهای سررسیدنشده تا بیش از ۹۰ روز',
    category: 'payable',
    columns: [
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'not_due', label: 'سررسیدنشده', kind: 'money' },
      { key: 'days_1_7', label: '۱-۷ روز', kind: 'money' },
      { key: 'days_8_30', label: '۸-۳۰ روز', kind: 'money' },
      { key: 'days_31_60', label: '۳۱-۶۰ روز', kind: 'money' },
      { key: 'days_61_90', label: '۶۱-۹۰ روز', kind: 'money' },
      { key: 'days_over_90', label: 'بیش از ۹۰ روز', kind: 'money' },
      { key: 'total', label: 'جمع', kind: 'money' },
    ],
    sql: `WITH running AS (
            SELECT supplier_id, occurred_at, amount_rial,
                   SUM(amount_rial) OVER (PARTITION BY supplier_id ORDER BY occurred_at DESC, id DESC) AS from_newest
              FROM supplier_ledger_entries WHERE direction = 'credit'
          ), outstanding AS (
            SELECT r.supplier_id, r.occurred_at,
                   GREATEST(LEAST(r.amount_rial, COALESCE(b.balance, 0) - (r.from_newest - r.amount_rial)), 0) AS unpaid
              FROM running r
              JOIN (SELECT supplier_id, SUM(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END) AS balance
                      FROM supplier_ledger_entries GROUP BY supplier_id) b ON b.supplier_id = r.supplier_id
          )
          SELECT u.display_name AS supplier,
                 SUM(CASE WHEN o.occurred_at + interval '30 days' >= now() THEN o.unpaid ELSE 0 END)::text AS not_due,
                 SUM(CASE WHEN o.occurred_at + interval '30 days' < now() AND o.occurred_at + interval '37 days' >= now() THEN o.unpaid ELSE 0 END)::text AS days_1_7,
                 SUM(CASE WHEN o.occurred_at + interval '37 days' < now() AND o.occurred_at + interval '60 days' >= now() THEN o.unpaid ELSE 0 END)::text AS days_8_30,
                 SUM(CASE WHEN o.occurred_at + interval '60 days' < now() AND o.occurred_at + interval '90 days' >= now() THEN o.unpaid ELSE 0 END)::text AS days_31_60,
                 SUM(CASE WHEN o.occurred_at + interval '90 days' < now() AND o.occurred_at + interval '120 days' >= now() THEN o.unpaid ELSE 0 END)::text AS days_61_90,
                 SUM(CASE WHEN o.occurred_at + interval '120 days' < now() THEN o.unpaid ELSE 0 END)::text AS days_over_90,
                 SUM(o.unpaid)::text AS total
            FROM outstanding o JOIN users u ON u.id = o.supplier_id
           WHERE ($3::uuid IS NULL OR o.supplier_id = $3)
           GROUP BY 1 HAVING SUM(o.unpaid) <> 0 ORDER BY SUM(o.unpaid) DESC LIMIT $4`,
  },
  {
    code: 'receivables',
    title: 'مطالبات از مشتریان',
    description: 'مانده فاکتورهای باز مشتریان با سن مطالبه',
    category: 'receivable',
    columns: [
      { key: 'reference', label: 'فاکتور' },
      { key: 'customer', label: 'مشتری' },
      { key: 'issue_date', label: 'تاریخ صدور', kind: 'date' },
      { key: 'due_date', label: 'سررسید', kind: 'date' },
      { key: 'total', label: 'مبلغ کل', kind: 'money' },
      { key: 'paid', label: 'پرداخت‌شده', kind: 'money' },
      { key: 'remaining', label: 'مانده', kind: 'money' },
      { key: 'age_days', label: 'سن (روز)', kind: 'count' },
    ],
    sql: `SELECT i.reference, COALESCE(i.buyer->>'name', '—') AS customer, i.issue_date, i.due_date,
                 i.total_rial::text AS total, i.paid_rial::text AS paid, i.remaining_rial::text AS remaining,
                 GREATEST(0, current_date - COALESCE(i.due_date, i.issue_date)) AS age_days
            FROM invoices i
           WHERE i.status IN ('issued','partially_paid') AND i.remaining_rial > 0
             AND i.created_at >= $1 AND i.created_at < $2
           ORDER BY age_days DESC LIMIT $4`,
  },
  {
    code: 'settlements',
    title: 'تسویه‌ها',
    description: 'وضعیت تأیید، پرداخت و مغایرت‌یابی هر تسویه',
    category: 'settlement',
    drilldown: 'settlements',
    columns: [
      { key: 'reference', label: 'مرجع' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'status', label: 'وضعیت' },
      { key: 'reconciliation', label: 'مغایرت‌یابی' },
      { key: 'gross', label: 'ناخالص', kind: 'money' },
      { key: 'commission', label: 'کارمزد', kind: 'money' },
      { key: 'shipping', label: 'ارسال', kind: 'money' },
      { key: 'returns', label: 'مرجوعی', kind: 'money' },
      { key: 'net', label: 'خالص پرداختی', kind: 'money' },
      { key: 'created_at', label: 'ایجاد', kind: 'date' },
    ],
    sql: `SELECT s.reference, u.display_name AS supplier, s.status, s.reconciliation_status,
                 s.gross_rial::text AS gross, s.commission_rial::text AS commission, s.shipping_rial::text AS shipping,
                 s.returns_rial::text AS returns, s.net_rial::text AS net, to_char(s.created_at, 'YYYY-MM-DD') AS created_at
            FROM settlements s JOIN users u ON u.id = s.party_user_id
           WHERE s.created_at >= $1 AND s.created_at < $2 AND ($3::uuid IS NULL OR s.party_user_id = $3)
           ORDER BY s.created_at DESC LIMIT $4`,
  },
  {
    code: 'settlement_exceptions',
    title: 'مغایرت‌های تسویه',
    description: 'استثناهای مغایرت‌یابی سفارش/تحویل/مطالبات و وضعیت رفع آن‌ها',
    category: 'settlement',
    columns: [
      { key: 'settlement', label: 'تسویه' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'code', label: 'کد' },
      { key: 'severity', label: 'شدت' },
      { key: 'detail', label: 'توضیح' },
      { key: 'expected', label: 'مورد انتظار', kind: 'money' },
      { key: 'found', label: 'یافت‌شده', kind: 'money' },
      { key: 'status', label: 'وضعیت' },
    ],
    sql: `SELECT s.reference AS settlement, u.display_name AS supplier, e.code, e.severity, e.detail,
                 COALESCE(e.expected_rial, 0)::text AS expected, COALESCE(e.found_rial, 0)::text AS found, e.status
            FROM settlement_exceptions e
            JOIN settlements s ON s.id = e.settlement_id JOIN users u ON u.id = s.party_user_id
           WHERE e.created_at >= $1 AND e.created_at < $2 AND ($3::uuid IS NULL OR s.party_user_id = $3)
           ORDER BY e.created_at DESC LIMIT $4`,
  },
  {
    code: 'adjustments',
    title: 'اصلاحات مالی',
    description: 'بستانکار/بدهکار دستی تأمین‌کنندگان با وضعیت تأیید',
    category: 'ledger',
    columns: [
      { key: 'reference', label: 'مرجع' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'direction', label: 'جهت' },
      { key: 'category', label: 'دسته' },
      { key: 'amount', label: 'مبلغ', kind: 'money' },
      { key: 'status', label: 'وضعیت' },
      { key: 'reason', label: 'دلیل' },
      { key: 'created_at', label: 'تاریخ', kind: 'date' },
    ],
    sql: `SELECT a.reference, COALESCE(u.display_name, '—') AS supplier, a.direction, a.category,
                 a.amount_rial::text AS amount, a.status, a.reason, to_char(a.created_at, 'YYYY-MM-DD') AS created_at
            FROM financial_adjustments a LEFT JOIN users u ON u.id = a.supplier_id
           WHERE a.created_at >= $1 AND a.created_at < $2 AND ($3::uuid IS NULL OR a.supplier_id = $3)
           ORDER BY a.created_at DESC LIMIT $4`,
  },
  {
    code: 'advances',
    title: 'پیش‌پرداخت‌ها',
    description: 'پیش‌پرداخت به تأمین‌کنندگان و میزان اعمال‌شده',
    category: 'payable',
    columns: [
      { key: 'reference', label: 'مرجع' },
      { key: 'supplier', label: 'تأمین‌کننده' },
      { key: 'amount', label: 'مبلغ', kind: 'money' },
      { key: 'applied', label: 'اعمال‌شده', kind: 'money' },
      { key: 'status', label: 'وضعیت' },
      { key: 'created_at', label: 'تاریخ', kind: 'date' },
    ],
    sql: `SELECT a.reference, u.display_name AS supplier, a.amount_rial::text AS amount,
                 a.applied_rial::text AS applied, a.status, to_char(a.created_at, 'YYYY-MM-DD') AS created_at
            FROM supplier_advances a JOIN users u ON u.id = a.supplier_id
           WHERE a.created_at >= $1 AND a.created_at < $2 AND ($3::uuid IS NULL OR a.supplier_id = $3)
           ORDER BY a.created_at DESC LIMIT $4`,
  },
  {
    code: 'ledger_balances',
    title: 'مانده حساب‌های دفتر کل',
    description: 'جمع بدهکار/بستانکار هر حساب در بازه انتخابی',
    category: 'ledger',
    columns: [
      { key: 'code', label: 'کد حساب' },
      { key: 'title', label: 'حساب' },
      { key: 'type', label: 'نوع' },
      { key: 'debit', label: 'بدهکار', kind: 'money' },
      { key: 'credit', label: 'بستانکار', kind: 'money' },
      { key: 'balance', label: 'مانده', kind: 'money' },
    ],
    sql: `SELECT la.code, la.title, la.account_type AS type,
                 COALESCE(SUM(jl.debit_rial), 0)::text AS debit,
                 COALESCE(SUM(jl.credit_rial), 0)::text AS credit,
                 (COALESCE(SUM(jl.credit_rial), 0) - COALESCE(SUM(jl.debit_rial), 0))::text AS balance
            FROM ledger_accounts la
            LEFT JOIN journal_lines jl ON jl.account_id = la.id
            LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.created_at >= $1 AND je.created_at < $2
           WHERE jl.id IS NULL OR (je.id IS NOT NULL AND ($3::uuid IS NULL OR jl.supplier_id = $3))
           GROUP BY 1,2,3 ORDER BY la.code LIMIT $4`,
  },
  {
    code: 'periods',
    title: 'دوره‌های مالی',
    description: 'وضعیت دوره‌ها (باز/بسته/قفل) و جمع درآمد ثبت‌شده',
    category: 'ledger',
    columns: [
      { key: 'code', label: 'دوره' },
      { key: 'status', label: 'وضعیت' },
      { key: 'entries', label: 'اسناد', kind: 'count' },
      { key: 'revenue', label: 'درآمد (ریال)', kind: 'money' },
    ],
    sql: `SELECT p.code, p.status,
                 COALESCE((SELECT COUNT(*) FROM journal_entries je WHERE je.period_code = p.code), 0)::int AS entries,
                 COALESCE((SELECT SUM(jl.credit_rial - jl.debit_rial) FROM journal_lines jl
                             JOIN journal_entries je ON je.id = jl.entry_id
                             JOIN ledger_accounts la ON la.id = jl.account_id
                            WHERE la.account_type = 'revenue' AND je.period_code = p.code), 0)::text AS revenue
            FROM accounting_periods p ORDER BY p.code DESC LIMIT $4`,
  },
  {
    code: 'wallet_activity',
    title: 'کیف پول تأمین‌کنندگان',
    description: 'برداشت‌ها و واریزهای کیف پول به تفکیک نوع',
    category: 'operations',
    columns: [
      { key: 'day', label: 'تاریخ', kind: 'date' },
      { key: 'kind', label: 'نوع' },
      { key: 'direction', label: 'جهت' },
      { key: 'entries', label: 'تعداد', kind: 'count' },
      { key: 'amount', label: 'مبلغ', kind: 'money' },
    ],
    sql: `SELECT to_char(w.created_at, 'YYYY-MM-DD') AS day, w.kind, w.direction, COUNT(*)::int AS entries,
                 SUM(w.amount_rial)::text AS amount
            FROM wallet_entries w JOIN wallet_accounts a ON a.id = w.account_id
           WHERE w.created_at >= $1 AND w.created_at < $2 AND ($3::uuid IS NULL OR a.user_id = $3)
           GROUP BY 1,2,3 ORDER BY 1 DESC LIMIT $4`,
  },
];

export const REPORT_CATALOG = REPORT_DEFINITIONS.map((definition) => ({
  code: definition.code, title: definition.title, description: definition.description,
  category: definition.category, columns: definition.columns,
}));

const moneyColumns = (columns: ReportColumn[]) => columns.filter((column) => column.kind === 'money');

export async function runReport(client: PoolClient, code: string, query: ReportQuery): Promise<ReportResult> {
  const definition = REPORT_DEFINITIONS.find((item) => item.code === code);
  if (!definition) throw Object.assign(new Error(`گزارش ${code} یافت نشد.`), { statusCode: 404 });
  // Every report receives the same four parameters, but a report that does not use
  // all of them would leave PostgreSQL unable to infer a type ("could not determine
  // data type of parameter $3"). The leading CTE pins all four types once, so a
  // report can ignore any of them without failing.
  const parameters = `report_params AS (SELECT $1::timestamptz AS from_ts, $2::timestamptz AS to_ts,
      $3::uuid AS supplier_id, $4::int AS limit_rows)`;
  const body = definition.sql.trimStart();
  const statement = /^WITH\b/i.test(body)
    ? body.replace(/^WITH\b/i, `WITH ${parameters},`)
    : `WITH ${parameters}\n${body}`;
  const rows = (await client.query(statement, [query.from, query.to, query.supplierId ?? null, query.limit ?? 500])).rows;
  const totals: Record<string, string> = {};
  for (const column of moneyColumns(definition.columns)) {
    const sum = rows.reduce((accumulator, row) => accumulator + BigInt(String(row[column.key] ?? '0').replace(/[^\d]/g, '') || '0'), 0n);
    totals[column.key] = sum.toString();
  }
  return {
    code, title: definition.title, description: definition.description, category: definition.category,
    range: { from: query.from.toISOString(), to: query.to.toISOString() },
    rows: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === 'bigint' ? value.toString() : value]))),
    totals, generatedAt: new Date().toISOString(), columns: definition.columns,
  };
}

const cellValue = (value: unknown) => (value === null || value === undefined ? '—' : String(value));

export async function exportReport(result: ReportResult, format: ReportFormat): Promise<{ body: Buffer; contentType: string; extension: string }> {
  const header = result.columns.map((column) => column.label);
  const tableRows = result.rows.map((row) => result.columns.map((column) => cellValue(row[column.key])));
  if (format === 'csv') {
    return { body: buildCsv(header, tableRows), contentType: 'text/csv; charset=utf-8', extension: 'csv' };
  }
  if (format === 'xlsx') {
    const numeric = result.rows.map((row) => result.columns.map((column) => {
      const raw = row[column.key];
      if (column.kind === 'money' || column.kind === 'count') {
        const parsed = Number(String(raw ?? '0').replace(/[^\d.-]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
      }
      return cellValue(raw);
    }));
    return { body: buildXlsx([{ name: result.title, columns: header, rows: numeric }]),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
  }
  const columns: PdfColumn[] = result.columns.map((column) => ({
    key: column.key,
    label: column.label,
    width: Math.floor(515 / Math.max(result.columns.length, 1)),
    align: column.kind === 'money' || column.kind === 'count' ? 'left' : 'right',
  }));
  const totals = Object.entries(result.totals).map(([key, value]) => ({
    label: `${result.columns.find((column) => column.key === key)?.label ?? key} (جمع)`, value,
  }));
  const bytes = await renderTablePdf({
    title: result.title,
    subtitle: `${result.description} — از ${result.range.from.slice(0, 10)} تا ${result.range.to.slice(0, 10)}`,
    columns, rows: result.rows.map((row) => Object.fromEntries(result.columns.map((column) => [column.key, cellValue(row[column.key])]))),
    totals, footerText: 'مرکز گزارش‌های مالی کلبه وینتج',
  });
  return { body: Buffer.from(bytes), contentType: 'application/pdf', extension: 'pdf' };
}
