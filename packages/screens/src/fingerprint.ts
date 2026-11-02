// Screen IDs: a hash of what stays the same when the data changes. That is
// the screen size, the input-field layout (from the DDS record format or BMS
// map) and the title. Data, messages and the system name are left out. A 3270
// screen's id also says it is a 3270, so it never matches a 5250 screen's;
// 5250 ids are as they always were.

import type { FieldSnapshot, ScreenSnapshot } from '@veneer/terminal';
import { activeWindow, findWindows, type Region } from './windows.ts';

export interface Fingerprint {
  /** 14 hex digits; the same screen gives the same id in Node and the browser. */
  id: string;
  /** Distinct field layout entries hashed (0 means only the title identifies it). */
  fields: number;
  title: string | null;
  /** The exact text that was hashed, for debugging. */
  source: string;
}

export function screenId(snap: ScreenSnapshot): string {
  return fingerprint(snap).id;
}

export function fingerprint(snap: ScreenSnapshot): Fingerprint {
  // With a pop-up window open, the window alone identifies the screen, so a
  // prompt window gets the same id whatever screen it appears over.
  const win = activeWindow(snap, findWindows(snap));
  const region: Region = win
    ? { top: win.outer.top + 1, left: win.outer.left + 1, bottom: win.outer.bottom - 1, right: win.outer.right - 1 }
    : { top: 1, left: 1, bottom: snap.rows, right: snap.cols };

  const inRegion = (f: FieldSnapshot) =>
    f.row >= region.top && f.row <= region.bottom && f.col >= region.left && f.col <= region.right;
  const fields = collapseColumns(snap.fields.filter((f) => !f.bypass && inRegion(f)), region);
  const title = win ? win.title ?? highlightedRow(snap, region) : centeredTitle(snap);

  const source = [
    ...(snap.host === '3270' ? ['3270'] : []),
    `${snap.rows}x${snap.cols}`,
    win ? `window ${region.bottom - region.top + 1}x${region.right - region.left + 1}` : 'screen',
    `title ${title ?? ''}`,
    ...fields,
  ].join('\n');
  return { id: hash(source), fields: fields.length, title, source };
}

/** A field's layout without its row or contents; the column is relative to the region. */
function shape(f: FieldSnapshot, region: Region): string {
  const flags = [
    f.monocase ? 'u' : '', f.attr.nonDisplay ? 'h' : '', f.mandatoryEnter ? 'm' : '', f.autoEnter ? 'a' : '',
  ].join('');
  return `${f.col - region.left + 1}:${f.length}:${f.shift}:${f.adjust}:${flags}`;
}

/**
 * Fields repeated on consecutive rows in the same column (a subfile's option
 * column) count once, so the id does not depend on how many records are shown.
 * Rows are relative to the region, so a window keeps its id wherever it is drawn.
 */
function collapseColumns(fields: FieldSnapshot[], region: Region): string[] {
  const sorted = [...fields].sort((a, b) => a.row - b.row || a.col - b.col);
  const lastRowOfShape = new Map<string, number>();
  const out: string[] = [];
  for (const f of sorted) {
    const s = shape(f, region);
    const previous = lastRowOfShape.get(s);
    lastRowOfShape.set(s, f.row);
    if (previous === f.row - 1) continue; // continues a column
    out.push(`${f.row - region.top + 1}:${s}`);
  }
  return out;
}

/** Text chunks (split on two or more spaces) of a row within a region, with color. */
function chunks(snap: ScreenSnapshot, row: number, left = 1, right = snap.cols) {
  const out: Array<{ col: number; text: string; white: boolean }> = [];
  for (const seg of snap.segments[row - 1] ?? []) {
    if (seg.attr.nonDisplay) continue;
    for (const m of seg.text.matchAll(/\S+(?: \S+)*/g)) {
      const col = seg.col + m.index;
      if (col >= left && col + m[0].length - 1 <= right) out.push({ col, text: m[0], white: seg.attr.color === 'white' });
    }
  }
  return out;
}

/** The highlighted text nearest the center of the first non-blank row (not the system name beside it). */
function centeredTitle(snap: ScreenSnapshot): string | null {
  const row = snap.lines.findIndex((l) => l.trim() !== '') + 1;
  if (row === 0) return null;
  const all = chunks(snap, row);
  const white = all.filter((c) => c.white);
  const pool = white.length > 0 ? white : all.filter((c) => c.col > 10);
  const center = snap.cols / 2;
  const best = [...pool].sort((a, b) =>
    Math.abs(a.col + a.text.length / 2 - center) - Math.abs(b.col + b.text.length / 2 - center))[0];
  return best?.text ?? null;
}

/** A window without a border title: its first row, if entirely highlighted. */
function highlightedRow(snap: ScreenSnapshot, r: Region): string | null {
  const first = chunks(snap, r.top, r.left, r.right);
  return first.length > 0 && first.every((c) => c.white) ? first.map((c) => c.text).join(' ') : null;
}

/** cyrb53: a fast, well-distributed 53-bit string hash (synchronous in any JS runtime). */
function hash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
