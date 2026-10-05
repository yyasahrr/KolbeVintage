import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Btn, Empty, Input } from "./primitives";
import {
  normalizeTable, tableAddColumn, tableAddRow, tableDeleteColumn, tableDeleteRow,
  tableMoveColumn, tableMoveRow, tableRenameColumn, tableSetCell, type DataTable,
} from "./table-ops";
import { cn } from "../utils/cn";

/** §10/§22: the ONE simple table interaction used by «مشخصات فنی» and «راهنمای سایز».
 *
 *  Arbitrary Admin-defined 2D tables — no template, no schema, no binding. The datasets stay
 *  semantically separate (each own table is persisted on its own endpoint); they are only
 *  edited with the same, simple interaction.
 *
 *  §4 (browser-UAT delta): every mutation goes through the pure operations in `table-ops.ts` and
 *  is applied with exactly ONE `onChange` call. The previous editor called `onChange` twice for
 *  a column delete (columns first, then rows), so the second call reintroduced the deleted column
 *  from the stale render snapshot — the header stayed visible and the delete looked broken.
 *  Single-commit + pure operations remove that whole defect class, and they are unit-tested
 *  without a browser in `backend/scripts/dynamic-table-smoke.ts`.
 */
export { emptyTable, normalizeTable, cellsFor } from "./table-ops";
export type { DataTable, TableColumn, TableRow } from "./table-ops";

export function DynamicTableEditor({
  title, hint, table, onChange, busy, onSave, saved,
}: {
  title: string;
  hint?: string;
  table: DataTable;
  onChange: (next: DataTable) => void;
  /** Present only when the table can be persisted (an existing product). */
  busy?: boolean;
  onSave?: () => void;
  saved?: boolean;
}) {
  const columns = table.columns;
  const rows = table.rows;
  /* ONE commit per user action — see the file header. */
  const commit = (next: DataTable) => onChange(next);

  return (
    <section className="space-y-2.5" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[13px] font-extrabold">{title}</h4>
          {hint && <p className="mt-0.5 text-[11px] leading-5 text-[var(--kv-muted)]">{hint}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => commit(tableAddColumn(table))}>+ افزودن ستون</Btn>
          <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => commit(tableAddRow(table))} disabled={columns.length === 0}>+ افزودن سطر</Btn>
          {onSave && (
            <Btn size="sm" variant="accent" disabled={busy} onClick={onSave}>{busy ? "در حال ذخیره…" : "ذخیره"}</Btn>
          )}
        </div>
      </div>
      {saved && !busy && (
        <p role="status" className="text-[11.5px] font-bold text-emerald-700">ذخیره شد</p>
      )}

      {columns.length === 0 ? (
        <Empty title="هنوز اطلاعاتی ثبت نشده است." desc="برای شروع یک ستون بسازید؛ بعد می‌توانید سطرها را پر کنید." />
      ) : (
        <div className="kv-scroll kv-scroll-x rounded-[12px] border border-[var(--kv-line)]">
          <table className="kv-table min-w-[420px] text-xs">
            <thead>
              <tr>
                <th className="w-10 text-center">ردیف</th>
                {columns.map((column, index) => (
                  <th key={column.id} className="min-w-[140px] align-top">
                    <div className="space-y-1.5">
                      <Input
                        value={column.label}
                        onChange={(label) => commit(tableRenameColumn(table, column.id, label))}
                        ariaLabel={`نام ستون ${index + 1}`}
                        placeholder={`ستون ${index + 1}`}
                      />
                      <div className="flex items-center justify-end gap-1">
                        <IconAction label="انتقال ستون به راست" onClick={() => commit(tableMoveColumn(table, index, 1))} disabled={index === columns.length - 1}><ArrowLeft size={12} /></IconAction>
                        <IconAction label="انتقال ستون به چپ" onClick={() => commit(tableMoveColumn(table, index, -1))} disabled={index === 0}><ArrowRight size={12} /></IconAction>
                        <IconAction label={`حذف ستون ${column.label || index + 1}`} danger onClick={() => commit(tableDeleteColumn(table, column.id))}><Trash2 size={12} /></IconAction>
                      </div>
                    </div>
                  </th>
                ))}
                <th className="w-16 text-center">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 2} className="px-3 py-6 text-center text-[12px] text-[var(--kv-muted)]">
                    هنوز اطلاعاتی ثبت نشده است.
                  </td>
                </tr>
              ) : rows.map((row, index) => (
                <tr key={row.id}>
                  <td className="text-center text-[11px] text-[var(--kv-muted)]">{index + 1}</td>
                  {columns.map((column) => (
                    <td key={column.id}>
                      <input
                        value={row.values[column.id] ?? ""}
                        onChange={(event) => commit(tableSetCell(table, row.id, column.id, event.target.value))}
                        aria-label={`${column.label || "سلول"} — سطر ${index + 1}`}
                        className="h-9 w-full rounded-[8px] border border-transparent bg-transparent px-2 text-[12px] hover:border-[var(--kv-line)] focus:border-[var(--kv-accent)] focus:outline-none"
                      />
                    </td>
                  ))}
                  <td>
                    <div className="flex items-center justify-center gap-1">
                      <IconAction label="انتقال سطر به پایین" onClick={() => commit(tableMoveRow(table, index, 1))} disabled={index === rows.length - 1}><ArrowDown size={12} /></IconAction>
                      <IconAction label="انتقال سطر به بالا" onClick={() => commit(tableMoveRow(table, index, -1))} disabled={index === 0}><ArrowUp size={12} /></IconAction>
                      <IconAction label={`حذف سطر ${index + 1}`} danger onClick={() => commit(tableDeleteRow(table, row.id))}><Trash2 size={12} /></IconAction>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** §14: icon-only actions stay accessible — Persian label, visible focus, ≥ 32px target. */
function IconAction({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-[8px] border border-[var(--kv-line)] text-[var(--kv-muted)] transition-colors",
        "hover:border-[var(--kv-accent)] hover:text-[var(--kv-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]",
        danger && "hover:border-[var(--kv-danger)] hover:text-[var(--kv-danger)]",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {children}
    </button>
  );
}

/** Persistence for one dynamic table of an EXISTING product.
 *  The table value itself is owned by the caller (the Product Studio draft), so this hook only
 *  owns transport state: load once per product, persist on demand, and never lose the operator's
 *  edits — a failed save keeps the value and surfaces the reason (§14: no silent API failures).
 *  After a successful save the server answer is re-normalised and pushed back, so a deleted
 *  column cannot reappear from a stale client snapshot. */
export function useProductTable(productId: string | null, io: {
  load: () => Promise<unknown>;
  save: (table: DataTable) => Promise<unknown>;
  onLoaded?: (table: DataTable) => void;
  onError?: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const latest = useRef(io);
  latest.current = io;

  const reload = useCallback(async () => {
    if (!productId) return null;
    setLoading(true);
    try {
      const value = await latest.current.load();
      const table = normalizeTable(value);
      latest.current.onLoaded?.(table);
      return table;
    } catch {
      latest.current.onError?.("دریافت اطلاعات این جدول ناموفق بود؛ دوباره تلاش کنید.");
      return null;
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => { void reload(); }, [reload]);

  /** Saves exactly the value the caller holds — no optimistic divergence. */
  const persist = useCallback(async (table: DataTable) => {
    if (!productId) return false;
    setSaving(true); setSaved(false);
    try {
      const clean = normalizeTable(table);
      await latest.current.save(clean);
      const fresh = await latest.current.load();
      latest.current.onLoaded?.(normalizeTable(fresh));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      return true;
    } catch (error) {
      latest.current.onError?.(error instanceof Error ? error.message : "ذخیرهٔ این جدول ناموفق بود؛ دوباره تلاش کنید.");
      return false;
    } finally { setSaving(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  return { loading, saving, saved, persist, reload };
}
