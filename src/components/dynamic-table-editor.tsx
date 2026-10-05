import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Btn, Empty, Input } from "./primitives";
import { cn } from "../utils/cn";

/** §10/§22: the ONE simple table interaction used by «مشخصات فنی» and «راهنمای سایز».
 *
 *  Arbitrary Admin-defined 2D tables — no template, no schema, no binding. The datasets stay
 *  semantically separate (each own table is persisted on its own endpoint); they are only
 *  edited with the same, simple interaction.
 */
export type TableColumn = { id: string; label: string };
export type TableRow = { id: string; values: Record<string, string> };
export type DataTable = { columns: TableColumn[]; rows: TableRow[] };

export const emptyTable = (): DataTable => ({ columns: [], rows: [] });

const uid = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 9)}`;

/** Normalises whatever the server returned so the editor never crashes on legacy shapes. */
export function normalizeTable(value: unknown): DataTable {
  const raw = (value ?? {}) as { columns?: unknown; rows?: unknown };
  const columns = Array.isArray(raw.columns)
    ? raw.columns.map((column): TableColumn => {
      const c = (column ?? {}) as { id?: unknown; label?: unknown };
      return { id: String(c.id ?? uid("c")), label: String(c.label ?? "") };
    }).filter((column) => Boolean(column.id))
    : [];
  const known = new Set(columns.map((column) => column.id));
  const rows = Array.isArray(raw.rows)
    ? raw.rows.map((row): TableRow => {
      const r = (row ?? {}) as { id?: unknown; values?: unknown };
      const values: Record<string, string> = {};
      const source = (r.values ?? {}) as Record<string, unknown>;
      for (const column of columns) {
        const cell = source[column.id];
        values[column.id] = cell === undefined || cell === null ? "" : String(cell);
      }
      // keep any cell whose column vanished — dropping data silently is worse
      for (const [key, cell] of Object.entries(source)) {
        if (!known.has(key) && cell !== undefined && cell !== null) values[key] = String(cell);
      }
      return { id: String(r.id ?? uid("r")), values };
    })
    : [];
  return { columns, rows };
}

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

  const setColumns = (next: TableColumn[]) => onChange({ columns: next, rows });
  const setRows = (next: TableRow[]) => onChange({ columns, rows: next });

  const addColumn = () => setColumns([...columns, { id: uid("c"), label: `ستون ${columns.length + 1}` }]);
  const renameColumn = (id: string, label: string) => setColumns(columns.map((c) => (c.id === id ? { ...c, label } : c)));
  const deleteColumn = (id: string) => {
    setColumns(columns.filter((c) => c.id !== id));
    setRows(rows.map((row) => {
      const values = { ...row.values };
      delete values[id];
      return { ...row, values };
    }));
  };
  const moveColumn = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    [next[index], next[target]] = [next[target], next[index]];
    setColumns(next);
  };

  const addRow = () => setRows([...rows, { id: uid("r"), values: Object.fromEntries(columns.map((c) => [c.id, ""])) }]);
  const deleteRow = (id: string) => setRows(rows.filter((row) => row.id !== id));
  const moveRow = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
  };
  const setCell = (rowId: string, columnId: string, value: string) =>
    setRows(rows.map((row) => (row.id === rowId ? { ...row, values: { ...row.values, [columnId]: value } } : row)));

  return (
    <section className="space-y-2.5" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[13px] font-extrabold">{title}</h4>
          {hint && <p className="mt-0.5 text-[11px] leading-5 text-[var(--kv-muted)]">{hint}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={addColumn}>+ افزودن ستون</Btn>
          <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={addRow} disabled={columns.length === 0}>+ افزودن سطر</Btn>
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
                        onChange={(label) => renameColumn(column.id, label)}
                        ariaLabel={`نام ستون ${index + 1}`}
                        placeholder={`ستون ${index + 1}`}
                      />
                      <div className="flex items-center justify-end gap-1">
                        <IconAction label="انتقال ستون به راست" onClick={() => moveColumn(index, 1)} disabled={index === columns.length - 1}><ArrowLeft size={12} /></IconAction>
                        <IconAction label="انتقال ستون به چپ" onClick={() => moveColumn(index, -1)} disabled={index === 0}><ArrowRight size={12} /></IconAction>
                        <IconAction label={`حذف ستون ${column.label || index + 1}`} danger onClick={() => deleteColumn(column.id)}><Trash2 size={12} /></IconAction>
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
                        onChange={(event) => setCell(row.id, column.id, event.target.value)}
                        aria-label={`${column.label || "سلول"} — سطر ${index + 1}`}
                        className="h-9 w-full rounded-[8px] border border-transparent bg-transparent px-2 text-[12px] hover:border-[var(--kv-line)] focus:border-[var(--kv-accent)] focus:outline-none"
                      />
                    </td>
                  ))}
                  <td>
                    <div className="flex items-center justify-center gap-1">
                      <IconAction label="انتقال سطر به پایین" onClick={() => moveRow(index, 1)} disabled={index === rows.length - 1}><ArrowDown size={12} /></IconAction>
                      <IconAction label="انتقال سطر به بالا" onClick={() => moveRow(index, -1)} disabled={index === 0}><ArrowUp size={12} /></IconAction>
                      <IconAction label={`حذف سطر ${index + 1}`} danger onClick={() => deleteRow(row.id)}><Trash2 size={12} /></IconAction>
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
 *  edits — a failed save keeps the value and surfaces the reason (§14: no silent API failures). */
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
      await latest.current.save(table);
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
