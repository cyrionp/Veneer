// Finds pop-up windows drawn with character borders. IBM i draws DDS and
// UIM windows this way for displays without enhanced UI support:
//
//    ........ Title .........      top: '.' fill, optional title
//    :                      :      sides: ':'
//    :......................:      bottom: ':' corners, '.' fill
//
// DDS WDWBORDER can choose other characters and colors, so any rectangle
// works: corners and a repeated fill on the top and bottom rows, and the same
// character down each side. A border of blanks in reverse image counts too.

import type { ScreenSnapshot } from '@veneer/terminal';

/** A rectangle of the screen, 1-based and inclusive. */
export interface Region {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface WindowBox {
  /** The border, 1-based and inclusive. */
  outer: Region;
  title?: string;
}

/** Fill characters needed along the bottom edge. */
const MIN_FILL = 6;
/** Fill characters needed at each end of a top edge with a title in it. */
const MIN_TITLE_FILL = 2;

/** What a cell can contribute to a border; cells with equal keys can form one edge. */
type Key = string | null;

export function findWindows(snap: ScreenSnapshot): WindowBox[] {
  const keys = borderKeys(snap);
  const key = (row: number, col: number): Key => keys[row - 1]?.[col - 1] ?? null;
  const boxes: WindowBox[] = [];
  for (let bottom = 3; bottom <= snap.rows; bottom++) {
    for (const [left, right] of bottomEdges(keys[bottom - 1]!)) {
      const box = walkUp(snap, key, bottom, left, right);
      if (box) boxes.push(box);
    }
  }
  return boxes;
}

/**
 * Per cell: the character if it is a symbol (not a letter, digit or blank);
 * for a blank in reverse image outside input fields, its color; else null.
 */
function borderKeys(snap: ScreenSnapshot): Key[][] {
  const inField = new Set<number>();
  for (const f of snap.fields) {
    const start = (f.row - 1) * snap.cols + f.col - 1;
    for (let i = 0; i < f.length; i++) inField.add(start + i);
  }
  return snap.lines.map((line, r) => {
    const row: Key[] = [...line].map((ch) => (isSymbol(ch) ? ch : null));
    for (const seg of snap.segments[r] ?? []) {
      if (!seg.attr.reverse) continue;
      for (let i = 0; i < seg.text.length; i++) {
        const c = seg.col - 1 + i;
        if (seg.text[i] === ' ' && !inField.has(r * snap.cols + c)) row[c] = `reverse ${seg.attr.color}`;
      }
    }
    return row;
  });
}

function isSymbol(ch: string): boolean {
  return ch.trim() !== '' && !/[\p{L}\p{N}]/u.test(ch);
}

/**
 * Candidate bottom edges on a row, as [left, right] columns: a run of one fill
 * key between two corners. Corners may be the fill itself (a box of '*').
 */
function bottomEdges(row: Key[]): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  let start = 0;
  while (start < row.length) {
    const fill = row[start];
    let end = start;
    while (end + 1 < row.length && row[end + 1] === fill) end++;
    if (fill !== null) {
      // 0-based run [start, end]; corners just outside it, or its own ends.
      if (end - start + 1 >= MIN_FILL && row[start - 1] && row[end + 1]) edges.push([start, end + 2]);
      if (end - start - 1 >= MIN_FILL) edges.push([start + 1, end + 1]);
    }
    start = end + 1;
  }
  return edges.filter(([l, r]) => isolated(row, l, r, row[l]!));
}

/**
 * An edge must not run on past its corners: in "+-----+-----+" each cell is
 * part of a table, not a window.
 */
function isolated(row: Key[], left: number, right: number, fill: string): boolean {
  return row[left - 2] !== fill && row[right] !== fill;
}

function walkUp(snap: ScreenSnapshot, key: (row: number, col: number) => Key, bottom: number, left: number, right: number): WindowBox | undefined {
  const side = { left: key(bottom - 1, left), right: key(bottom - 1, right) };
  if (!side.left || !side.right) return undefined;
  for (let row = bottom - 1; row >= 1; row--) {
    if (bottom - row >= 2) {
      const top = topEdge(snap, key, row, left, right);
      if (top) return { outer: { top: row, left, bottom, right }, ...(top.title ? { title: top.title } : {}) };
    }
    if (key(row, left) !== side.left || key(row, right) !== side.right) return undefined;
  }
  return undefined;
}

/** A top edge: corners, then fill at both ends with an optional title between. */
function topEdge(snap: ScreenSnapshot, key: (row: number, col: number) => Key, row: number, left: number, right: number): { title?: string } | undefined {
  if (!key(row, left) || !key(row, right)) return undefined;
  const fill = key(row, left + 1);
  if (!fill || key(row, left - 1) === fill || key(row, right + 1) === fill) return undefined;
  let a = left + 1;
  while (a < right && key(row, a) === fill) a++;
  if (a === right) return {};
  let b = right - 1;
  while (key(row, b) === fill) b--;
  if (a - left - 1 < MIN_TITLE_FILL || right - 1 - b < MIN_TITLE_FILL) return undefined;
  const title = snap.lines[row - 1]!.slice(a - 1, b).trim();
  // Text, not more border: "+---+---+" has no title.
  return /[\p{L}\p{N}]/u.test(title) ? { title } : undefined;
}

/** The window the user is working in: the one holding the cursor, else the last found. */
export function activeWindow(snap: ScreenSnapshot, boxes: WindowBox[]): WindowBox | undefined {
  const { row, col } = snap.cursor;
  const inside = boxes.filter(({ outer: o }) => row > o.top && row < o.bottom && col > o.left && col < o.right);
  const pool = inside.length > 0 ? inside : boxes;
  // Prefer the innermost (smallest) window.
  return [...pool].sort((x, y) => area(x.outer) - area(y.outer))[0];
}

function area(r: Region): number {
  return (r.bottom - r.top + 1) * (r.right - r.left + 1);
}
