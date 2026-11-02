// Builds host-side (outbound) 3270 data streams. Used by tests and the 3270
// demo host to create realistic screens without a mainframe.

import { getCodepage, type Codepage } from '@veneer/terminal';
import { decodeAddress, encodeAddress } from './address.ts';
import { FA, Highlight, Order, Validation, WCC, XA } from './constants.ts';

/** Field attribute bytes for common kinds of field (SF order values). */
export const Attr = {
  /** Protected text. */
  TEXT: FA.PROTECTED,
  /** Protected, intensified text (titles). */
  BRIGHT: FA.PROTECTED | FA.INTENSIFIED,
  /** Input. */
  INPUT: 0x00,
  NUMERIC: FA.NUMERIC,
  /** Input that is not shown (passwords). */
  HIDDEN: FA.NONDISPLAY,
  /** Protected and numeric: the cursor skips it. */
  SKIP: FA.PROTECTED | FA.NUMERIC,
} as const;

/** Extended colour values. */
export const Color = { BLUE: 0xf1, RED: 0xf2, PINK: 0xf3, GREEN: 0xf4, TURQUOISE: 0xf5, YELLOW: 0xf6, WHITE: 0xf7 } as const;

export interface FieldOptions {
  attr?: number;
  color?: number;
  highlight?: number;
  mandatoryEntry?: boolean;
  mandatoryFill?: boolean;
  value?: string;
  /** Sent with the MDT on, as if already changed. */
  modified?: boolean;
}

export class HostStream {
  private readonly out: number[] = [];
  private readonly cp: Codepage;
  private rows = 24;
  private cols = 80;

  constructor(ccsid = 37) {
    this.cp = getCodepage(ccsid);
  }

  /** Erase/Write (default 24x80) or, with a size, Erase/Write Alternate. */
  eraseWrite({ restore = true, resetMdt = false, alarm = false, alternate }: { restore?: boolean; resetMdt?: boolean; alarm?: boolean; alternate?: { rows: number; cols: number } } = {}): this {
    if (alternate) ({ rows: this.rows, cols: this.cols } = alternate);
    else [this.rows, this.cols] = [24, 80];
    this.out.push(alternate ? 0x7e : 0xf5, wcc(restore, resetMdt, alarm));
    return this;
  }

  /** Write (no erase), starting at the cursor. */
  write({ restore = true, resetMdt = false, alarm = false }: { restore?: boolean; resetMdt?: boolean; alarm?: boolean } = {}): this {
    this.out.push(0xf1, wcc(restore, resetMdt, alarm));
    return this;
  }

  /** Erase All Unprotected. */
  eraseUnprotected(): this {
    this.out.push(0x6f);
    return this;
  }

  /** Set Buffer Address to a 1-based position. */
  at(row: number, col: number): this {
    this.out.push(Order.SBA, ...encodeAddress(this.addr(row, col), this.rows * this.cols));
    return this;
  }

  /** Protected text at a 1-based position: its attribute goes in the position before. */
  text(row: number, col: number, text: string, opts: Omit<FieldOptions, 'value'> = {}): this {
    this.at(row, col).back().field({ attr: Attr.TEXT, ...opts });
    this.out.push(...this.cp.encode(text));
    return this;
  }

  /** An input field whose first data position is row/col, ended by a protected attribute. */
  input(row: number, col: number, length: number, opts: FieldOptions = {}): this {
    this.at(row, col).back().field({ attr: Attr.INPUT, ...opts });
    if (opts.value) this.out.push(...this.cp.encode(opts.value.slice(0, length)));
    this.at(row, col).step(length).field({ attr: Attr.SKIP });
    return this;
  }

  /** A field attribute at the current address: SF, or SFE when it has extended attributes. */
  field(opts: Omit<FieldOptions, 'value'>): this {
    const fa = (opts.attr ?? Attr.INPUT) | (opts.modified ? FA.MDT : 0);
    const validation = (opts.mandatoryEntry ? Validation.MANDATORY_ENTRY : 0) | (opts.mandatoryFill ? Validation.MANDATORY_FILL : 0);
    const pairs: number[] = [];
    if (opts.color) pairs.push(XA.FOREGROUND, opts.color);
    if (opts.highlight) pairs.push(XA.HIGHLIGHT, opts.highlight);
    if (validation) pairs.push(XA.VALIDATION, validation);
    if (pairs.length === 0) this.out.push(Order.SF, fa);
    else this.out.push(Order.SFE, pairs.length / 2 + 1, XA.FIELD, fa, ...pairs);
    return this;
  }

  /** Characters at the current address. */
  chars(text: string): this {
    this.out.push(...this.cp.encode(text));
    return this;
  }

  /** Set Attribute for the characters that follow (0 resets). */
  charAttr(type: 'color' | 'highlight' | 'reset', value = 0): this {
    this.out.push(Order.SA, type === 'color' ? XA.FOREGROUND : type === 'highlight' ? XA.HIGHLIGHT : XA.ALL, value);
    return this;
  }

  /** Insert Cursor at a 1-based position. */
  cursor(row: number, col: number): this {
    this.at(row, col);
    this.out.push(Order.IC);
    return this;
  }

  /** Repeat a character up to (not including) a 1-based position. */
  repeat(char: string, toRow: number, toCol: number): this {
    this.out.push(Order.RA, ...encodeAddress(this.addr(toRow, toCol), this.rows * this.cols), ...this.cp.encode(char));
    return this;
  }

  /** Raw bytes, for orders this builder has no method for. */
  bytes(...b: number[]): this {
    this.out.push(...b);
    return this;
  }

  build(): number[] {
    return [...this.out];
  }

  private addr(row: number, col: number): number {
    return (row - 1) * this.cols + (col - 1);
  }

  /** Move the SBA just pushed back one position, to put an attribute before a position. */
  private back(): this { return this.step(-1); }

  /** Move the SBA just pushed by some positions. */
  private step(by: number): this {
    const n = this.out.length;
    const size = this.rows * this.cols;
    const current = decodeAddress(this.out[n - 2]!, this.out[n - 1]!);
    const [b1, b2] = encodeAddress((current + by + size) % size, size);
    this.out[n - 2] = b1;
    this.out[n - 1] = b2;
    return this;
  }
}

function wcc(restore: boolean, resetMdt: boolean, alarm: boolean): number {
  return (restore ? WCC.RESTORE : 0) | (resetMdt ? WCC.RESET_MDT : 0) | (alarm ? WCC.ALARM : 0);
}

export { Highlight };
