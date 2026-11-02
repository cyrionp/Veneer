// The 3270 display: a character buffer in which field attributes take a
// position each. A field runs from the position after its attribute to the
// next attribute, wrapping from the end of the buffer to the start. A buffer
// with no attributes is unformatted: all of it takes input.

import {
  fieldId,
  type Codepage, type Color, type DisplayAttribute, type FieldSnapshot, type ScreenSnapshot, type Segment,
} from '@veneer/terminal';
import { FA, Highlight, MODELS, Validation } from './constants.ts';

/** What a field attribute position holds: the basic attribute and the extended ones (0 = default). */
export interface FieldAttribute {
  fa: number;
  color: number;
  highlight: number;
  validation: number;
}

export interface Field {
  /** Where the attribute is. */
  attrAddress: number;
  /** First data position (attrAddress + 1, wrapping). */
  start: number;
  length: number;
  attr: FieldAttribute;
}

export const isProtected = (a: FieldAttribute): boolean => (a.fa & FA.PROTECTED) !== 0;
export const isModified = (a: FieldAttribute): boolean => (a.fa & FA.MDT) !== 0;

export class Screen {
  /** The model's alternate size; the default size is always 24x80. */
  readonly alternate: { rows: number; cols: number };
  rows = 24;
  cols = 80;
  /** EBCDIC characters; 0x00 is a null (blank, and never sent to the host). */
  buffer = new Uint8Array(24 * 80);
  /** Field attributes by position; undefined where there is a character. */
  attrs: Array<FieldAttribute | undefined> = new Array(24 * 80);
  /** Character colour and highlighting from Set Attribute (0 = the field's). */
  charColor = new Uint8Array(24 * 80);
  charHighlight = new Uint8Array(24 * 80);
  cursor = 0;
  keyboardLocked = true;
  alarm = false;

  constructor(model = 2) {
    const size = MODELS[model];
    if (!size) throw new RangeError(`3278 model ${model} is not one of 2, 3, 4 or 5`);
    this.alternate = size;
  }

  get size(): number {
    return this.rows * this.cols;
  }

  /** Erase to nulls, unformatted, cursor home, in the default or alternate size. */
  erase(alternate = false): void {
    ({ rows: this.rows, cols: this.cols } = alternate ? this.alternate : { rows: 24, cols: 80 });
    this.buffer = new Uint8Array(this.size);
    this.attrs = new Array(this.size);
    this.charColor = new Uint8Array(this.size);
    this.charHighlight = new Uint8Array(this.size);
    this.cursor = 0;
  }

  /** True when the buffer has at least one field. */
  get formatted(): boolean {
    return this.attrs.some((a) => a !== undefined);
  }

  /** Convert 1-based row/col to a buffer address. */
  address(row: number, col: number): number {
    return ((row - 1) * this.cols + (col - 1) + this.size) % this.size;
  }

  rowCol(address: number): { row: number; col: number } {
    return { row: Math.floor(address / this.cols) + 1, col: (address % this.cols) + 1 };
  }

  next(address: number, by = 1): number {
    return (address + by) % this.size;
  }

  /** Write a character; it replaces any field attribute there. */
  putChar(address: number, byte: number, color = 0, highlight = 0): void {
    this.buffer[address] = byte;
    this.attrs[address] = undefined;
    this.charColor[address] = color;
    this.charHighlight[address] = highlight;
  }

  setAttribute(address: number, attr: FieldAttribute): void {
    this.buffer[address] = 0x00;
    this.attrs[address] = attr;
    this.charColor[address] = 0;
    this.charHighlight[address] = 0;
  }

  /** The attribute position governing an address (itself if it is one), or -1 when unformatted. */
  attributeOf(address: number): number {
    for (let i = 0, a = address; i < this.size; i++, a = (a - 1 + this.size) % this.size) {
      if (this.attrs[a]) return a;
    }
    return -1;
  }

  fields(): Field[] {
    const at: number[] = [];
    this.attrs.forEach((a, i) => { if (a) at.push(i); });
    return at.map((attrAddress, i) => {
      const nextAttr = at[(i + 1) % at.length]!;
      const length = at.length === 1 ? this.size - 1 : (nextAttr - attrAddress - 1 + this.size) % this.size;
      return { attrAddress, start: this.next(attrAddress), length, attr: this.attrs[attrAddress]! };
    }).filter((f) => f.length > 0);
  }

  fieldAt(address: number): Field | undefined {
    const a = this.attributeOf(address);
    if (a < 0 || a === address) return undefined;
    return this.fields().find((f) => f.attrAddress === a);
  }

  /** A field's data positions, in order (they may wrap). */
  positions(f: Field): number[] {
    return Array.from({ length: f.length }, (_, i) => this.next(f.start, i));
  }

  /** The first data position of the next unprotected field after an address, or -1. */
  nextUnprotected(address: number): number {
    for (let i = 1, a = this.next(address); i <= this.size; i++, a = this.next(a)) {
      const attr = this.attrs[a];
      if (attr && !isProtected(attr) && !this.attrs[this.next(a)]) return this.next(a);
    }
    return -1;
  }

  /** Where the cursor goes with no other instruction: the first input field, or home. */
  firstUnprotected(): number {
    const a = this.nextUnprotected(this.size - 1);
    return a < 0 ? 0 : a;
  }
}

const COLORS: Record<number, Color> = {
  0xf1: 'blue', 0xf2: 'red', 0xf3: 'pink', 0xf4: 'green', 0xf5: 'turquoise', 0xf6: 'yellow', 0xf7: 'white',
};

/**
 * How a position looks. With no extended colour the 3279 base colours apply:
 * input fields green (red when intensified), protected text blue (white).
 */
export function displayAttribute(field: FieldAttribute | undefined, charColor = 0, charHighlight = 0): DisplayAttribute {
  const fa = field?.fa ?? 0;
  const highlight = charHighlight || field?.highlight || Highlight.DEFAULT;
  const intensified = (fa & FA.DISPLAY) === FA.INTENSIFIED || highlight === Highlight.INTENSIFY;
  const base: Color = !field ? 'green'
    : (fa & FA.PROTECTED) ? (intensified ? 'white' : 'blue')
    : intensified ? 'red' : 'green';
  const nonDisplay = field !== undefined && (fa & FA.DISPLAY) === FA.NONDISPLAY;
  return {
    color: COLORS[charColor || field?.color || 0] ?? base,
    reverse: !nonDisplay && highlight === Highlight.REVERSE,
    underline: !nonDisplay && highlight === Highlight.UNDERSCORE,
    blink: !nonDisplay && highlight === Highlight.BLINK,
    columnSeparator: false,
    nonDisplay,
  };
}

export function snapshot(screen: Screen, cp: Codepage): ScreenSnapshot {
  const lines: string[] = [];
  const segments: Segment[][] = [];
  // Start with the attribute that governs position 0 (the last one, wrapping).
  const first = screen.attributeOf(0);
  let current = first >= 0 ? screen.attrs[first] : undefined;

  for (let r = 0; r < screen.rows; r++) {
    let line = '';
    const rowSegs: Segment[] = [];
    for (let c = 0; c < screen.cols; c++) {
      const a = r * screen.cols + c;
      let ch: string;
      let attr: DisplayAttribute;
      const fa = screen.attrs[a];
      if (fa) {
        current = fa;
        ch = ' ';
        // The attribute position itself displays as a plain blank.
        attr = { ...displayAttribute(fa), reverse: false, underline: false, blink: false };
      } else {
        attr = displayAttribute(current, screen.charColor[a], screen.charHighlight[a]);
        ch = attr.nonDisplay ? ' ' : cp.decodeChar(screen.buffer[a]!);
      }
      line += ch;
      const last = rowSegs.at(-1);
      if (last && sameAttr(last.attr, attr)) last.text += ch;
      else rowSegs.push({ col: c + 1, text: ch, attr });
    }
    lines.push(line);
    segments.push(rowSegs);
  }

  const fields = screen.fields().map((f): FieldSnapshot => {
    const { row, col } = screen.rowCol(f.start);
    const attr = displayAttribute(f.attr);
    const protect = isProtected(f.attr);
    const snap: FieldSnapshot = {
      id: fieldId(row, col),
      row,
      col,
      length: f.length,
      // Never echo non-display (password) contents back out.
      value: attr.nonDisplay ? '' : cp.decode(screen.positions(f).map((p) => screen.buffer[p]!)).replace(/\s+$/, ''),
      bypass: protect,
      modified: isModified(f.attr),
      mandatoryEnter: (f.attr.validation & Validation.MANDATORY_ENTRY) !== 0,
      attr,
    };
    if (!protect && (f.attr.fa & FA.NUMERIC)) snap.numeric = true;
    if (f.attr.validation & Validation.MANDATORY_FILL) snap.adjust = 'mandatoryFill';
    return snap;
  });

  return {
    host: '3270',
    rows: screen.rows,
    cols: screen.cols,
    cursor: screen.rowCol(screen.cursor),
    keyboardLocked: screen.keyboardLocked,
    messageWaiting: false,
    error: null,
    lines,
    segments,
    fields,
  };
}

function sameAttr(a: DisplayAttribute, b: DisplayAttribute): boolean {
  return a.color === b.color && a.reverse === b.reverse && a.underline === b.underline
    && a.blink === b.blink && a.columnSeparator === b.columnSeparator && a.nonDisplay === b.nonDisplay;
}
