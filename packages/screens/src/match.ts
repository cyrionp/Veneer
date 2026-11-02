// Screen identification: a definition matches when the screen id is one of
// its ids (if it lists any) and all its text appears at the stated positions.
// With several matches, the most specific one wins.

import type { ScreenSnapshot } from '@veneer/terminal';
import { screenId } from './fingerprint.ts';
import type { ScreenDefinition, TextMatch } from './types.ts';

export function textMatches(snap: ScreenSnapshot, m: TextMatch): boolean {
  const line = snap.lines[m.row - 1];
  if (line === undefined || m.text.length === 0) return false;
  return line.slice(m.col - 1, m.col - 1 + m.text.length) === m.text;
}

/** `id` can be passed when already computed for this snapshot. */
export function matches(snap: ScreenSnapshot, def: ScreenDefinition, id?: string): boolean {
  const { rows, cols, text, screenIds = [] } = def.match;
  if (screenIds.length === 0 && text.length === 0) return false;
  if (def.host !== undefined && def.host !== snap.host) return false;
  if (rows !== undefined && rows !== snap.rows) return false;
  if (cols !== undefined && cols !== snap.cols) return false;
  if (screenIds.length > 0 && !screenIds.includes(id ?? screenId(snap))) return false;
  return text.every((m) => textMatches(snap, m));
}

/** Specificity: a screen id first, then more text rules, then more matched characters. */
function score(def: ScreenDefinition): number {
  const chars = def.match.text.reduce((n, m) => n + m.text.length, 0);
  return ((def.match.screenIds?.length ?? 0) > 0 ? 1_000_000 : 0) + def.match.text.length * 10_000 + chars;
}

export function matchScreen(snap: ScreenSnapshot, defs: readonly ScreenDefinition[]): ScreenDefinition | undefined {
  const id = screenId(snap);
  let best: ScreenDefinition | undefined;
  for (const def of defs) {
    if (matches(snap, def, id) && (!best || score(def) > score(best))) best = def;
  }
  return best;
}
