// The screen model every host type produces, and everything outside the host
// packages works with: a grid of text with display attributes, input fields
// identified by "row:col", the cursor and the keyboard state.

/** The kinds of host Veneer can talk to. */
export type HostType = '5250' | '3270';

export type Color = 'green' | 'white' | 'red' | 'turquoise' | 'yellow' | 'pink' | 'blue';

export interface DisplayAttribute {
  color: Color;
  reverse: boolean;
  underline: boolean;
  blink: boolean;
  /** 5250 column separators; always false on a 3270. */
  columnSeparator: boolean;
  nonDisplay: boolean;
}

export interface Segment {
  /** 1-based starting column. */
  col: number;
  text: string;
  attr: DisplayAttribute;
}

/** The 5250 field shifts (what a field accepts). */
export type FieldShiftName =
  | 'alpha' | 'alphaOnly' | 'numericShift' | 'numericOnly' | 'katakana' | 'digitsOnly' | 'io' | 'signedNumeric';

/** The 5250 field adjustments, including mandatory fill. */
export type FieldAdjustName = 'none' | 'zeroFill' | 'blankFill' | 'mandatoryFill';

export interface FieldSnapshot {
  /** Stable id: "row:col" of the first data position (1-based). */
  id: string;
  row: number;
  col: number;
  length: number;
  value: string;
  /** Protected: the user can't type in it. */
  bypass: boolean;
  modified: boolean;
  /** The field must be changed before Enter is accepted. */
  mandatoryEnter: boolean;
  attr: DisplayAttribute;

  // Rules only some host types have. Code that reads them must allow for
  // them being absent.

  /** What the field accepts (5250). */
  shift?: FieldShiftName;
  /** The field takes numbers only (3270 numeric attribute: digits, sign and decimal point). */
  numeric?: boolean;
  /** How the field is filled on exit, or mandatory fill (5250). */
  adjust?: FieldAdjustName;
  /** Typed letters become upper case (5250). */
  monocase?: boolean;
  /** Submit Enter automatically when the field is filled (5250). */
  autoEnter?: boolean;
}

export interface ScreenSnapshot {
  /** The kind of host the screen came from. */
  host: HostType;
  rows: number;
  cols: number;
  cursor: { row: number; col: number };
  keyboardLocked: boolean;
  messageWaiting: boolean;
  /** What the host reported as an error while input is held (the 5250 error line), or null. */
  error: string | null;
  /** 1-based row where the host writes messages (normally the last row), on hosts that have one. */
  messageRow?: number;
  /** Plain text of each row, with non-display data blanked. */
  lines: string[];
  segments: Segment[][];
  fields: FieldSnapshot[];
}

export const fieldId = (row: number, col: number): string => `${row}:${col}`;
