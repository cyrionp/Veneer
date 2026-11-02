// Builds host-side (outbound) 5250 data streams. Used by tests and the demo
// host to create realistic screens without an IBM i.

import { Command, ESC, Order } from './constants.ts';
import { getCodepage, type Codepage } from '@veneer/terminal';

export const Attr = {
  GREEN: 0x20, GREEN_REVERSE: 0x21, WHITE: 0x22, GREEN_UNDERLINE: 0x24,
  NONDISPLAY: 0x27, RED: 0x28, TURQUOISE: 0x30, YELLOW: 0x32, PINK: 0x38, BLUE: 0x3a,
} as const;

export interface FieldOptions {
  /** Field format word; default 0x4000 (alphanumeric input). */
  ffw?: number;
  attr?: number;
  value?: string;
}

export class HostStream {
  private readonly out: number[] = [];
  private readonly cp: Codepage;

  constructor(ccsid = 37) {
    this.cp = getCodepage(ccsid);
  }

  clear(): this {
    this.out.push(ESC, Command.CLEAR_UNIT);
    return this;
  }

  /** Start a Write To Display command; `unlock` unlocks the keyboard at the end. */
  write({ unlock = true }: { unlock?: boolean } = {}): this {
    this.out.push(ESC, Command.WRITE_TO_DISPLAY, 0x00, unlock ? 0x08 : 0x00);
    return this;
  }

  /** Text at a 1-based position, preceded by its attribute (in column col - 1). */
  text(row: number, col: number, text: string, attr: number = Attr.GREEN): this {
    if (col < 2) throw new RangeError('text() needs col >= 2 to place its attribute');
    this.out.push(Order.SBA, row, col - 1, attr, ...this.cp.encode(text), Attr.GREEN);
    return this;
  }

  /** An input field whose first data position is row/col. */
  field(row: number, col: number, length: number, opts: FieldOptions = {}): this {
    const ffw = opts.ffw ?? 0x4000;
    this.out.push(Order.SBA, row, col - 1, Order.SF, ffw >> 8, ffw & 0xff, opts.attr ?? Attr.GREEN_UNDERLINE, length >> 8, length & 0xff);
    if (opts.value) this.out.push(...this.cp.encode(opts.value.slice(0, length)));
    this.out.push(Order.SBA, row, col + length, Attr.GREEN);
    return this;
  }

  /** Overwrite a run of cells with one character (blanks by default), e.g. to clear a window's interior. */
  fill(row: number, col: number, length: number, char = ' '): this {
    this.out.push(Order.SBA, row, col, ...this.cp.encode(char.repeat(length)));
    return this;
  }

  cursor(row: number, col: number): this {
    this.out.push(Order.IC, row, col);
    return this;
  }

  readMdt(): this {
    this.out.push(ESC, Command.READ_MDT_FIELDS, 0x00, 0x00);
    return this;
  }

  errorMessage(text: string): this {
    this.out.push(ESC, Command.WRITE_ERROR_CODE, Attr.RED, ...this.cp.encode(text), Attr.GREEN);
    return this;
  }

  build(): number[] {
    return [...this.out];
  }
}
