// The 5250 display: a character buffer plus the format table (input fields).
// Field data lives in the buffer itself, as on a real 5250 terminal.

import {
  fieldId,
  type Color, type DisplayAttribute, type FieldAdjustName, type FieldShiftName, type FieldSnapshot, type ScreenSnapshot, type Segment,
} from '@veneer/terminal';
import type { Codepage } from './ebcdic.ts';

export interface Field {
  /** Buffer address of the first data position; the attribute is at start - 1. */
  start: number;
  length: number;
  /** Field format word. */
  ffw: number;
  /** Field control words, raw. */
  fcws: number[];
  /** Field attribute byte (0x20-0x3F). */
  attr: number;
}

export const FieldShift = {
  0: 'alpha', 1: 'alphaOnly', 2: 'numericShift', 3: 'numericOnly',
  4: 'katakana', 5: 'digitsOnly', 6: 'io', 7: 'signedNumeric',
} as const satisfies Record<number, FieldShiftName>;

export const FieldAdjust = { 0: 'none', 5: 'zeroFill', 6: 'blankFill', 7: 'mandatoryFill' } as const satisfies Record<number, FieldAdjustName>;

export const FFW = {
  BYPASS: 0x2000,
  DUP_ENABLE: 0x1000,
  MDT: 0x0800,
  AUTO_ENTER: 0x0080,
  FIELD_EXIT_REQUIRED: 0x0040,
  MONOCASE: 0x0020,
  MANDATORY_ENTER: 0x0008,
} as const;

export function fieldShift(f: Field): FieldShiftName {
  return FieldShift[((f.ffw >> 8) & 0x07) as keyof typeof FieldShift];
}

export function fieldAdjust(f: Field): FieldAdjustName {
  return FieldAdjust[(f.ffw & 0x07) as keyof typeof FieldAdjust] ?? 'none';
}

/** Decode a 5250 color-display attribute byte (0x20-0x3F). */
export function decodeAttribute(a: number): DisplayAttribute {
  const group = a & 0x18;
  const hi = (a & 0x02) !== 0;
  const color: Color =
    group === 0x00 ? (hi ? 'white' : 'green')
    : group === 0x08 ? 'red'
    : group === 0x10 ? (hi ? 'yellow' : 'turquoise')
    : hi ? 'blue' : 'pink';
  const nonDisplay = (a & 0x07) === 0x07;
  return {
    color,
    reverse: !nonDisplay && (a & 0x01) !== 0,
    underline: !nonDisplay && (a & 0x04) !== 0,
    blink: group === 0x08 && hi,
    columnSeparator: group === 0x10,
    nonDisplay,
  };
}

export const isAttributeByte = (b: number): boolean => b >= 0x20 && b <= 0x3f;

export class Screen {
  rows = 24;
  cols = 80;
  buffer = new Uint8Array(24 * 80);
  fields: Field[] = [];
  /** Cursor buffer address. */
  cursor = 0;
  keyboardLocked = true;
  messageWaiting = false;
  alarm = false;
  /** 1-based row used by Write Error Code. 0 means the last row. */
  errorRow = 0;
  /** Set while the keyboard is in error state; holds the overwritten row. */
  error: { row: number; saved: Uint8Array } | null = null;

  get size(): number {
    return this.rows * this.cols;
  }

  clear(rows = 24, cols = 80): void {
    this.rows = rows;
    this.cols = cols;
    this.buffer = new Uint8Array(rows * cols);
    this.fields = [];
    this.cursor = 0;
    this.errorRow = 0;
    this.error = null;
    this.keyboardLocked = true;
  }

  clearFormatTable(): void {
    this.fields = [];
  }

  /** Convert 1-based row/col to a buffer address. */
  address(row: number, col: number): number {
    return ((row - 1) * this.cols + (col - 1) + this.size) % this.size;
  }

  rowCol(address: number): { row: number; col: number } {
    return { row: Math.floor(address / this.cols) + 1, col: (address % this.cols) + 1 };
  }

  effectiveErrorRow(): number {
    return this.errorRow >= 1 && this.errorRow <= this.rows ? this.errorRow : this.rows;
  }

  fieldAt(address: number): Field | undefined {
    return this.fields.find((f) => address >= f.start && address < f.start + f.length);
  }

  /** Add a field, replacing one with the same start and dropping any it overlaps. */
  defineField(field: Field): void {
    const end = field.start + field.length;
    this.fields = this.fields.filter(
      (f) => f.start !== field.start && (f.start + f.length <= field.start || f.start >= end),
    );
    this.fields.push(field);
    this.fields.sort((a, b) => a.start - b.start);
  }

  fieldBytes(f: Field): Uint8Array {
    return this.buffer.subarray(f.start, Math.min(f.start + f.length, this.size));
  }

  /** First non-bypass field, where the cursor goes when no IC order was given. */
  firstInputField(): Field | undefined {
    return this.fields.find((f) => (f.ffw & FFW.BYPASS) === 0);
  }
}

export function snapshot(screen: Screen, cp: Codepage): ScreenSnapshot {
  const lines: string[] = [];
  const segments: Segment[][] = [];
  let current = decodeAttribute(0x20);

  for (let r = 0; r < screen.rows; r++) {
    let line = '';
    const rowSegs: Segment[] = [];
    for (let c = 0; c < screen.cols; c++) {
      const b = screen.buffer[r * screen.cols + c]!;
      let ch: string;
      let attr: DisplayAttribute;
      if (isAttributeByte(b)) {
        current = decodeAttribute(b);
        ch = ' ';
        // The attribute position itself displays as a plain blank.
        attr = { ...current, reverse: false, underline: false, columnSeparator: false };
      } else {
        ch = current.nonDisplay ? ' ' : cp.decodeChar(b);
        attr = current;
      }
      line += ch;
      const last = rowSegs.at(-1);
      if (last && sameAttr(last.attr, attr)) last.text += ch;
      else rowSegs.push({ col: c + 1, text: ch, attr });
    }
    lines.push(line);
    segments.push(rowSegs);
  }

  const fields = screen.fields.map((f): FieldSnapshot => {
    const { row, col } = screen.rowCol(f.start);
    const attr = decodeAttribute(f.attr);
    return {
      id: fieldId(row, col),
      row,
      col,
      length: f.length,
      // Never echo non-display (password) contents back out.
      value: attr.nonDisplay ? '' : fieldText(f, screen.fieldBytes(f), cp),
      bypass: (f.ffw & FFW.BYPASS) !== 0,
      modified: (f.ffw & FFW.MDT) !== 0,
      monocase: (f.ffw & FFW.MONOCASE) !== 0,
      mandatoryEnter: (f.ffw & FFW.MANDATORY_ENTER) !== 0,
      autoEnter: (f.ffw & FFW.AUTO_ENTER) !== 0,
      shift: fieldShift(f),
      adjust: fieldAdjust(f),
      attr,
    };
  });

  const error = screen.error ? lines[screen.error.row - 1]!.trim() : null;

  return {
    host: '5250',
    rows: screen.rows,
    cols: screen.cols,
    cursor: screen.rowCol(screen.cursor),
    keyboardLocked: screen.keyboardLocked,
    messageWaiting: screen.messageWaiting,
    error,
    messageRow: screen.effectiveErrorRow(),
    lines,
    segments,
    fields,
  };
}

/** A field's text for display: numeric fields trimmed, negative zoned digits shown as "-". */
function fieldText(f: Field, bytes: Uint8Array, cp: Codepage): string {
  const shift = fieldShift(f);
  if (shift !== 'numericOnly' && shift !== 'signedNumeric') return cp.decode(bytes).replace(/\s+$/, '');
  const copy = Uint8Array.from(bytes);
  let end = copy.length;
  while (end > 0 && (copy[end - 1] === 0x00 || copy[end - 1] === 0x40)) end--;
  const last = copy[end - 1];
  let negative = false;
  if (shift === 'numericOnly' && last !== undefined && (last & 0xf0) === 0xd0 && (last & 0x0f) <= 9) {
    copy[end - 1] = 0xf0 | (last & 0x0f);
    negative = true;
  }
  const text = cp.decode(copy).trim();
  return negative ? `${text}-` : text;
}

function sameAttr(a: DisplayAttribute, b: DisplayAttribute): boolean {
  return a.color === b.color && a.reverse === b.reverse && a.underline === b.underline
    && a.blink === b.blink && a.columnSeparator === b.columnSeparator && a.nonDisplay === b.nonDisplay;
}
