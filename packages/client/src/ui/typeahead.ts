// Type-ahead: keystrokes typed while the host is busy are queued and replayed
// into the next screen, as a 5250 terminal does. Replay is a pure function so
// it can be tested without a browser.

import type { AidName, FieldSnapshot, ScreenSnapshot } from '@veneer/terminal';
import { acceptsChar } from './fieldRules.ts';

export type TypedKey =
  | { kind: 'char'; ch: string }
  | { kind: 'backspace' }
  | { kind: 'tab'; back: boolean }
  | { kind: 'aid'; aid: AidName };

/** Cap on queued keys, so a stuck host cannot grow the queue without bound. */
export const MAX_TYPEAHEAD = 256;

export interface Caret {
  id: string;
  /** Character offset within the field. */
  offset: number;
}

export interface ReplayState {
  edits: Record<string, string>;
  caret: Caret | null;
}

export interface ReplayResult {
  state: ReplayState;
  /** An AID key reached in the queue; the caller should submit it. */
  aid?: AidName;
  /** Keys after that AID, for the following screen. */
  rest: TypedKey[];
}

export function inputFields(snap: ScreenSnapshot): FieldSnapshot[] {
  return snap.fields.filter((f) => !f.bypass);
}

/** The field and offset under the host cursor, else the first input field. */
export function caretAtCursor(snap: ScreenSnapshot): Caret | null {
  const addr = (snap.cursor.row - 1) * snap.cols + (snap.cursor.col - 1);
  const inputs = inputFields(snap);
  for (const f of inputs) {
    const start = (f.row - 1) * snap.cols + (f.col - 1);
    if (addr >= start && addr < start + f.length) return { id: f.id, offset: addr - start };
  }
  return inputs[0] ? { id: inputs[0].id, offset: 0 } : null;
}

export function replay(snap: ScreenSnapshot, initial: ReplayState, keys: readonly TypedKey[]): ReplayResult {
  const inputs = inputFields(snap);
  const edits = { ...initial.edits };
  let caret = initial.caret;
  const valueOf = (f: FieldSnapshot) => edits[f.id] ?? f.value;
  const move = (delta: number) => {
    if (inputs.length === 0) return;
    const i = caret ? inputs.findIndex((f) => f.id === caret!.id) : -1;
    const next = inputs[(i + delta + inputs.length) % inputs.length]!;
    caret = { id: next.id, offset: 0 };
  };

  for (let k = 0; k < keys.length; k++) {
    const key = keys[k]!;
    if (key.kind === 'aid') return { state: { edits, caret }, aid: key.aid, rest: keys.slice(k + 1) };
    if (key.kind === 'tab') { move(key.back ? -1 : 1); continue; }
    const field = caret && inputs.find((f) => f.id === caret!.id);
    if (!field || !caret) continue;
    const value = valueOf(field);
    if (key.kind === 'backspace') {
      if (caret.offset > 0) {
        edits[field.id] = value.slice(0, caret.offset - 1) + value.slice(caret.offset);
        caret = { id: field.id, offset: caret.offset - 1 };
      }
      continue;
    }
    const ch = field.monocase ? key.ch.toUpperCase() : key.ch;
    if (!acceptsChar(field, ch)) continue;
    const offset = Math.min(caret.offset, value.length);
    // Insert while there is room; once the field is full, overwrite as a 5250 does.
    edits[field.id] = value.length < field.length
      ? value.slice(0, offset) + ch + value.slice(offset)
      : value.slice(0, offset) + ch + value.slice(offset + 1);
    caret = { id: field.id, offset: offset + 1 };
    if (caret.offset >= field.length) {
      if (field.autoEnter) return { state: { edits, caret }, aid: 'Enter', rest: keys.slice(k + 1) };
      move(1);
    }
  }
  return { state: { edits, caret }, rest: [] };
}

/** Screen position of a caret, for reporting the cursor to the host. */
export function caretPosition(snap: ScreenSnapshot, caret: Caret): { row: number; col: number } | null {
  const f = snap.fields.find((x) => x.id === caret.id);
  if (!f) return null;
  const offset = f.col - 1 + Math.min(caret.offset, f.length - 1);
  return { row: f.row + Math.floor(offset / snap.cols), col: (offset % snap.cols) + 1 };
}
