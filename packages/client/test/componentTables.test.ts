// What components see of the lists on a screen (ctx.tables): the cells, each
// row's place and option field, the legend's options, style rules, and lists
// a customization hid so a component (cards) can take their place.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScreenDefinition } from '@veneer/screens';
import { Attr, HostStream, Terminal, buildRecord, getCodepage, snapshot } from '@veneer/tn5250';
import { tablesOf } from '../src/custom/components.ts';
import { customize } from '../src/transform/customize.ts';
import { transform } from '../src/transform/index.ts';
import { workWithJobs } from './screens.ts';

const definition = (changes: ScreenDefinition['changes']): ScreenDefinition => ({
  id: 'jobs', name: 'Jobs', match: { text: [{ row: 1, col: 30, text: 'Work with Active Jobs' }] }, changes,
});

test('a list with an option column: cells, rows, option fields and the legend', () => {
  const [t] = tablesOf(transform(workWithJobs()));
  assert.ok(t);
  assert.deepEqual(t.columns, ['Opt', 'Subsystem/Job', 'User', 'Type', 'CPU %', 'Function', 'Status']);
  assert.deepEqual(t.rows[2], ['', 'QPADEV0001', 'DLONG', 'INT', '.1', 'CMD-WRKACTJOB', 'RUN']);
  assert.deepEqual(t.records.map((r) => r.row), [11, 12, 13]);
  assert.deepEqual(t.records.map((r) => r.option), ['11:3', '12:3', '13:3']);
  assert.deepEqual(t.records[0]!.fields, ['11:3', null, null, null, null, null, null]);
  assert.deepEqual(t.records.map((r) => r.cells), t.rows, 'records hold the same cells as rows');
  assert.deepEqual(t.options, [
    { value: '2', label: 'Change' }, { value: '3', label: 'Hold' }, { value: '4', label: 'End' },
    { value: '5', label: 'Work with' }, { value: '6', label: 'Release' },
  ]);
  assert.equal(t.more, true);
  assert.equal(t.hidden, false);
  assert.ok(t.records.every((r) => r.role === null));
});

test('"Bottom" means no more rows', () => {
  assert.equal(tablesOf(transform(workWithJobs('Bottom')))[0]!.more, false);
});

test('a hidden list is still there for components, marked hidden', () => {
  const v = customize(transform(workWithJobs()), definition([{ op: 'hide', at: { row: 10, col: 2 } }]));
  assert.equal(v.items.some((i) => i.kind === 'table'), false, 'not drawn');
  const tables = tablesOf(v);
  assert.equal(tables.length, 1);
  assert.equal(tables[0]!.hidden, true);
  assert.deepEqual(tables[0]!.records.map((r) => r.option), ['11:3', '12:3', '13:3']);
});

test('in the designer a hidden list is marked hidden too', () => {
  const v = customize(transform(workWithJobs()), definition([{ op: 'hide', at: { row: 12, col: 30 } }]), { design: true });
  assert.equal(tablesOf(v)[0]!.hidden, true);
});

test('hiding something else leaves the list as it was', () => {
  const v = customize(transform(workWithJobs()), definition([{ op: 'hide', at: { row: 7, col: 2 } }]));
  const tables = tablesOf(v);
  assert.equal(tables.length, 1);
  assert.equal(tables[0]!.hidden, false);
  assert.equal(v.hiddenTables, undefined);
});

test('a row style rule sets the row\'s role; a cell rule sets the cell\'s', () => {
  const rows = tablesOf(customize(transform(workWithJobs()), definition([
    { op: 'style', when: { column: 'Status', equals: 'run' }, role: 'danger', target: 'row' },
    { op: 'style', when: { column: 'CPU %', greaterThan: 10 }, role: 'warning', target: 'cell' },
    { op: 'hide', at: { row: 10, col: 2 } },
  ])))[0]!.records;
  assert.deepEqual(rows.map((r) => r.role), [null, null, 'danger']);
  assert.equal(rows[1]!.roles[4], 'warning', 'QINTER at 12.5%');
  assert.notEqual(rows[0]!.roles[4], 'warning');
});

test('a moved list keeps the host\'s field ids, so options still reach the right row', () => {
  const v = customize(transform(workWithJobs()), definition([{ op: 'move', at: { row: 10, col: 2 }, to: { row: 12, col: 2 } }]));
  const t = tablesOf(v)[0]!;
  assert.deepEqual(t.records.map((r) => r.row), [13, 14, 15], 'where it is drawn');
  assert.deepEqual(t.records.map((r) => r.option), ['11:3', '12:3', '13:3']);
});

test('a list without an option legend has no options or option fields', () => {
  const cp = getCodepage(37);
  const term = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
  term.processRecord(buildRecord(0x03, new HostStream().clear().write()
    .text(1, 30, 'Display Items', Attr.WHITE)
    .text(5, 2, 'Item      Description          Qty', Attr.WHITE)
    .text(6, 2, 'A100      Widget               12')
    .text(7, 2, 'B200      Gadget                3')
    .text(9, 73, 'Bottom')
    .readMdt().build()));
  const [t] = tablesOf(transform(snapshot(term.screen, cp)));
  assert.ok(t);
  assert.deepEqual(t.rows, [['A100', 'Widget', '12'], ['B200', 'Gadget', '3']]);
  assert.deepEqual(t.options, []);
  assert.ok(t.records.every((r) => r.option === null && r.fields.every((f) => f === null)));
});

test('lists come in screen order', () => {
  const v = transform(workWithJobs());
  const table = v.items.find((i) => i.kind === 'table')!;
  // A second list, as if hidden, above the first.
  const above = { ...table, row: 2, hidden: true as const };
  const tables = tablesOf({ ...v, hiddenTables: [above] });
  assert.deepEqual(tables.map((t) => [t.row, t.hidden]), [[2, true], [10, false]]);
});
