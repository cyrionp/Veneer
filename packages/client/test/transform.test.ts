import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attr } from '@veneer/tn5250';
import { findWindows, transform, type FieldItem, type LinkItem, type TableItem, type TextItem } from '../src/transform/index.ts';
import { stripLeaders } from '../src/transform/text.ts';
import { drawnLines, mainMenu, promptWindow, signOn, titled, workWithJobs, type WindowOptions } from './screens.ts';

const texts = (items: unknown[]) => (items as TextItem[]).filter((i) => i.kind === 'text').map((i) => i.text);

test('strips dot leaders but keeps ellipses', () => {
  assert.equal(stripLeaders('User  . . . . . . . . . . . . . .'), 'User');
  assert.equal(stripLeaders('System . . . . . :'), 'System');
  assert.equal(stripLeaders('More...'), 'More...');
  assert.equal(stripLeaders('. . . :'), '');
});

test('sign-on: title, labelled fields, info message', () => {
  const v = transform(signOn());
  assert.equal(v.title, 'Sign On');
  const fields = v.items.filter((i): i is FieldItem => i.kind === 'field');
  assert.deepEqual(fields.map((f) => [f.field.id, f.label, f.field.attr.nonDisplay]), [
    ['6:53', 'User', false], ['7:53', 'Password', true],
  ]);
  assert.ok(texts(v.items).includes('User'));
  assert.ok(texts(v.items).includes('System'));
  assert.deepEqual(v.message, { text: '(C) COPYRIGHT IBM CORP. 1980, 2024.', kind: 'info' });
  assert.deepEqual(v.functionKeys, []);
});

test('main menu: links fill the command line, F-keys become buttons', () => {
  const v = transform(mainMenu());
  assert.equal(v.title, 'IBM i Main Menu');
  assert.deepEqual(v.meta.map((m) => [m.text, m.row, m.col]), [['MAIN', 1, 2], ['System: PUB400', 1, 64]], 'header items keep their position');
  const links = v.items.filter((i): i is LinkItem => i.kind === 'link');
  assert.deepEqual(links.map((l) => [l.key, l.text]), [['1', 'User tasks'], ['2', 'Office tasks'], ['90', 'Sign off']]);
  assert.deepEqual(links[2]!.action, { aid: 'Enter', fields: { '20:7': '90' } });
  const cmd = v.items.find((i): i is FieldItem => i.kind === 'field')!;
  assert.equal(cmd.command, true);
  assert.deepEqual(v.functionKeys.map((k) => `${k.aid}=${k.label}`), [
    'F3=Exit', 'F4=Prompt', 'F9=Retrieve', 'F12=Cancel', 'F13=Information Assistant', 'F23=Set initial menu',
  ]);
  assert.ok(!texts(v.items).some((t) => t.includes('F3=')), 'legend text removed');
  assert.ok(!texts(v.items).includes('===>'));
});

test('work with active jobs: subfile becomes a table with option dropdowns', () => {
  const v = transform(workWithJobs());
  const table = v.items.find((i): i is TableItem => i.kind === 'table')!;
  assert.ok(table, 'table detected');
  assert.equal(table.row, 10);
  assert.equal(table.more, true);
  assert.deepEqual(table.columns.map((c) => c.header), ['Opt', 'Subsystem/Job', 'User', 'Type', 'CPU %', 'Function', 'Status']);
  assert.equal(table.rows.length, 3);
  const qinter = table.rows[1]!.cells.map((c) => c.text);
  assert.deepEqual(qinter, ['', 'QINTER', 'QSYS', 'SBS', '12.5', '', 'DEQW']);
  assert.deepEqual(table.rows[2]!.cells.map((c) => c.text), ['', 'QPADEV0001', 'DLONG', 'INT', '.1', 'CMD-WRKACTJOB', 'RUN']);
  const opt = table.rows[0]!.cells[0]!;
  assert.equal(opt.field?.id, '11:3');
  assert.deepEqual(opt.options?.map((o) => o.value), ['2', '3', '4', '5', '6']);
  const more = v.items.find((i): i is LinkItem => i.kind === 'link' && i.text === 'More')!;
  assert.deepEqual(more.action, { aid: 'PageDown' });
  assert.ok(v.functionKeys.some((k) => k.aid === 'F24' && k.label === 'More keys'));
  assert.ok(v.items.some((i) => i.kind === 'field' && i.command), 'command line kept');
});

test('a "Bottom" marker means no more records', () => {
  const v = transform(workWithJobs('Bottom'));
  const table = v.items.find((i): i is TableItem => i.kind === 'table')!;
  assert.equal(table.more, false);
  assert.ok(texts(v.items).includes('Bottom'));
});

test('error messages from the host become an error banner', () => {
  const v = transform(titled('Sign On', 'CPF1107 - Password not correct for user profile.'));
  assert.deepEqual(v.message, { text: 'CPF1107 - Password not correct for user profile.', kind: 'error' });
});

test('a host with no message line shows errors, but leaves the last row as text', () => {
  const { messageRow: _row, ...noLine } = signOn();
  const v = transform(noLine);
  assert.equal(v.message, undefined);
  assert.ok(texts(v.items).some((t) => t.includes('COPYRIGHT')));
  const { messageRow: _row2, ...withError } = titled('Sign On', 'CPF1107 - Password not correct for user profile.');
  assert.deepEqual(transform(withError).message, { text: 'CPF1107 - Password not correct for user profile.', kind: 'error' });
});

test('every input field is rendered exactly once', () => {
  for (const snap of [signOn(), mainMenu(), workWithJobs()]) {
    const v = transform(snap);
    const rendered = v.items.flatMap((i) =>
      i.kind === 'field' ? [i.field.id] : i.kind === 'table' ? i.rows.flatMap((r) => r.cells.flatMap((c) => (c.field ? [c.field.id] : []))) : []);
    const expected = snap.fields.filter((f) => !f.bypass).map((f) => f.id);
    assert.deepEqual([...rendered].sort(), [...expected].sort());
  }
});

test('a bordered pop-up window becomes a modal view over the dimmed screen', () => {
  const v = transform(promptWindow());
  assert.ok(v.window, 'window detected');
  const w = v.window!;
  assert.deepEqual([w.top, w.left, w.bottom, w.right], [8, 21, 15, 58]);
  assert.equal(w.title, 'Select Printer');
  assert.deepEqual(w.functionKeys.map((k) => k.aid), ['F4', 'F12']);
  const fields = w.items.filter((i): i is FieldItem => i.kind === 'field');
  assert.deepEqual(fields.map((f) => [f.field.id, f.label]), [['12:41', 'Printer'], ['13:41', 'Copies']]);
  assert.ok(texts(w.items).includes('Type choices, press Enter.'));
  assert.ok(!texts(w.items).some((t) => /[:.]{3,}/.test(t)), 'no border characters');

  // The background keeps its text but nothing interactive, and no border characters.
  assert.equal(v.title, 'IBM i Main Menu');
  assert.ok(texts(v.items).includes('Select one of the following:'));
  assert.ok(!v.items.some((i) => i.kind === 'field' || i.kind === 'link'));
  assert.ok(!texts(v.items).some((t) => t === ':' || /^\.+$/.test(t)));
  assert.ok(!texts(v.items).some((t) => t.includes('F3=')), 'background F-key legend is not drawn');
});

test('a title in the window border is used, and the first row stays content', () => {
  const v = transform(promptWindow({ borderTitle: 'Select Printer' }));
  assert.equal(v.window?.title, 'Select Printer');
});

test('screens without borders have no window', () => {
  assert.equal(transform(mainMenu()).window, undefined);
  assert.equal(transform(workWithJobs()).window, undefined);
});

// DDS WDWBORDER: other border characters and colors (issue #6).
const customBorders: Array<[string, WindowOptions]> = [
  ['+-+ corners, | sides', { border: '+-+||+-+' }],
  ['all asterisks', { border: '********', borderAttr: Attr.PINK }],
  ['different top and bottom', { border: '=====#-#', borderAttr: Attr.WHITE }],
  ['blanks in reverse image', { border: '        ', borderAttr: Attr.GREEN_REVERSE }],
];
for (const [name, opts] of customBorders) {
  test(`a window with a custom border is found: ${name}`, () => {
    const v = transform(promptWindow(opts));
    const w = v.window;
    assert.ok(w, 'window detected');
    assert.deepEqual([w.top, w.left, w.bottom, w.right], [8, 21, 15, 58]);
    assert.equal(w.title, 'Select Printer');
    assert.deepEqual(w.items.filter((i): i is FieldItem => i.kind === 'field').map((f) => f.field.id), ['12:41', '13:41']);
    const border = new Set([...(opts.border ?? '')].filter((c) => c !== ' '));
    const leftover = [...texts(w.items), ...texts(v.items)].filter((t) => [...t].every((c) => border.has(c)));
    assert.deepEqual(leftover, [], 'no border characters drawn');
  });

  test(`a custom border keeps its title: ${name}`, () => {
    assert.equal(transform(promptWindow({ ...opts, borderTitle: 'Select Printer' })).window?.title, 'Select Printer');
  });
}

test('separator lines, text tables and reverse-image bars are not windows', () => {
  assert.deepEqual(findWindows(drawnLines()), []);
  assert.equal(transform(drawnLines()).window, undefined);
});
