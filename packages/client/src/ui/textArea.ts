// The text area widget: several input fields (comment lines 1-4, say) edited
// as one box. Each field is one line of the box. Text that runs past a line's
// field moves to the next line at a space (or at the field's end, if a word is
// longer than the field), pushing that line's text along; Enter starts the next
// line. An edit that would push text past the last field is refused, so
// nothing typed is ever lost.

import type { FieldSnapshot } from '@veneer/terminal';
import { acceptsChar } from './fieldRules.ts';

/** What the box needs of each field. */
export type Part = Pick<FieldSnapshot, 'length' | 'monocase' | 'shift'>;

export interface Fitted {
  /** One value per field, in order. */
  values: string[];
  /** The caret, as an index into the box's text. */
  caret: number;
}

/**
 * The box's text: one line per field. Host values come without the blanks
 * that pad a field out; a space the user types at the end of a line is kept.
 */
export function textOf(values: readonly string[]): string {
  return values.join('\n');
}

/** Characters still free across all the fields. */
export function roomLeft(values: readonly string[], parts: readonly Part[]): number {
  return parts.reduce((room, p, i) => room - Math.min(p.length, (values[i] ?? '').length), parts.reduce((n, p) => n + p.length, 0));
}

/** A text index as a line and column. */
export function lineAt(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, Math.max(0, index)).split('\n');
  return { line: before.length - 1, col: before[before.length - 1]!.length };
}

/** A line and column as a text index (the end of the text if the line is past it). */
export function indexAt(text: string, line: number, col: number): number {
  const lines = text.split('\n');
  if (line >= lines.length) return text.length;
  let index = 0;
  for (let i = 0; i < line; i++) index += lines[i]!.length + 1;
  return index + Math.min(col, lines[line]!.length);
}

/**
 * Fit the box's text, as the user left it, into the fields: apply each field's
 * rules (upper case, the characters it takes), wrap long lines into the next,
 * and say where the caret ends up. Null when it doesn't fit.
 */
export function fitText(text: string, caretIndex: number, parts: readonly Part[]): Fitted | null {
  const n = parts.length;
  if (n === 0) return null;
  const lines = text.split('\n');
  const caret = lineAt(text, caretIndex);
  // Enter pushes the lines below down: an empty last line can drop off the end.
  while (lines.length > n && lines[lines.length - 1] === '' && caret.line < lines.length - 1) lines.pop();
  if (lines.length > n) return null;

  for (let i = 0; i < lines.length; i++) {
    const part = parts[i]!;
    let line = part.monocase ? lines[i]!.toUpperCase() : lines[i]!;
    // Characters the field doesn't take are dropped, as when typing into it.
    let kept = '';
    for (let k = 0; k < line.length; k++) {
      if (acceptsChar(part as FieldSnapshot, line[k]!)) kept += line[k];
      else if (caret.line === i && k < caret.col) caret.col--;
    }
    line = kept;
    lines[i] = line;
    if (line.length <= part.length) continue;
    if (i === n - 1) return null;

    // Wrap at the last space that leaves the line short enough, else mid-word.
    const space = line.slice(0, part.length + 1).lastIndexOf(' ');
    const [head, tail] = space > 0 ? [line.slice(0, space), line.slice(space + 1)] : [line.slice(0, part.length), line.slice(part.length)];
    const next = lines[i + 1];
    const sep = next ? ' ' : '';
    if (caret.line === i + 1) caret.col += tail.length + sep.length;
    if (caret.line === i && caret.col > head.length) {
      caret.line = i + 1;
      caret.col = Math.max(0, caret.col - (line.length - tail.length));
    }
    lines[i] = head;
    if (next === undefined) lines.push(tail);
    else lines[i + 1] = tail + sep + next;
  }

  const values = parts.map((_p, i) => lines[i] ?? '');
  const fitted = values.join('\n');
  return { values, caret: indexAt(fitted, caret.line, caret.col) };
}

/** The field (by its place in the box) and the offset in it, for a text index. */
export function partAt(text: string, index: number, parts: readonly Part[]): { part: number; offset: number } {
  const { line, col } = lineAt(text, index);
  const part = Math.min(line, parts.length - 1);
  return { part, offset: Math.min(col, Math.max(0, parts[part]!.length - 1)) };
}
