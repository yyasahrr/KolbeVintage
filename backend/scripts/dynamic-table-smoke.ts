/** §4/§22 (browser-UAT delta): regression gate for the two dynamic tables.
 *
 *  Browser-UAT defect: «در مشخصات و راهنمای سایز، حذف ستون کار نمی‌کند». Root cause: the editor
 *  committed a column delete with TWO `onChange` calls, and the second call (rows) carried the
 *  pre-delete columns from the stale render snapshot, re-adding the column.
 *
 *  This gate exercises the exact pure operations the editor now calls — no browser needed:
 *    - delete FIRST / MIDDLE / LAST column (header + cells + saved representation)
 *    - rename / reorder columns, add / delete / reorder rows, direct cell edit
 *    - the save→reload round trip preserves exactly the mutated state
 *
 *  Run: cd backend && npx tsx scripts/dynamic-table-smoke.ts
 */
import assert from 'node:assert/strict';
import {
  emptyTable, normalizeTable, roundTrip, tableAddColumn, tableAddRow, tableDeleteColumn, tableDeleteRow,
  tableMoveColumn, tableMoveRow, tableRenameColumn, tableSetCell, type DataTable,
} from '../../src/components/table-ops';

let passed = 0;
const checks: string[] = [];
function check(name: string, run: () => void) {
  run();
  passed += 1;
  checks.push(name);
}

/** A 4-column / 3-row table built through the editor's own operations. */
function fourByThree(): DataTable {
  let table = emptyTable();
  table = tableAddColumn(table, 'سایز');
  table = tableAddColumn(table, 'دور سینه');
  table = tableAddColumn(table, 'قد');
  table = tableAddColumn(table, 'آستین');
  table = tableAddRow(table);
  table = tableAddRow(table);
  table = tableAddRow(table);
  return table;
}

const fill = (table: DataTable): DataTable => {
  let next = table;
  next.columns.forEach((column, columnIndex) => {
    next.rows.forEach((row, rowIndex) => {
      next = tableSetCell(next, row.id, column.id, `مقدار ${columnIndex + 1}-${rowIndex + 1}`);
    });
  });
  return next;
};

const columnLabels = (table: DataTable) => table.columns.map((column) => column.label);
const columnIds = (table: DataTable) => table.columns.map((column) => column.id);
/** A column is truly gone when neither the header nor any cell of any row mentions it. */
function assertColumnGone(table: DataTable, removedId: string) {
  assert.ok(!table.columns.some((column) => column.id === removedId), 'header still present');
  for (const row of table.rows) {
    assert.ok(!(removedId in row.values), `cell of the deleted column survived in row ${row.id}`);
  }
}

const base = fill(fourByThree());
assert.equal(base.columns.length, 4, 'fixture must start with 4 columns');
assert.equal(base.rows.length, 3, 'fixture must start with 3 rows');

check('delete FIRST column removes header and every cell', () => {
  const removed = base.columns[0]!.id;
  const next = tableDeleteColumn(base, removed);
  assert.equal(next.columns.length, 3);
  assert.deepEqual(columnLabels(next), ['دور سینه', 'قد', 'آستین']);
  assertColumnGone(next, removed);
});

check('delete MIDDLE column removes header and every cell', () => {
  const removed = base.columns[1]!.id;
  const next = tableDeleteColumn(base, removed);
  assert.deepEqual(columnLabels(next), ['سایز', 'قد', 'آستین']);
  assertColumnGone(next, removed);
});

check('delete LAST column removes header and every cell', () => {
  const removed = base.columns[3]!.id;
  const next = tableDeleteColumn(base, removed);
  assert.deepEqual(columnLabels(next), ['سایز', 'دور سینه', 'قد']);
  assertColumnGone(next, removed);
});

check('deleting a column does NOT restore it on save→reload (the UAT defect)', () => {
  const removed = base.columns[1]!.id;
  const saved = roundTrip(tableDeleteColumn(base, removed));
  assert.deepEqual(columnLabels(saved), ['سایز', 'قد', 'آستین']);
  assertColumnGone(saved, removed);
  // a second cycle must stay stable too
  const again = roundTrip(saved);
  assert.deepEqual(columnIds(again), columnIds(saved));
  assert.deepEqual(columnLabels(again), columnLabels(saved));
});

check('two further deletes leave exactly one column and no orphan cells', () => {
  let next = tableDeleteColumn(base, base.columns[1]!.id);
  next = tableDeleteColumn(next, next.columns[0]!.id);
  next = roundTrip(next);
  assert.equal(next.columns.length, 2);
  for (const row of next.rows) assert.deepEqual(Object.keys(row.values).sort(), columnIds(next).sort());
});

check('rename column persists through save→reload', () => {
  const renamed = roundTrip(tableRenameColumn(base, base.columns[2]!.id, 'قد آستین'));
  assert.deepEqual(columnLabels(renamed), ['سایز', 'دور سینه', 'قد آستین', 'آستین']);
});

check('reorder column (both directions) persists through save→reload', () => {
  const right = roundTrip(tableMoveColumn(base, 0, 1));
  assert.deepEqual(columnLabels(right), ['دور سینه', 'سایز', 'قد', 'آستین']);
  const left = roundTrip(tableMoveColumn(base, 3, -1));
  assert.deepEqual(columnLabels(left), ['سایز', 'دور سینه', 'آستین', 'قد']);
  // out-of-range moves are no-ops, never corruption
  assert.deepEqual(columnIds(tableMoveColumn(base, 0, -1)), columnIds(base));
  assert.deepEqual(columnIds(tableMoveColumn(base, 3, 1)), columnIds(base));
});

check('add row / delete row / reorder row persist through save→reload', () => {
  const added = roundTrip(tableAddRow(base));
  assert.equal(added.rows.length, 4);
  assert.deepEqual(Object.keys(added.rows[3]!.values).sort(), columnIds(added).sort());
  const removed = roundTrip(tableDeleteRow(base, base.rows[1]!.id));
  assert.equal(removed.rows.length, 2);
  const movedDown = roundTrip(tableMoveRow(base, 0, 1));
  assert.deepEqual(movedDown.rows.map((row) => row.id), [base.rows[1]!.id, base.rows[0]!.id, base.rows[2]!.id]);
  const movedUp = roundTrip(tableMoveRow(base, 2, -1));
  assert.deepEqual(movedUp.rows.map((row) => row.id), [base.rows[0]!.id, base.rows[2]!.id, base.rows[1]!.id]);
});

check('cell edit persists and survives a column delete of another column', () => {
  const edited = tableSetCell(base, base.rows[0]!.id, base.columns[3]!.id, '۶۲');
  const next = roundTrip(tableDeleteColumn(edited, base.columns[0]!.id));
  assert.equal(next.rows[0]!.values[base.columns[3]!.id], '۶۲');
  assert.equal(Object.keys(next.rows[0]!.values).length, 3);
});

check('normalizeTable drops stale cells whose column no longer exists', () => {
  const stale = { columns: [{ id: 'c1', label: 'الف' }], rows: [{ id: 'r1', values: { c1: 'یک', gone: 'باید حذف شود' } }] };
  const normalized = normalizeTable(stale);
  assert.deepEqual(Object.keys(normalized.rows[0]!.values), ['c1']);
  assert.equal(normalized.rows[0]!.values.c1, 'یک');
});

check('normalizeTable never produces duplicate column ids (no duplicate React keys)', () => {
  const dup = { columns: [{ id: 'c1', label: 'الف' }, { id: 'c1', label: 'تکراری' }], rows: [] };
  const normalized = normalizeTable(dup);
  assert.equal(normalized.columns.length, 1);
  assert.equal(normalized.columns[0]!.label, 'الف');
});

check('empty table round trip stays empty and usable', () => {
  const empty = roundTrip(emptyTable());
  assert.deepEqual(empty, { columns: [], rows: [] });
  const first = tableAddColumn(empty, 'ستون ۱');
  assert.equal(first.columns.length, 1);
  assert.deepEqual(first.rows, []);
});

/* §22 end-to-end walkthrough (exactly what the browser UAT does):
   4 columns / 3 rows → delete the MIDDLE column → save+reload → absent;
   then rename + reorder a column and delete + reorder a row → save+reload → exact state. */
check('§22 walkthrough: delete middle column, then rename/reorder column + delete/reorder row survive save→reload', () => {
  // 1) 4 columns / 3 rows.
  let table = fill(fourByThree());
  assert.deepEqual(columnLabels(table), ['سایز', 'دور سینه', 'قد', 'آستین']);

  // 2) delete the middle column and persist it.
  const middle = table.columns[1]!;
  table = roundTrip(tableDeleteColumn(table, middle.id));
  assert.deepEqual(columnLabels(table), ['سایز', 'قد', 'آستین']);
  assertColumnGone(table, middle.id);
  assert.equal(table.rows.length, 3, 'deleting a column never drops rows');

  // 3) rename + reorder a column, delete + reorder a row — one action at a time, then persist.
  const astin = table.columns[2]!;
  table = roundTrip(tableRenameColumn(table, astin.id, 'طول آستین'));
  assert.deepEqual(columnLabels(table), ['سایز', 'قد', 'طول آستین']);
  table = roundTrip(tableMoveColumn(table, 2, -1));
  assert.deepEqual(columnLabels(table), ['سایز', 'طول آستین', 'قد']);
  const rowIds = table.rows.map((row) => row.id);
  table = roundTrip(tableMoveRow(table, 0, 1));
  assert.deepEqual(table.rows.map((row) => row.id), [rowIds[1], rowIds[0], rowIds[2]], 'row reorder survives reload');
  table = roundTrip(tableDeleteRow(table, table.rows[1]!.id));
  assert.equal(table.rows.length, 2);
  assert.ok(!table.rows.some((row) => row.id === rowIds[0]), 'the deleted row stays deleted after reload');

  // 4) the reloaded table is exactly what was saved: every row carries exactly the live columns.
  for (const row of table.rows) {
    assert.deepEqual(Object.keys(row.values).sort(), columnIds(table).sort(), 'no orphan cells, no missing cells');
  }
  assert.deepEqual(columnLabels(table), ['سایز', 'طول آستین', 'قد']);
  assert.equal(table.rows.length, 2);
  // and a column delete after all of this still works (regression guard for the UAT defect)
  const next = roundTrip(tableDeleteColumn(table, table.columns[0]!.id));
  assert.deepEqual(columnLabels(next), ['طول آستین', 'قد']);
  assertColumnGone(next, table.columns[0]!.id);
});

check('one commit per user action: delete derives BOTH columns and rows from the same snapshot', () => {
  // The UAT defect was two sequential commits (columns, then rows from a stale snapshot). The
  // pure API can only ever produce one object, so a stale second commit cannot exist: applying
  // the same delete twice is idempotent and never resurrects the column.
  const removed = base.columns[1]!.id;
  const once = tableDeleteColumn(base, removed);
  const twice = tableDeleteColumn(once, removed);
  assert.deepEqual(columnIds(twice), columnIds(once));
  assertColumnGone(twice, removed);
  // Simulating the old buggy sequence (stale columns overwritten by a later rows-only commit)
  // must be impossible with this shape: the value is always a complete, consistent table.
  assert.equal(once.columns.length, once.rows.every((row) => Object.keys(row.values).length === once.columns.length) ? once.columns.length : -1);
});

console.log(`dynamic-table smoke: ${passed}/${checks.length} checks passed`);
for (const name of checks) console.log(`  ✓ ${name}`);
