// Names for things on the screen as people read them: an input field by its
// label ("Customer number") or its list column and row, text by its words, a
// list by its headings. Used where the designer would otherwise say "field 6:22".

import type { Target } from '@veneer/screens';
import type { ScreenSnapshot } from '@veneer/terminal';
import { homeOf, itemAt } from '../transform/customize.ts';
import { stripLeaders } from '../transform/text.ts';
import type { FieldItem, Item, ScreenView, TableItem } from '../transform/types.ts';

/** A label as people read it: up to a wide gap, without the dot leaders and colon of "Customer . . . :". */
export function labelText(text: string): string {
  return stripLeaders(text.split(/\s{2,}(?![.:])/)[0]!).replace(/\s*:$/, '').trim();
}

/**
 * The human name of what is at a position, without quotes: an input field's
 * label, or the text there. Undefined when there is nothing to call it.
 *
 * By default names are the host's (as sent, before any change), as a change
 * list needs ("Change “Customer” to “Customer number”"). `shown` names things
 * as the customized `view` shows them instead, for the current selection.
 */
export function labelAt(view: ScreenView, snap: ScreenSnapshot, at: Target, { shown = false } = {}): string | undefined {
  const items: Item[] = [...view.items, ...(view.window?.items ?? [])];
  const field = snap.fields.find((f) => f.row === at.row && f.col === at.col);
  if (field) {
    const item = items.find((i): i is FieldItem => i.kind === 'field' && i.field.row === field.row && i.field.col === field.col);
    if (item?.command) return 'Command line';
    const label = shown ? shownLabel(items, field) : item?.label;
    if (label && labelText(label)) return labelText(label);
    for (const t of items) {
      if (t.kind !== 'table') continue;
      const r = t.rows.findIndex((row) => row.cells.some((c) => c.field?.row === field.row && c.field.col === field.col));
      if (r < 0) continue;
      const k = t.rows[r]!.cells.findIndex((c) => c.field?.row === field.row && c.field.col === field.col);
      const header = t.columns[k]?.header.trim();
      return `${header || 'List'}, row ${r + 1}`;
    }
    return undefined;
  }
  const item = itemAt(items, at) ?? itemAt(view.meta, at);
  if (item?.kind === 'table') return listName(item);
  if (shown && (item?.kind === 'text' || item?.kind === 'link')) return labelText(item.text) || undefined;
  return labelText((snap.lines[at.row - 1] ?? '').slice(at.col - 1)) || undefined;
}

/** For sentences: “Customer number”, or "field 6:22" / "row 4, column 3" when it has no name. */
export function nameAt(view: ScreenView, snap: ScreenSnapshot, at: Target): string {
  const label = labelAt(view, snap, at);
  if (label) return `“${clip(label)}”`;
  return snap.fields.some((f) => f.row === at.row && f.col === at.col) ? `field ${at.row}:${at.col}` : `row ${at.row}, column ${at.col}`;
}

/** The text nearest the left of a field on its row, as customized: what labels it on the page. */
function shownLabel(items: Item[], field: { row: number; col: number }): string | undefined {
  return items
    .filter((i) => i.kind === 'text' && homeOf(i).row === field.row && homeOf(i).col < field.col)
    .sort((a, b) => homeOf(a).col - homeOf(b).col)
    .map((i) => (i.kind === 'text' ? i.text : ''))
    .findLast((t) => labelText(t) !== '');
}

function listName(t: TableItem): string {
  const headers = t.columns.map((c) => c.header.trim()).filter(Boolean);
  return headers.length > 0 ? `List of ${clip(headers.join(', '))}` : 'List';
}

export function clip(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
