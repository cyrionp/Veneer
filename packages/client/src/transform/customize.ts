// Applies a screen definition's changes to an auto-transformed view. Items are
// found by their screen position, so changes survive data changing on screen.

import { conditionTester, type Change, type ScreenDefinition, type Target } from '@veneer/screens';
import type { ComponentItem, FieldItem, HtmlItem, Item, ScreenView, TableItem } from './types.ts';

export interface CustomizeOptions {
  /** Designer mode: keep hidden items (marked hidden) so they can be selected. */
  design?: boolean;
}

/** Rows an item covers. */
export const heightOf = (i: Item) => (i.kind === 'table' || i.kind === 'html' || i.kind === 'component' ? i.height : 1);

/** Boxes from a definition (custom HTML and components), drawn on top of the screen. */
export const isBox = (i: Item): i is HtmlItem | ComponentItem => i.kind === 'html' || i.kind === 'component';

/** Where the host put an item (moved items are found by their original place). */
export const homeOf = (i: Item): Target => i.home ?? { row: i.row, col: i.col };

/** The item covering a target cell. Custom HTML and components are drawn on top, so they win. */
export function itemAt(items: readonly Item[], at: Target): Item | undefined {
  const covers = (i: Item) => {
    const h = homeOf(i);
    return at.row >= h.row && at.row < h.row + heightOf(i) && at.col >= h.col && at.col < h.col + i.width;
  };
  return items.find((i) => isBox(i) && covers(i)) ?? items.find(covers);
}

export function customize(view: ScreenView, def: ScreenDefinition | undefined, opts: CustomizeOptions = {}): ScreenView {
  if (!def) return view;
  const out: ScreenView = {
    ...view,
    items: view.items.map((i) => ({ ...i })),
    meta: view.meta.map((m) => ({ ...m })),
    ...(view.window ? { window: { ...view.window, items: view.window.items.map((i) => ({ ...i })) } } : {}),
    buttons: [],
    definition: { id: def.id, name: def.name },
  };
  if (def.title) out.title = def.title;
  if (def.css) out.css = def.css;
  if (def.scripts) out.scripts = def.scripts;
  const all = () => [...out.items, ...(out.window?.items ?? [])];
  // What hide, text, role and style apply to: the screen's own items, header
  // included (it can be hidden, renamed and restyled, but not moved). Boxes
  // from the definition (HTML, components) are edited through their own changes.
  const withHeader = () => [...all().filter((i) => !isBox(i)), ...out.meta];
  const moves: Array<Extract<ScreenDefinition['changes'][number], { op: 'move' }>> = [];

  for (const change of def.changes) {
    switch (change.op) {
      case 'hide': {
        const item = itemAt(withHeader(), change.at);
        if (item) item.hidden = true;
        break;
      }
      case 'text': {
        const item = itemAt(withHeader(), change.at);
        if (item?.kind === 'text' || item?.kind === 'link') item.text = change.text;
        break;
      }
      case 'role': {
        const item = itemAt(withHeader(), change.at);
        if (item?.kind === 'text') item.role = change.role;
        break;
      }
      case 'widget':
        if (change.widget.type === 'textarea') {
          joinFields(all(), change.field, change.widget.fields);
          break;
        }
        for (const item of all()) {
          if (item.kind === 'field' && item.field.id === change.field) item.widget = change.widget;
          if (item.kind === 'table') {
            item.rows = item.rows.map((r) => ({
              ...r,
              cells: r.cells.map((c) => (c.field?.id === change.field ? { ...c, widget: change.widget } : c)),
            }));
          }
        }
        break;
      case 'button':
        out.buttons.push({ label: change.label, action: change.action });
        break;
      case 'move':
        moves.push(change);
        break;
      case 'style':
        applyStyle(withHeader(), change);
        break;
      case 'card':
        (out.cards ??= []).push({
          top: change.from.row, left: change.from.col, bottom: change.to.row, right: change.to.col,
          ...(change.title ? { title: change.title } : {}),
        });
        break;
      case 'tabs':
        out.tabs = change.tabs.map((t) => ({ ...t }));
        break;
      case 'component': {
        const field = change.field !== undefined ? out.snapshot.fields.find((f) => f.id === change.field && !f.bypass) : undefined;
        const item: ComponentItem = {
          kind: 'component', row: change.at.row, col: change.at.col, width: change.width, height: change.height,
          name: change.name, options: change.options ?? {}, ...(field ? { field } : {}),
        };
        if (field) {
          for (const i of all()) if (i.kind === 'field' && i.field.id === field.id) i.component = change.name;
        }
        // In reading order with the other items, so Tab reaches it where it is drawn.
        const w = out.window;
        const list = w && item.row >= w.top && item.row <= w.bottom && item.col >= w.left && item.col <= w.right ? w.items : out.items;
        const k = list.findIndex((i) => i.row > item.row || (i.row === item.row && i.col > item.col));
        list.splice(k < 0 ? list.length : k, 0, item);
        break;
      }
      case 'html': {
        const item: HtmlItem = {
          kind: 'html', row: change.at.row, col: change.at.col, width: change.width, height: change.height, html: change.html,
          ...(change.css ? { css: change.css } : {}),
          ...(change.script ? { script: change.script } : {}),
        };
        // Inside an active window it goes in the window, above the dimmed screen.
        const w = out.window;
        if (w && item.row >= w.top && item.row <= w.bottom && item.col >= w.left && item.col <= w.right) w.items.push(item);
        else out.items.push(item);
        break;
      }
    }
  }

  // Moves come last, so the other changes still find items where the host put them.
  for (const m of moves) {
    const item = all().find((i) => !isBox(i) && i.row === m.at.row && i.col === m.at.col)
      ?? itemAt(all().filter((i) => !isBox(i)), m.at);
    if (item && !item.home) moveItem(item, m.to);
  }
  if (moves.length > 0) {
    // Tab order follows the new layout.
    const byPlace = (a: Item, b: Item) => a.row - b.row || a.col - b.col;
    out.items.sort(byPlace);
    out.window?.items.sort(byPlace);
  }

  if (!opts.design) {
    const hiddenTables = all().filter((i): i is TableItem => i.kind === 'table' && !!i.hidden);
    if (hiddenTables.length > 0) out.hiddenTables = hiddenTables;
    out.items = out.items.filter((i) => !i.hidden);
    out.meta = out.meta.filter((m) => !m.hidden);
    if (out.window) out.window.items = out.window.items.filter((i) => !i.hidden);
  }
  return out;
}

/**
 * A text area: the first field draws the box, the others are hidden under it.
 * Only fields drawn on their own count (not a list's cells), and the first must
 * be one, or nothing changes.
 */
function joinFields(items: Item[], first: string, ids: readonly string[]): void {
  const fields = new Map<string, FieldItem>();
  for (const i of items) if (i.kind === 'field') fields.set(i.field.id, i);
  const head = fields.get(first);
  if (!head) return;
  const parts = ids.map((id) => fields.get(id)).filter((i): i is FieldItem => i !== undefined);
  head.widget = { type: 'textarea', fields: parts.map((p) => p.field.id) };
  head.parts = parts.map((p) => p.field);
  for (const p of parts.slice(1)) {
    p.hidden = true;
    p.partOf = first;
  }
}

/**
 * A style rule: restyle the rows or cells whose cell in a column passes the
 * test, or the text or field at a position when its own value passes.
 */
function applyStyle(items: Item[], rule: Extract<Change, { op: 'style' }>): void {
  let passes: (text: string) => boolean;
  try {
    passes = conditionTester(rule.when);
  } catch {
    return; // A pattern being typed in the designer, not valid yet.
  }
  if (rule.when.at) {
    const item = itemAt(items, rule.when.at);
    if (item?.kind === 'text' && passes(item.text)) item.role = rule.role;
    if (item?.kind === 'field' && passes(item.field.value)) item.role = rule.role;
    return;
  }
  const heading = rule.when.column!.trim().toLowerCase();
  for (const table of items) {
    if (table.kind !== 'table') continue;
    const k = table.columns.findIndex((c) => c.header.trim().toLowerCase() === heading);
    if (k < 0) continue;
    table.rows = table.rows.map((r) => {
      const cell = r.cells[k];
      if (!cell || !passes(cell.field?.value ?? cell.text)) return r;
      return rule.target === 'row'
        ? { ...r, role: rule.role }
        : { ...r, cells: r.cells.map((c, j) => (j === k ? { ...c, role: rule.role, styled: true } : c)) };
    });
  }
}

function moveItem(item: Item, to: Target): void {
  const dr = to.row - item.row;
  const dc = to.col - item.col;
  item.home = { row: item.row, col: item.col };
  item.row = to.row;
  item.col = to.col;
  if (item.kind === 'table') {
    // Rows and columns are placed relative to the table, so they move with it.
    item.rows = item.rows.map((r) => ({ ...r, row: r.row + dr, cells: r.cells.map((c) => ({ ...c, col: c.col + dc })) }));
    item.columns = item.columns.map((c) => ({ ...c, col: c.col + dc }));
  }
}
