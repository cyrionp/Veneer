// 5250 and Telnet protocol constants (RFC 854, 1205, 2877, 4777 and the
// IBM 5250 Functions Reference).

import type { AidName } from '@veneer/terminal';

export const Telnet = {
  IAC: 0xff,
  DONT: 0xfe,
  DO: 0xfd,
  WONT: 0xfc,
  WILL: 0xfb,
  SB: 0xfa,
  SE: 0xf0,
  EOR: 0xef,
} as const;

export const TelnetOption = {
  BINARY: 0x00,
  TERMINAL_TYPE: 0x18,
  EOR: 0x19,
  NEW_ENVIRON: 0x27,
} as const;

/** Sub-negotiation codes shared by TERMINAL-TYPE and NEW-ENVIRON. */
export const Sub = {
  IS: 0x00,
  SEND: 0x01,
  INFO: 0x02,
  VAR: 0x00,
  VALUE: 0x01,
  ESC: 0x02,
  USERVAR: 0x03,
} as const;

/** GDS record type for 5250 display data. */
export const RECORD_TYPE_DISPLAY = 0x12a0;

/** Flags in the first flag byte of the 5250 record header. */
export const HeaderFlag = {
  ERR: 0x80,
  ATN: 0x40,
  SRQ: 0x04,
  TRQ: 0x02,
  HLP: 0x01,
} as const;

export const Opcode = {
  NO_OP: 0x00,
  INVITE: 0x01,
  OUTPUT_ONLY: 0x02,
  PUT_GET: 0x03,
  SAVE_SCREEN: 0x04,
  RESTORE_SCREEN: 0x05,
  READ_IMMEDIATE: 0x06,
  READ_SCREEN: 0x08,
  CANCEL_INVITE: 0x0a,
  MESSAGE_LIGHT_ON: 0x0b,
  MESSAGE_LIGHT_OFF: 0x0c,
} as const;

/** Every 5250 command is preceded by this escape byte. */
export const ESC = 0x04;

export const Command = {
  WRITE_ERROR_CODE: 0x21,
  WRITE_ERROR_CODE_WINDOW: 0x22,
  WRITE_TO_DISPLAY: 0x11,
  CLEAR_UNIT: 0x40,
  CLEAR_UNIT_ALTERNATE: 0x20,
  CLEAR_FORMAT_TABLE: 0x50,
  READ_INPUT_FIELDS: 0x42,
  READ_MDT_FIELDS: 0x52,
  READ_MDT_FIELDS_ALT: 0x82,
  READ_SCREEN_IMMEDIATE: 0x62,
  READ_IMMEDIATE: 0x72,
  SAVE_SCREEN: 0x02,
  SAVE_PARTIAL_SCREEN: 0x03,
  RESTORE_SCREEN: 0x12,
  RESTORE_PARTIAL_SCREEN: 0x13,
  ROLL: 0x23,
  WRITE_STRUCTURED_FIELD: 0xf3,
  WRITE_SINGLE_STRUCTURED_FIELD: 0xf4,
} as const;

/** Orders that may appear inside Write To Display data. */
export const Order = {
  SOH: 0x01,
  RA: 0x02,
  EA: 0x03,
  TD: 0x10,
  SBA: 0x11,
  WEA: 0x12,
  IC: 0x13,
  MC: 0x14,
  WDSF: 0x15,
  SF: 0x1d,
} as const;

/** Attention identifier bytes sent with an inbound record. */
export const Aid = {
  ENTER: 0xf1,
  HELP: 0xf3,
  ROLL_DOWN: 0xf4, // Page Up
  ROLL_UP: 0xf5, // Page Down
  PRINT: 0xf6,
  RECORD_BACKSPACE: 0xf8,
  CLEAR: 0xbd,
  INBOUND_WSF: 0x88,
} as const;

export function aidByte(name: AidName): number {
  switch (name) {
    case 'Enter': return Aid.ENTER;
    case 'Help': return Aid.HELP;
    case 'PageUp': return Aid.ROLL_DOWN;
    case 'PageDown': return Aid.ROLL_UP;
    case 'Print': return Aid.PRINT;
    case 'Clear': return Aid.CLEAR;
    case 'RecordBackspace': return Aid.RECORD_BACKSPACE;
  }
  const n = Number(name.slice(1));
  if (!Number.isInteger(n) || n < 1 || n > 24) throw new Error(`Unknown AID ${name}`);
  return n <= 12 ? 0x30 + n : 0xb0 + (n - 12);
}

/** AIDs that send only cursor + AID, never field data. */
export const AIDS_WITHOUT_DATA: ReadonlySet<number> = new Set([
  Aid.HELP, Aid.PRINT, Aid.CLEAR, Aid.RECORD_BACKSPACE,
]);
