// Pure helpers the designer uses to build and edit screen definitions.

import { MAX_TEXTAREA_FIELDS, screenId, type ButtonAction, type Change, type Role, type ScreenDefinition, type ScreenEvent, type TabBand, type Target, type TextMatch, type Widget } from '@veneer/screens';
import type { FieldSnapshot, ScreenSnapshot } from '@veneer/terminal';
import { heightOf, homeOf, isBox, itemAt } from '../transform/customize.ts';
import type { Item, ScreenView } from '../transform/types.ts';

const same = (a: Target, b: Target) => a.row === b.row && a.col === b.col;

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'screen';
}

/** A new definition for this screen, recognised by its screen id. */
export function newDefinition(snap: ScreenSnapshot, view: ScreenView): ScreenDefinition {
  const name = view.title ?? 'New screen';
  return { id: slug(name), name, host: snap.host, match: { screenIds: [screenId(snap)], text: [] }, changes: [] };
}

export function addScreenId(def: ScreenDefinition, id: string): ScreenDefinition {
  const ids = def.match.screenIds ?? [];
  return ids.includes(id) ? def : { ...def, match: { ...def.match, screenIds: [...ids, id] } };
}

export function removeScreenId(def: ScreenDefinition, id: string): ScreenDefinition {
  const ids = (def.match.screenIds ?? []).filter((x) => x !== id);
  const { screenIds: _omit, ...rest } = def.match;
  return { ...def, match: ids.length > 0 ? { ...rest, screenIds: ids } : rest };
}

/** The screen text under an item, as the host sent it (for a match rule). */
export function originalText(snap: ScreenSnapshot, item: { row: number; col: number; width: number }): TextMatch | null {
  const text = (snap.lines[item.row - 1] ?? '').slice(item.col - 1, item.col - 1 + item.width).trimEnd();
  return text.trim() ? { row: item.row, col: item.col, text } : null;
}

// ---- what is selected -------------------------------------------------------

export type Selection =
  | { kind: 'field'; at: Target; field: FieldSnapshot; item?: Item }
  /** `header`: text from the title row, shown in the page header (it cannot move). */
  | { kind: 'item'; at: Target; item: Item; header?: boolean }
  | { kind: 'empty'; at: Target };

/** Resolve a clicked position: custom HTML or an input field first, else the item covering it, else the empty cell. */
export function resolveSelection(view: ScreenView, snap: ScreenSnapshot, at: Target): Selection | null {
  const header = itemAt(view.meta, at);
  if (header) return { kind: 'item', at: { row: header.row, col: header.col }, item: header, header: true };
  const items = [...view.items, ...(view.window?.items ?? [])];
  const item = itemAt(items, at);
  if (item && isBox(item)) return { kind: 'item', at: homeOf(item), item };
  const field = snap.fields.find((f) => !f.bypass && f.row === at.row && f.col === at.col);
  if (field) return { kind: 'field', at, field, ...(item?.kind === 'field' ? { item } : {}) };
  if (item) return { kind: 'item', at: homeOf(item), item };
  return at.row <= snap.rows && at.col <= snap.cols ? { kind: 'empty', at } : null;
}

// ---- reading and writing changes -------------------------------------------

type ChangeOf<K extends Change['op']> = Extract<Change, { op: K }>;

function findAt<K extends 'hide' | 'text' | 'role'>(def: ScreenDefinition, op: K, at: Target): ChangeOf<K> | undefined {
  return def.changes.find((c): c is ChangeOf<K> => c.op === op && same((c as { at: Target }).at, at));
}

/** Replace (or with `next` null, remove) the change of one op at one target. */
function putAt(def: ScreenDefinition, op: 'hide' | 'text' | 'role', at: Target, next: Change | null): ScreenDefinition {
  const changes = def.changes.filter((c) => !(c.op === op && same((c as { at: Target }).at, at)));
  return { ...def, changes: next ? [...changes, next] : changes };
}

export const isHidden = (def: ScreenDefinition, at: Target) => findAt(def, 'hide', at) !== undefined;
export const textOf = (def: ScreenDefinition, at: Target) => findAt(def, 'text', at)?.text;
export const roleOf = (def: ScreenDefinition, at: Target) => findAt(def, 'role', at)?.role;

export const setHidden = (def: ScreenDefinition, at: Target, hidden: boolean) =>
  putAt(def, 'hide', at, hidden ? { op: 'hide', at } : null);

export const setText = (def: ScreenDefinition, at: Target, text: string | null) =>
  putAt(def, 'text', at, text === null ? null : { op: 'text', at, text });

export const setRole = (def: ScreenDefinition, at: Target, role: Role | null) =>
  putAt(def, 'role', at, role === null ? null : { op: 'role', at, role });

export function widgetOf(def: ScreenDefinition, field: string): Widget | undefined {
  return def.changes.find((c): c is ChangeOf<'widget'> => c.op === 'widget' && c.field === field)?.widget;
}

export function setWidget(def: ScreenDefinition, field: string, widget: Widget | null): ScreenDefinition {
  const changes = def.changes.filter((c) => !(c.op === 'widget' && c.field === field));
  return { ...def, changes: widget ? [...changes, { op: 'widget', field, widget }] : changes };
}

type Html = ChangeOf<'html'>;

export function htmlAt(def: ScreenDefinition, at: Target): Html | undefined {
  return def.changes.find((c): c is Html => c.op === 'html' && same(c.at, at));
}

/** Add, replace (same position) or with `next` null remove custom HTML. */
export function setHtml(def: ScreenDefinition, at: Target, next: Omit<Html, 'op'> | null): ScreenDefinition {
  const changes = def.changes.map((c) => (c.op === 'html' && same(c.at, at) && next ? { op: 'html' as const, ...next } : c))
    .filter((c) => !(c.op === 'html' && same(c.at, at) && !next));
  return htmlAt(def, at) || !next ? { ...def, changes } : { ...def, changes: [...changes, { op: 'html', ...next }] };
}

type Component = ChangeOf<'component'>;

export function componentAt(def: ScreenDefinition, at: Target): Component | undefined {
  return def.changes.find((c): c is Component => c.op === 'component' && same(c.at, at));
}

export function componentsOf(def: ScreenDefinition): Component[] {
  return def.changes.filter((c): c is Component => c.op === 'component');
}

/** Add, replace (same position) or with `next` null remove a component. */
export function setComponent(def: ScreenDefinition, at: Target, next: Omit<Component, 'op'> | null): ScreenDefinition {
  const exists = componentAt(def, at) !== undefined;
  const changes = def.changes.flatMap<Change>((c) => (c.op === 'component' && same(c.at, at) ? (next ? [{ op: 'component', ...next }] : []) : [c]));
  return { ...def, changes: exists || !next ? changes : [...changes, { op: 'component', ...next }] };
}

/** The component drawing a field instead of its input, if any. */
export function componentForField(def: ScreenDefinition, field: string): Component | undefined {
  return def.changes.find((c): c is Component => c.op === 'component' && c.field === field);
}

/** Where a customization moved the item at `at`, if it did. */
export function moveOf(def: ScreenDefinition, at: Target): Target | undefined {
  return def.changes.find((c): c is ChangeOf<'move'> => c.op === 'move' && same(c.at, at))?.to;
}

/** Move the item at `at` to `to`; null, or its own place, puts it back. */
export function setMove(def: ScreenDefinition, at: Target, to: Target | null): ScreenDefinition {
  const changes = def.changes.filter((c) => !(c.op === 'move' && same(c.at, at)));
  return { ...def, changes: to && !same(to, at) ? [...changes, { op: 'move', at, to }] : changes };
}

export function htmlOf(def: ScreenDefinition): Html[] {
  return def.changes.filter((c): c is Html => c.op === 'html');
}

/**
 * Where "Add HTML" puts a new box `height` rows tall: the first run of blank
 * screen rows below the title not already holding custom HTML, else row 2.
 */
export function freeSpot(snap: ScreenSnapshot, def: ScreenDefinition, height = 1): Target {
  const free = (row: number) => (snap.lines[row - 1] ?? '').trim() === ''
    && !htmlOf(def).some((h) => row >= h.at.row && row < h.at.row + h.height);
  for (let row = 3; row + height - 1 <= snap.rows - 2; row++) {
    if (Array.from({ length: height }, (_, i) => row + i).every(free)) return { row, col: 2 };
  }
  return { row: 2, col: 2 };
}

/** Set or clear (empty string) the definition's CSS. */
export function setCss(def: ScreenDefinition, css: string): ScreenDefinition {
  const { css: _omit, ...rest } = def;
  return css === '' ? rest : { ...rest, css };
}

/** Set or clear (empty string) the script for one screen event. */
export function setScript(def: ScreenDefinition, event: ScreenEvent, code: string): ScreenDefinition {
  const { [event]: _omit, ...others } = def.scripts ?? {};
  const scripts = code === '' ? others : { ...others, [event]: code };
  const { scripts: _old, ...rest } = def;
  return Object.keys(scripts).length > 0 ? { ...rest, scripts } : rest;
}

export function buttonsOf(def: ScreenDefinition): Array<ChangeOf<'button'>> {
  return def.changes.filter((c): c is ChangeOf<'button'> => c.op === 'button');
}

/** Replace the button list, keeping other changes in place. */
export function setButtons(def: ScreenDefinition, buttons: Array<{ label: string; action: ButtonAction }>): ScreenDefinition {
  return {
    ...def,
    changes: [...def.changes.filter((c) => c.op !== 'button'), ...buttons.map((b) => ({ op: 'button' as const, ...b }))],
  };
}

/** Role names as the designer shows them. */
export const ROLE_LABELS: Record<Role, string> = {
  normal: 'Normal', emphasis: 'Bold', muted: 'Muted', danger: 'Error', warning: 'Warning', accent: 'Accent', accent2: 'Highlight',
};

export type StyleRule = Omit<ChangeOf<'style'>, 'op'>;

export function stylesOf(def: ScreenDefinition): StyleRule[] {
  return def.changes.filter((c): c is ChangeOf<'style'> => c.op === 'style').map(({ op: _op, ...rule }) => rule);
}

/** Replace the style rules, keeping other changes in place. Rules apply in order. */
export function setStyles(def: ScreenDefinition, rules: StyleRule[]): ScreenDefinition {
  return {
    ...def,
    changes: [...def.changes.filter((c) => c.op !== 'style'), ...rules.map((r) => ({ op: 'style' as const, ...r }))],
  };
}

// ---- cards and tabs ----------------------------------------------------------

export type CardSpec = Omit<ChangeOf<'card'>, 'op'>;

export function cardsOf(def: ScreenDefinition): CardSpec[] {
  return def.changes.filter((c): c is ChangeOf<'card'> => c.op === 'card').map(({ op: _op, ...card }) => card);
}

/** Add, replace (same top-left) or with `next` null remove a card. Cards are named by their top-left. */
export function setCard(def: ScreenDefinition, from: Target, next: CardSpec | null): ScreenDefinition {
  const exists = cardsOf(def).some((c) => same(c.from, from));
  const changes = def.changes.flatMap<Change>((c) => (c.op === 'card' && same(c.from, from) ? (next ? [{ op: 'card' as const, ...next }] : []) : [c]));
  return { ...def, changes: exists || !next ? changes : [...changes, { op: 'card', ...next }] };
}

/** A card around an item where it is drawn. */
export function cardAround(item: Item): CardSpec {
  return { from: { row: item.row, col: item.col }, to: { row: item.row + heightOf(item) - 1, col: item.col + item.width - 1 } };
}

export function tabsOf(def: ScreenDefinition): TabBand[] {
  return def.changes.find((c): c is ChangeOf<'tabs'> => c.op === 'tabs')?.tabs ?? [];
}

/** Replace the tabs; fewer than two removes them. They stay where they were in the changes. */
export function setTabs(def: ScreenDefinition, tabs: TabBand[]): ScreenDefinition {
  const had = def.changes.some((c) => c.op === 'tabs');
  const changes = def.changes.flatMap<Change>((c) => (c.op !== 'tabs' ? [c] : tabs.length >= 2 ? [{ op: 'tabs' as const, tabs }] : []));
  return { ...def, changes: had || tabs.length < 2 ? changes : [...changes, { op: 'tabs', tabs }] };
}

/** The rows items are drawn on, for the first split into tabs. */
export function tabRegion(view: ScreenView): { from: number; to: number } {
  const rows = view.items.flatMap((i) => [i.row, i.row + heightOf(i) - 1]);
  return rows.length ? { from: Math.min(...rows), to: Math.max(...rows) } : { from: 1, to: 1 };
}

/**
 * Start a new tab at `row`: split the tab holding it, or with no tabs yet,
 * split `region` in two. Unchanged when `row` already starts a tab or is
 * outside them.
 */
export function splitTabs(tabs: TabBand[], row: number, region: { from: number; to: number }): TabBand[] {
  const bands = tabs.length ? tabs : [{ title: 'Tab 1', from: region.from, to: region.to }];
  const i = bands.findIndex((b) => row > b.from && row <= b.to);
  if (i < 0) return tabs;
  const b = bands[i]!;
  return [...bands.slice(0, i), { ...b, to: row - 1 }, { title: `Tab ${bands.length + 1}`, from: row, to: b.to }, ...bands.slice(i + 1)];
}

/** Remove a tab; its rows join the tab before it (the first tab's join the next). */
export function removeTab(tabs: TabBand[], i: number): TabBand[] {
  if (tabs.length <= 2) return [];
  const rest = tabs.filter((_, j) => j !== i);
  const gone = tabs[i]!;
  return rest.map((t, j) => (i > 0 && j === i - 1 ? { ...t, to: gone.to } : i === 0 && j === 0 ? { ...t, from: gone.from } : t));
}

/** Move where tab `i` starts, or with `i` equal to the count, where the last one ends. Kept at least one row each. */
export function moveTabEdge(tabs: TabBand[], i: number, row: number): TabBand[] {
  if (i === tabs.length) {
    const last = tabs[i - 1]!;
    return tabs.map((t, j) => (j === i - 1 ? { ...t, to: Math.min(27, Math.max(last.from, row)) } : t));
  }
  if (i === 0) return tabs.map((t, j) => (j === 0 ? { ...t, from: Math.max(1, Math.min(t.to, row)) } : t));
  const r = Math.max(tabs[i - 1]!.from + 1, Math.min(tabs[i]!.to, row));
  return tabs.map((t, j) => (j === i - 1 ? { ...t, to: r - 1 } : j === i ? { ...t, from: r } : t));
}

// ---- small text formats used by the panel -----------------------------------

/** "value=Label" lines <-> select options. */
export function parseOptions(text: string): Array<{ value: string; label: string }> {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return i < 0 ? { value: l, label: l } : { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() };
  });
}

export const formatOptions = (options: Array<{ value: string; label: string }>) =>
  options.map((o) => `${o.value}=${o.label}`).join('\n');

// ---- text areas ------------------------------------------------------------

type TextArea = Extract<Widget, { type: 'textarea' }>;

/** The text area a field is in, as its first field or one of the others. */
export function textAreaOf(def: ScreenDefinition, field: string): { first: string; widget: TextArea } | undefined {
  for (const c of def.changes) {
    if (c.op === 'widget' && c.widget.type === 'textarea' && (c.field === field || c.widget.fields.includes(field))) {
      return { first: c.field, widget: c.widget };
    }
  }
  return undefined;
}

const fieldOrder = (id: string) => {
  const [row, col] = id.split(':').map(Number) as [number, number];
  return row * 1000 + col;
};

/** Whether a field is free to join a text area: no widget, component or other text area of its own. */
function isFree(def: ScreenDefinition, first: string, id: string): boolean {
  const area = textAreaOf(def, id);
  if (area && area.first !== first) return false;
  if (componentForField(def, id)) return false;
  return !def.changes.some((c) => c.op === 'widget' && c.field === id && c.widget.type !== 'textarea');
}

/**
 * Add a field to the text area starting at `first`, or take it out if it is in
 * it. Fields stay in screen order, after the first; one above the first, or in
 * use by another widget, component or text area, is left alone.
 */
export function toggleTextAreaField(def: ScreenDefinition, first: string, id: string): ScreenDefinition {
  const area = widgetOf(def, first);
  if (area?.type !== 'textarea' || id === first) return def;
  if (area.fields.includes(id)) return setWidget(def, first, { type: 'textarea', fields: area.fields.filter((f) => f !== id) });
  if (fieldOrder(id) < fieldOrder(first) || !isFree(def, first, id) || area.fields.length >= MAX_TEXTAREA_FIELDS) return def;
  const fields = [first, ...[...area.fields.slice(1), id].sort((a, b) => fieldOrder(a) - fieldOrder(b))];
  return setWidget(def, first, { type: 'textarea', fields });
}

/**
 * The input fields that continue a text area down the screen: on each
 * following row, the field in the same column with the same length, while
 * there is one and it's free.
 */
export function fieldsBelow(def: ScreenDefinition, snap: ScreenSnapshot, first: string): string[] {
  const head = snap.fields.find((f) => f.id === first);
  const area = widgetOf(def, first);
  if (!head || area?.type !== 'textarea') return [];
  const out: string[] = [];
  for (let row = head.row + 1; row <= snap.rows; row++) {
    const f = snap.fields.find((x) => !x.bypass && x.row === row && x.col === head.col && x.length === head.length);
    if (!f || !isFree(def, first, f.id)) break;
    if (!area.fields.includes(f.id)) out.push(f.id);
    if (area.fields.length + out.length >= MAX_TEXTAREA_FIELDS) break;
  }
  return out;
}
