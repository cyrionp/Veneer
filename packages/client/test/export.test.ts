import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListExporter } from '../src/export/exporter.ts';
import { exportColumns, numberOf, toCsv, toXlsx } from '../src/export/sheet.ts';
import { crc32 } from '../src/export/zip.ts';
import type { ScreenView, TableItem } from '../src/transform/types.ts';
import type { FieldSnapshot } from '@veneer/terminal';

const option = { id: '11:3', bypass: false, value: '' } as FieldSnapshot;

/** A page of the jobs list: an option field column, then job and CPU. */
function page(jobs: Array<[string, string]>, more: boolean): TableItem {
  return {
    kind: 'table', row: 10, col: 2, width: 79, height: jobs.length + 1, headerRows: 1, more,
    columns: [{ col: 2, width: 4, header: 'Opt' }, { col: 6, width: 16, header: 'Job' }, { col: 22, width: 8, header: 'CPU %' }],
    rows: jobs.map(([job, cpu], i) => ({
      row: 11 + i,
      cells: [
        { col: 2, width: 4, text: '', role: 'normal', field: option },
        { col: 6, width: 16, text: job, role: 'normal' },
        { col: 22, width: 8, text: cpu, role: 'normal' },
      ],
    })),
  };
}
const view = (table: TableItem) => ({ items: [table] }) as unknown as ScreenView;

test('pages up to the top, down to the bottom collecting rows, then back to the user\'s page', () => {
  const [a, b, c] = [page([['QBATCH', '.1'], ['QINTER', '2.5']], true), page([['QSPL', '0']], true), page([['QHTTP', '1,234.5-']], false)];
  const ex = new ListExporter(b!, 'id1'); // the user is on page 2
  assert.deepEqual(ex.start(), { send: 'PageUp' });
  assert.deepEqual(ex.onScreen(view(a!), 'id1'), { send: 'PageUp' }, 'moved: keep going up');
  assert.deepEqual(ex.onScreen(view(a!), 'id1'), { send: 'PageDown' }, 'stayed: the top; collect and go down');
  assert.equal(ex.progress.phase, 'paging');
  assert.deepEqual(ex.onScreen(view(b!), 'id1'), { send: 'PageDown' });
  assert.deepEqual(ex.onScreen(view(c!), 'id1'), { send: 'PageUp' }, 'Bottom: head back');
  assert.equal(ex.progress.phase, 'returning');
  const done = ex.onScreen(view(b!), 'id1');
  assert.ok('done' in done && done.sheet, 'back on page 2');
  assert.deepEqual(done.sheet.header, ['Job', 'CPU %'], 'the option column is left out');
  assert.deepEqual(done.sheet.rows, [['QBATCH', '.1'], ['QINTER', '2.5'], ['QSPL', '0'], ['QHTTP', '1,234.5-']]);
});

test('a host error on a page key counts as the top or bottom', () => {
  const only = page([['A', '1']], false);
  const ex = new ListExporter(only, 'x');
  assert.deepEqual(ex.start(), { send: 'PageUp' });
  assert.deepEqual(ex.onScreen(view(only), 'x', true), { done: true, sheet: { header: ['Job', 'CPU %'], rows: [['A', '1']] } });
});

test('a changed screen and cancel stop it, after heading back', () => {
  const first = page([['A', '1']], true);
  const second = page([['B', '2']], true);
  const moved = new ListExporter(first, 'x');
  moved.start();
  moved.onScreen(view(first), 'x'); // top
  assert.deepEqual(moved.onScreen(view(second), 'other-screen'), { send: 'PageUp' });
  const failed = moved.onScreen(view(first), 'x');
  assert.ok('done' in failed && failed.error && !failed.sheet);

  const cancelled = new ListExporter(first, 'x');
  cancelled.start();
  cancelled.onScreen(view(first), 'x');
  cancelled.cancel();
  assert.deepEqual(cancelled.onScreen(view(second), 'x'), { send: 'PageUp' });
  assert.deepEqual(cancelled.onScreen(view(first), 'x'), { done: true });
});

test('stops at the page limit, and returning stops if the page will not move', () => {
  const first = page([['A', '1']], true);
  const ex = new ListExporter(first, 'x', 2);
  ex.start();
  assert.deepEqual(ex.onScreen(view(first), 'x'), { send: 'PageDown' });
  assert.deepEqual(ex.onScreen(view(page([['B', '2']], true)), 'x'), { send: 'PageUp' }, 'two pages: stop');
  const stuck = ex.onScreen(view(page([['B', '2']], true)), 'x');
  assert.ok('done' in stuck && stuck.sheet?.rows.length === 2);
});

test('numbers become numbers; codes with leading zeros stay text', () => {
  assert.equal(numberOf('1,234.50'), 1234.5);
  assert.equal(numberOf('12.5-'), -12.5);
  assert.equal(numberOf('.4'), 0.4);
  assert.equal(numberOf('-7'), -7);
  assert.equal(numberOf('0'), 0);
  assert.equal(numberOf('00123'), null);
  assert.equal(numberOf('QPADEV0001'), null);
  assert.equal(numberOf('1234567890123456'), null, 'too long to be exact');
  assert.equal(numberOf(''), null);
});

test('CSV quotes what needs it and starts with a BOM for Excel', () => {
  const csv = toCsv({ header: ['Name', 'Note'], rows: [['A, B', 'say "hi"'], ['00123', ' x']] });
  assert.equal(csv, '﻿Name,Note\r\n"A, B","say ""hi"""\r\n00123," x"\r\n');
});

test('the workbook is a valid zip with number and text cells', () => {
  const bytes = toXlsx({ header: ['Code', 'Amount'], rows: [['00123', '1,234.50'], ['A&B', '']] }, 'Jobs');
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">00123<\/t>/);
  assert.match(text, /<c r="B2"><v>1234.5<\/v><\/c>/);
  assert.match(text, /A&amp;B/);
  assert.match(text, /<sheet name="Jobs"/);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.deepEqual(exportColumns(page([], false)), [0, 1, 2], 'an empty page keeps every column');
});
