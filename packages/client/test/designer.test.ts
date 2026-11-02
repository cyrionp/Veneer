import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matches, screenId } from '@veneer/screens';
import {
  addScreenId, formatOptions, isHidden, newDefinition, originalText, parseOptions, removeScreenId, resolveSelection,
  freeSpot, htmlAt, htmlOf, moveOf, setCss, setMove, setScript, setHidden, setHtml, setRole, setText, setWidget, slug, textOf, widgetOf,
} from '../src/designer/edit.ts';
import { customize } from '../src/transform/customize.ts';
import { transform } from '../src/transform/index.ts';
import { mainMenu, orderEntry, workWithJobs } from './screens.ts';

test('a new definition is recognised by the screen id', () => {
  const snap = workWithJobs();
  const def = newDefinition(snap, transform(snap));
  assert.equal(def.id, 'work-with-active-jobs');
  assert.deepEqual(def.match, { screenIds: [screenId(snap)], text: [] });
  assert.equal(def.host, '5250', 'the designer records the host type');
  assert.equal(newDefinition({ ...snap, host: '3270' }, transform(snap)).host, '3270');
  assert.ok(matches(snap, def), 'a new definition matches the screen it was made on');
  assert.ok(!matches(mainMenu(), def));
});

test('screen ids are added once and removed cleanly', () => {
  const snap = workWithJobs();
  const def = newDefinition(snap, transform(snap));
  const two = addScreenId(addScreenId(def, 'abcdef0123'), 'abcdef0123');
  assert.equal(two.match.screenIds?.length, 2);
  const none = removeScreenId(removeScreenId(two, 'abcdef0123'), screenId(snap));
  assert.ok(!('screenIds' in none.match));
});

test('edits changes per target without duplicates', () => {
  const snap = orderEntry();
  let def = newDefinition(snap, transform(snap));
  const at = { row: 4, col: 3 };
  def = setText(setText(def, at, 'Customer #'), at, 'Customer number');
  def = setRole(setHidden(def, at, true), at, 'emphasis');
  assert.equal(textOf(def, at), 'Customer number');
  assert.ok(isHidden(def, at));
  assert.equal(def.changes.length, 3);
  def = setHidden(setText(def, at, null), at, false);
  assert.deepEqual(def.changes.map((c) => c.op), ['role']);

  def = setWidget(def, '5:20', { type: 'checkbox', on: 'Y', off: 'N' });
  def = setWidget(def, '5:20', { type: 'date', format: 'MMDDYY' });
  assert.equal(widgetOf(def, '5:20')?.type, 'date');
  assert.equal(setWidget(def, '5:20', null).changes.length, 1);
});

test('resolves clicks to fields first, then items', () => {
  const snap = orderEntry();
  const view = transform(snap);
  assert.equal(resolveSelection(view, snap, { row: 5, col: 20 })?.kind, 'field');
  const label = resolveSelection(view, snap, { row: 4, col: 5 });
  assert.equal(label?.kind, 'item');
  assert.deepEqual(label?.at, { row: 4, col: 3 }, 'normalised to the item start');
  assert.deepEqual(originalText(snap, { row: 4, col: 3, width: 8 }), { row: 4, col: 3, text: 'Customer' });
});

test('empty space selects the cell; custom HTML is selected over what it covers', () => {
  const snap = orderEntry();
  const view = transform(snap);
  assert.deepEqual(resolveSelection(view, snap, { row: 20, col: 60 }), { kind: 'empty', at: { row: 20, col: 60 } });
  const def = setHtml(newDefinition(snap, view), { row: 5, col: 18 }, { at: { row: 5, col: 18 }, html: 'x', width: 8, height: 1 });
  const sel = resolveSelection(customize(view, def, { design: true }), snap, { row: 5, col: 20 });
  assert.equal(sel?.kind === 'item' && sel.item.kind, 'html', 'not the input field under it');
});

test('custom HTML is added, moved and removed; code is set and cleared', () => {
  const snap = orderEntry();
  const at = { row: 3, col: 40 };
  let def = setHtml(newDefinition(snap, transform(snap)), at, { at, html: 'a', width: 5, height: 1 });
  def = setHtml(def, at, { at, html: 'b', width: 5, height: 1 });
  assert.equal(def.changes.length, 1, 'same position replaces');
  def = setHtml(def, at, { at: { row: 4, col: 40 }, html: 'b', width: 5, height: 1 });
  assert.equal(htmlAt(def, at), undefined);
  assert.equal(htmlAt(def, { row: 4, col: 40 })?.html, 'b', 'moved');
  assert.equal(setHtml(def, { row: 4, col: 40 }, null).changes.length, 0);

  const withCss = setCss(def, '.a {}');
  assert.equal(withCss.css, '.a {}');
  assert.ok(!('css' in setCss(withCss, '')));
  const both = setScript(setScript(def, 'load', 'a'), 'show', 'b');
  assert.deepEqual(both.scripts, { load: 'a', show: 'b' });
  assert.deepEqual(setScript(both, 'load', '').scripts, { show: 'b' });
  assert.ok(!('scripts' in setScript(setScript(both, 'load', ''), 'show', '')), 'no empty scripts object');
});

test('Add HTML picks a blank row not already holding HTML', () => {
  const snap = orderEntry();
  const def = newDefinition(snap, transform(snap));
  const first = freeSpot(snap, def);
  assert.equal(snap.lines[first.row - 1]!.trim(), '');
  const next = freeSpot(snap, setHtml(def, first, { at: first, html: 'x', width: 10, height: 1 }));
  assert.ok(next.row > first.row);
  const tall = freeSpot(snap, def, 2);
  assert.equal(snap.lines[tall.row]!.trim(), '', 'both rows blank');
  assert.equal(htmlOf(setHtml(def, first, { at: first, html: 'x', width: 10, height: 1 })).length, 1);
});

test('moves are set, replaced and removed', () => {
  const snap = orderEntry();
  const at = { row: 4, col: 3 };
  let def = setMove(newDefinition(snap, transform(snap)), at, { row: 2, col: 5 });
  def = setMove(def, at, { row: 3, col: 5 });
  assert.deepEqual(moveOf(def, at), { row: 3, col: 5 });
  assert.equal(def.changes.length, 1);
  assert.equal(setMove(def, at, at).changes.length, 0, 'moving home removes the change');
  assert.equal(setMove(def, at, null).changes.length, 0);
});

test('option lists round-trip through value=Label lines', () => {
  const opts = parseOptions('TX=Texas\n CA = California \n\nNY');
  assert.deepEqual(opts, [{ value: 'TX', label: 'Texas' }, { value: 'CA', label: 'California' }, { value: 'NY', label: 'NY' }]);
  assert.equal(formatOptions(opts), 'TX=Texas\nCA=California\nNY=NY');
  assert.equal(slug('Work with Active Jobs!'), 'work-with-active-jobs');
});
