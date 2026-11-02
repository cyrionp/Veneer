// Where the modern view draws things. Items keep their 5250 rows, except when
// a customization splits rows into tabs: one band of rows then shows at a time
// under a strip of tab titles, and the rows below move up to follow the
// tallest band. Rows here are "layout rows"; item rows are where the view
// draws them (after moves).

import type { Target } from '@veneer/screens';
import { heightOf, itemAt } from '../transform/customize.ts';
import type { Card, Item, ScreenView, TabBand } from '../transform/types.ts';

/** Items and cards drawn together: view row `from` is drawn at layout row `row`. */
export interface Group {
  row: number;
  from: number;
  items: Item[];
  cards: Card[];
}

export interface Layout {
  /** Layout rows the canvas covers. */
  top: number;
  bottom: number;
  /** Everything, when there are no tabs; else what is above them. */
  main: Group;
  tabs?: {
    /** The layout row of the tab strip; panels start on the next row. */
    row: number;
    /** Rows each panel takes: the tallest band. */
    height: number;
    bands: TabBand[];
    panels: Group[];
    /** Rows below the tabs, moved up. */
    after: Group;
  };
}

/** Rows an item is drawn over: a text area covers its fields' rows. */
export function drawnHeight(i: Item): number {
  if (i.kind === 'field' && i.parts && i.parts.length > 0) return Math.max(1, Math.max(...i.parts.map((p) => p.row)) - i.field.row + 1);
  return heightOf(i);
}

/** Layout rows the items of a group cover, top and bottom of each. */
function rowsOf(g: Group): number[] {
  return g.items.flatMap((i) => [i.row, i.row + drawnHeight(i) - 1].map((r) => g.row + r - g.from));
}

export function layoutOf(view: ScreenView): Layout {
  const cards = view.cards ?? [];
  // A pop-up window is placed by the host's rows, so the screen keeps them.
  const bands = view.window ? undefined : view.tabs;
  if (!bands?.length) {
    const main: Group = { row: 1, from: 1, items: view.items, cards };
    const rows = rowsOf(main);
    if (view.window) rows.push(view.window.top - 1, view.window.bottom + 1);
    return rows.length === 0 ? { top: 1, bottom: 1, main } : { top: Math.min(...rows), bottom: Math.max(...rows), main };
  }
  const start = bands[0]!.from;
  const end = bands[bands.length - 1]!.to;
  const height = Math.max(...bands.map((b) => b.to - b.from + 1));
  const inRows = (from: number, to: number) => ({
    items: view.items.filter((i) => i.row >= from && i.row <= to),
    cards: cards.filter((c) => c.top >= from && c.top <= to),
  });
  const main: Group = { row: 1, from: 1, ...inRows(1, start - 1) };
  const panels = bands.map((b): Group => ({ row: start + 1, from: b.from, ...inRows(b.from, b.to) }));
  const after: Group = { row: start + 1 + height, from: end + 1, ...inRows(end + 1, Infinity) };
  const rows = [start, start + height, ...[main, ...panels, after].flatMap(rowsOf)];
  return { top: Math.min(...rows), bottom: Math.max(...rows), main, tabs: { row: start, height, bands, panels, after } };
}

/**
 * The tab to show for the cursor: the one holding the item at the cursor
 * (found where the host put it, drawn wherever it moved), else the first.
 */
export function tabAtCursor(layout: Layout, view: ScreenView, cursor: Target): number {
  if (!layout.tabs) return 0;
  const row = itemAt(view.items, cursor)?.row ?? cursor.row;
  return Math.max(0, layout.tabs.bands.findIndex((b) => row >= b.from && row <= b.to));
}

/** The view row drawn at a layout row with tab `active` showing (undefined on the strip). */
export function viewRow(layout: Layout, row: number, active: number): number | undefined {
  const t = layout.tabs;
  if (!t || row < t.row) return row;
  if (row === t.row) return undefined;
  if (row <= t.row + t.height) {
    const band = t.bands[active]!;
    const r = band.from + row - t.row - 1;
    return r <= band.to ? r : undefined;
  }
  return t.after.from + row - t.after.row;
}
