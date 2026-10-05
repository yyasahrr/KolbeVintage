/** §4/§5/§22: the pure, framework-free core of the two dynamic tables
 *  («مشخصات فنی» and «راهنمای سایز»).
 *
 *  These functions are deliberately React-free so the exact operations the UI calls can be
 *  unit-tested without a browser: add / rename / delete / reorder columns, add / delete /
 *  reorder rows, edit a cell — plus the save→reload round trip.
 *
 *  Contract that matters for the browser-UAT defect: ONE call produces the COMPLETE next table.
 *  Deleting a column removes the header AND every cell in that column in the same result, so a
 *  caller can never restore the deleted column from a stale sibling snapshot.
 */
export type TableColumn = { id: string; label: string };
export type TableRow = { id: string; values: Record<string, string> };
export type DataTable = { columns: TableColumn[]; rows: TableRow[] };

export const emptyTable = (): DataTable => ({ columns: [], rows: [] });

let uidCounter = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The canonical cell projection: exactly the current columns, in column order.
 *  A cell whose column no longer exists is dropped here — a deleted column must never come back
 *  from a stale payload, and the persisted representation must not keep its data. */
export function cellsFor(columns: TableColumn[], source: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const column of columns) {
    const cell = source[column.id];
    values[column.id] = cell === undefined || cell === null ? "" : String(cell);
  }
  return values;
}

/** Normalises whatever the server returned so the editor never crashes on legacy shapes. */
export function normalizeTable(value: unknown): DataTable {
  const raw = (value ?? {}) as { columns?: unknown; rows?: unknown };
  const seen = new Set<string>();
  const columns = Array.isArray(raw.columns)
    ? raw.columns.map((column): TableColumn => {
      const c = (column ?? {}) as { id?: unknown; label?: unknown };
      return { id: String(c.id ?? uid("c")), label: String(c.label ?? "") };
    }).filter((column) => {
      if (seen.has(column.id)) return false; // no duplicate React keys
      seen.add(column.id);
      return true;
    })
    : [];
  const rows = Array.isArray(raw.rows)
    ? raw.rows.map((row): TableRow => {
      const r = (row ?? {}) as { id?: unknown; values?: unknown };
      return { id: String(r.id ?? uid("r")), values: cellsFor(columns, (r.values ?? {}) as Record<string, unknown>) };
    })
    : [];
  return { columns, rows };
}

/* ------------------------------------------------------------------ pure table operations */

export function tableAddColumn(table: DataTable, label?: string): DataTable {
  const column: TableColumn = { id: uid("c"), label: label ?? `ستون ${table.columns.length + 1}` };
  return {
    columns: [...table.columns, column],
    rows: table.rows.map((row) => ({ ...row, values: { ...row.values, [column.id]: "" } })),
  };
}

export function tableRenameColumn(table: DataTable, id: string, label: string): DataTable {
  return { columns: table.columns.map((column) => (column.id === id ? { ...column, label } : column)), rows: table.rows };
}

/** Delete = remove the header AND rebuild every row without that cell (one atomic result). */
export function tableDeleteColumn(table: DataTable, id: string): DataTable {
  const columns = table.columns.filter((column) => column.id !== id);
  return { columns, rows: table.rows.map((row) => ({ ...row, values: cellsFor(columns, row.values) })) };
}

export function tableMoveColumn(table: DataTable, index: number, delta: number): DataTable {
  const target = index + delta;
  if (index < 0 || index >= table.columns.length || target < 0 || target >= table.columns.length) return table;
  const columns = [...table.columns];
  [columns[index], columns[target]] = [columns[target]!, columns[index]!];
  return { columns, rows: table.rows };
}

export function tableAddRow(table: DataTable): DataTable {
  const row: TableRow = { id: uid("r"), values: Object.fromEntries(table.columns.map((column) => [column.id, ""])) };
  return { columns: table.columns, rows: [...table.rows, row] };
}

export function tableDeleteRow(table: DataTable, id: string): DataTable {
  return { columns: table.columns, rows: table.rows.filter((row) => row.id !== id) };
}

export function tableMoveRow(table: DataTable, index: number, delta: number): DataTable {
  const target = index + delta;
  if (index < 0 || index >= table.rows.length || target < 0 || target >= table.rows.length) return table;
  const rows = [...table.rows];
  [rows[index], rows[target]] = [rows[target]!, rows[index]!];
  return { columns: table.columns, rows };
}

export function tableSetCell(table: DataTable, rowId: string, columnId: string, value: string): DataTable {
  return {
    columns: table.columns,
    rows: table.rows.map((row) => (row.id === rowId ? { ...row, values: { ...row.values, [columnId]: value } } : row)),
  };
}

/** The persisted shape after a save→reload cycle (what the server echoes back). */
export const roundTrip = (table: DataTable): DataTable => normalizeTable(JSON.parse(JSON.stringify(table)) as unknown);
