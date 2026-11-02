import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attr, HostStream, Terminal, buildRecord, getCodepage, snapshot } from '@veneer/tn5250';
import { hostToIso, isoToHost, matchScreen, matches, validateDefinition, validateSite, validateStyle, type ScreenDefinition } from '../src/index.ts';

const cp = getCodepage(37);
function screen(build: (s: HostStream) => HostStream) {
  const t = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
  t.processRecord(buildRecord(0x03, build(new HostStream().clear().write()).readMdt().build()));
  return snapshot(t.screen, cp);
}
const orders = screen((s) => s.text(1, 2, 'ORD100').text(1, 34, 'Order Entry', Attr.WHITE).field(6, 22, 6));
const def = (id: string, text: ScreenDefinition['match']['text']): ScreenDefinition =>
  ({ id, name: id, match: { text }, changes: [] });

test('matches text at exact positions and prefers the most specific definition', () => {
  const byTitle = def('by-title', [{ row: 1, col: 34, text: 'Order Entry' }]);
  const byBoth = def('by-both', [{ row: 1, col: 34, text: 'Order Entry' }, { row: 1, col: 2, text: 'ORD100' }]);
  const wrongCol = def('wrong', [{ row: 1, col: 35, text: 'Order Entry' }]);
  assert.equal(matchScreen(orders, [byTitle, wrongCol])?.id, 'by-title');
  assert.equal(matchScreen(orders, [byTitle, byBoth])?.id, 'by-both');
  assert.equal(matchScreen(orders, [wrongCol]), undefined);
  assert.equal(matchScreen(orders, [{ ...byTitle, match: { ...byTitle.match, cols: 132 } }]), undefined);
});

test('a definition for one host type never matches a screen from the other', () => {
  const text = [{ row: 1, col: 2, text: 'ORD100' }];
  const either = def('either', text);
  const ibmi: ScreenDefinition = { ...def('ibmi', text), host: '5250' };
  const mainframe: ScreenDefinition = { ...def('mainframe', text), host: '3270' };
  assert.deepEqual([either, ibmi, mainframe].map((d) => matches(orders, d)), [true, true, false]);
  const from3270 = { ...orders, host: '3270' as const };
  assert.deepEqual([either, ibmi, mainframe].map((d) => matches(from3270, d)), [true, false, true]);
  assert.equal(matchScreen(from3270, [ibmi, mainframe])?.id, 'mainframe');
});

test('a definition can say its host type, and then only uses keys that host has', () => {
  const base = { id: 'x', name: 'X', match: { text: [{ row: 1, col: 1, text: 'X' }] }, changes: [] };
  const button = (aid: string) => [{ op: 'button', label: 'Go', action: { aid } }];
  const clean = validateDefinition({ ...base, host: '3270', changes: button('PA1') });
  assert.deepEqual(Object.keys(clean), ['id', 'name', 'host', 'match', 'changes']);
  assert.equal(clean.host, '3270');
  assert.throws(() => validateDefinition({ ...base, host: '3270', changes: button('PageDown') }), /changes\[0\]\.action\.aid: PageDown is not a 3270 key/);
  assert.throws(() => validateDefinition({ ...base, host: '5250', changes: button('PA2') }), /PA2 is not a 5250 key/);
  assert.equal(validateDefinition({ ...base, changes: button('PA1') }).host, undefined, 'no host: any key');
  assert.throws(() => validateDefinition({ ...base, host: 'zos' }), /host: must be "5250" or "3270"/);
  // 3270 models 3 and 4 are taller than any 5250 screen.
  assert.equal(validateDefinition({ ...base, match: { ...base.match, rows: 43 } }).match.rows, 43);
  assert.equal(validateDefinition({ ...base, changes: [{ op: 'hide', at: { row: 43, col: 1 } }] }).changes.length, 1);
  assert.throws(() => validateDefinition({ ...base, changes: [{ op: 'hide', at: { row: 44, col: 1 } }] }), /row/);
});

test('validates and cleans definitions', () => {
  const clean = validateDefinition({
    id: 'order-entry', name: 'Order Entry', extra: 'dropped',
    match: { text: [{ row: 1, col: 34, text: 'Order Entry' }] },
    title: 'New order',
    changes: [
      { op: 'hide', at: { row: 3, col: 2 } },
      { op: 'widget', field: '7:22', widget: { type: 'select', options: [{ value: 'TX', label: 'Texas' }] } },
      { op: 'button', label: 'Exit', action: { aid: 'F3' } },
      { op: 'html', at: { row: 5, col: 50 }, html: '<b>Note</b>', width: 20, height: 3, css: 'color: red;', script: '' },
    ],
    css: '.sheet { color: red }',
    scripts: { load: 'veneer.setField("6:53", "X")', show: '' },
  });
  assert.equal(clean.title, 'New order');
  assert.equal(clean.changes.length, 4);
  assert.equal(clean.css, '.sheet { color: red }');
  assert.deepEqual(clean.scripts, { load: 'veneer.setField("6:53", "X")' }, 'empty scripts dropped');
  assert.deepEqual(validateDefinition({ ...clean, scripts: undefined, script: 'old' }).scripts, { show: 'old' }, 'an old `script` runs on show');
  assert.deepEqual(clean.changes[3], { op: 'html', at: { row: 5, col: 50 }, html: '<b>Note</b>', width: 20, height: 3, css: 'color: red;' });
  assert.ok(!('extra' in clean));
});

test('rejects bad definitions with a useful path', () => {
  const base = { id: 'x', name: 'X', match: { text: [{ row: 1, col: 1, text: 'X' }] }, changes: [] };
  const cases: Array<[unknown, RegExp]> = [
    [{ ...base, id: '../etc' }, /id: must be lowercase/],
    [{ ...base, match: { text: [] } }, /match: needs a screen id/],
    [{ ...base, match: { text: [], screenIds: ['not-hex!'] } }, /match\.screenIds\[0\]/],
    [{ ...base, changes: [{ op: 'hide', at: { row: 99, col: 1 } }] }, /changes\[0\]\.at\.row/],
    [{ ...base, changes: [{ op: 'button', label: 'x', action: { aid: 'F99' } }] }, /aid/],
    [{ ...base, changes: [{ op: 'widget', field: '7:22', widget: { type: 'date', format: 'bogus' } }] }, /format/],
    [{ ...base, changes: [{ op: 'explode' }] }, /op/],
    [{ ...base, changes: [{ op: 'move', at: { row: 1, col: 1 }, to: { row: 44, col: 1 } }] }, /changes\[0\]\.to\.row/],
    [{ ...base, changes: [{ op: 'html', at: { row: 1, col: 1 }, html: 'x', width: 0, height: 1 }] }, /changes\[0\]\.width/],
    [{ ...base, scripts: { show: 'x'.repeat(70_000) } }, /scripts\.show: must be a string/],
    [{ ...base, scripts: { click: 'x' } }, /scripts\.click: must be one of load, show/],
  ];
  for (const [input, message] of cases) assert.throws(() => validateDefinition(input), message);
});

test('validates site-wide CSS and JavaScript', () => {
  assert.deepEqual(validateSite({ css: 'body {}', scripts: { screen: 'x' } }), { css: 'body {}', scripts: { load: '', screen: 'x' } });
  assert.throws(() => validateSite({ scripts: { unload: 'x' } }), /scripts\.unload/);
  assert.throws(() => validateSite({ css: 1 }), /css: must be a string/);
});

test('converts host dates to and from ISO', () => {
  assert.equal(hostToIso('20261023', 'YYYYMMDD'), '2026-10-23');
  assert.equal(hostToIso('102326', 'MMDDYY'), '2026-10-23');
  assert.equal(hostToIso('10/23/99', 'MM/DD/YY'), '1999-10-23');
  assert.equal(hostToIso('20260231', 'YYYYMMDD'), '', 'invalid day');
  assert.equal(hostToIso('', 'YYYYMMDD'), '');
  assert.equal(isoToHost('2026-10-23', 'MMDDYY'), '102326');
  assert.equal(isoToHost('2026-10-23', 'DD/MM/YYYY'), '23/10/2026');
  assert.equal(isoToHost('', 'MMDDYY'), '');
});

test('validates cards and tabs', () => {
  const base = { id: 'x', name: 'X', match: { text: [{ row: 1, col: 1, text: 'X' }] } };
  const tabs = { op: 'tabs', tabs: [{ title: 'General', from: 4, to: 9 }, { title: 'Shipping', from: 10, to: 18 }] };
  const card = { op: 'card', from: { row: 5, col: 2 }, to: { row: 8, col: 40 }, title: 'Customer', extra: 1 };
  const clean = validateDefinition({ ...base, changes: [tabs, card, { ...card, from: { row: 20, col: 2 }, to: { row: 21, col: 9 }, title: '' }] });
  assert.deepEqual(clean.changes, [
    tabs,
    { op: 'card', from: { row: 5, col: 2 }, to: { row: 8, col: 40 }, title: 'Customer' },
    { op: 'card', from: { row: 20, col: 2 }, to: { row: 21, col: 9 } },
  ]);
  const cases: Array<[unknown[], RegExp]> = [
    [[{ ...card, to: { row: 4, col: 40 } }], /changes\[0\]\.to: must be below/],
    [[{ ...tabs, tabs: [tabs.tabs[0]] }], /needs at least two tabs/],
    [[{ ...tabs, tabs: [tabs.tabs[0], { title: 'Gap', from: 11, to: 12 }] }], /tabs\[1\]\.from: must be 10/],
    [[{ ...tabs, tabs: [tabs.tabs[0], { title: ' ', from: 10, to: 12 }] }], /tabs\[1\]\.title: must not be blank/],
    [[{ ...tabs, tabs: [{ title: 'Up', from: 9, to: 4 }, tabs.tabs[1]] }], /tabs\[0\]\.to/],
    [[tabs, tabs], /only one tabs change/],
    [[tabs, { ...card, to: { row: 12, col: 40 } }], /changes\[1\]: a card must not be split between tabs/],
    [[tabs, { ...card, from: { row: 2, col: 2 } }], /changes\[1\]: a card must not be split/],
  ];
  for (const [changes, message] of cases) assert.throws(() => validateDefinition({ ...base, changes }), message);
});

test('validates components', () => {
  const base = { id: 'x', name: 'X', match: { text: [{ row: 1, col: 1, text: 'X' }] } };
  const c = { op: 'component', name: 'bar-chart', at: { row: 12, col: 2 }, width: 40, height: 6, options: { column: 'Amount', max: 5 } };
  assert.deepEqual(validateDefinition({ ...base, changes: [c, { ...c, name: 'star-rating', field: '19:24', options: undefined }] }).changes, [
    c,
    { op: 'component', name: 'star-rating', at: { row: 12, col: 2 }, width: 40, height: 6, field: '19:24' },
  ]);
  const cases: Array<[unknown, RegExp]> = [
    [{ ...c, name: '../evil' }, /changes\[0\]\.name: must be a component name/],
    [{ ...c, field: 'x' }, /changes\[0\]\.field/],
    [{ ...c, options: [1] }, /changes\[0\]\.options: must be an object/],
    [{ ...c, options: { big: 'x'.repeat(20_000) } }, /changes\[0\]\.options: must be at most/],
    [{ ...c, height: 0 }, /changes\[0\]\.height/],
  ];
  for (const [change, message] of cases) assert.throws(() => validateDefinition({ ...base, changes: [change] }), message);
});

test('validates the site style: listed values only, so it cannot inject CSS', () => {
  assert.deepEqual(validateStyle({}), { look: 'default' });
  const style = { look: 'flat', accent: '#0A7F5A', corners: 'round', density: 'roomy', font: 'mono' };
  assert.deepEqual(validateStyle(style), style);
  assert.throws(() => validateStyle({ look: 'neon' }), /style\.look: must be one of default, compact/);
  assert.throws(() => validateStyle({ look: 'flat', accent: 'red' }), /style\.accent: must be a hex color/);
  assert.throws(() => validateStyle({ look: 'flat', accent: '#123; } body { display: none' }), /hex color/);
  assert.throws(() => validateStyle({ look: 'flat', density: 'huge' }), /style\.density/);
  assert.throws(() => validateStyle({ look: 'flat', css: 'x' }), /style\.css: is not a style option/);
});

test('validates radio buttons, spinners and text areas', () => {
  const base = { id: 'x', name: 'X', match: { text: [{ row: 1, col: 1, text: 'X' }] } };
  const w = (field: string, widget: unknown) => ({ op: 'widget', field, widget });
  const radio = { type: 'radio', options: [{ value: 'A', label: 'Air' }, { value: 'O', label: 'Ocean' }], layout: 'column', allowClear: true, extra: 1 };
  const spinner = { type: 'spinner', min: 0, max: 999, step: 0.5 };
  const area = { type: 'textarea', fields: ['14:10', '15:10', '16:10'] };
  const clean = validateDefinition({ ...base, changes: [w('8:22', radio), w('12:30', spinner), w('14:10', area)] });
  assert.deepEqual(clean.changes.map((c) => c.op === 'widget' && c.widget), [
    { type: 'radio', options: radio.options, layout: 'column', allowClear: true },
    spinner,
    area,
  ]);
  // Settings left out stay out; allowClear false is the same as none.
  assert.deepEqual(validateDefinition({ ...base, changes: [w('8:22', { type: 'radio', options: [], allowClear: false }), w('9:1', { type: 'spinner' })] })
    .changes.map((c) => c.op === 'widget' && c.widget), [{ type: 'radio', options: [] }, { type: 'spinner' }]);

  const cases: Array<[unknown[], RegExp]> = [
    [[w('8:22', { ...radio, layout: 'grid' })], /widget\.layout: must be one of row, column/],
    [[w('8:22', { ...radio, allowClear: 'yes' })], /widget\.allowClear: must be true or false/],
    [[w('8:22', { ...radio, options: [{ value: 'A' }] })], /widget\.options\[0\]\.label/],
    [[w('8:22', { type: 'spinner', step: 0 })], /widget\.step: must be more than 0/],
    [[w('8:22', { type: 'spinner', min: 'one' })], /widget\.min: must be a number/],
    [[w('8:22', { type: 'spinner', max: Infinity })], /widget\.max: must be a number/],
    [[w('8:22', { type: 'spinner', min: 10, max: 1 })], /widget\.max: must not be less than min/],
    [[w('14:10', { type: 'textarea', fields: ['15:10', '14:10'] })], /widget\.fields: must start with the widget's own field, "14:10"/],
    [[w('14:10', { type: 'textarea', fields: ['14:10', '15:10', '15:10'] })], /lists "15:10" twice/],
    [[w('14:10', { type: 'textarea', fields: ['14:10', '15'] })], /widget\.fields\[1\]: must be a field id/],
    [[w('14:10', { type: 'textarea', fields: [] })], /must start with the widget's own field/],
    [[w('14:10', { type: 'textarea', fields: Array.from({ length: 28 }, (_x, i) => `${i + 1}:10`) })], /widget\.fields: must be an array of at most 27/],
    [[w('14:10', area), w('16:10', { type: 'textarea', fields: ['16:10', '17:10'] })], /changes\[1\]\.widget\.fields: "16:10" is already in the text area of changes\[0\]/],
    [[w('14:10', area), w('15:10', { type: 'select', options: [] })], /changes\[1\]\.field: "15:10" is part of the text area of changes\[0\]/],
    [[w('8:22', { type: 'slider' })], /widget\.type: must be select, checkbox, date, radio, spinner or textarea/],
  ];
  for (const [changes, message] of cases) assert.throws(() => validateDefinition({ ...base, changes }), message);
});
