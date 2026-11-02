// Telnet, TN3270E and 3270 data stream constants (RFC 854, 1576, 1646, 2355
// and the IBM 3270 Data Stream Programmer's Reference, GA23-0059).

export const Telnet = {
  IAC: 0xff, DONT: 0xfe, DO: 0xfd, WONT: 0xfc, WILL: 0xfb, SB: 0xfa,
  /** Interrupt Process: the 3270 Attention key. */
  IP: 0xf4,
  SE: 0xf0, EOR: 0xef,
} as const;

export const TelnetOption = { BINARY: 0x00, TERMINAL_TYPE: 0x18, EOR: 0x19, TN3270E: 0x28 } as const;

/** TERMINAL-TYPE subnegotiation verbs. */
export const TType = { IS: 0x00, SEND: 0x01 } as const;

/** TN3270E subnegotiation words (RFC 2355 section 8). */
export const E = {
  ASSOCIATE: 0x00, CONNECT: 0x01, DEVICE_TYPE: 0x02, FUNCTIONS: 0x03, IS: 0x04,
  REASON: 0x05, REJECT: 0x06, REQUEST: 0x07, SEND: 0x08,
} as const;

/** Why the server refused a DEVICE-TYPE REQUEST. */
export const RejectReason = {
  CONN_PARTNER: 0x00, DEVICE_IN_USE: 0x01, INV_ASSOCIATE: 0x02, INV_NAME: 0x03,
  INV_DEVICE_TYPE: 0x04, TYPE_NAME_ERROR: 0x05, UNKNOWN_ERROR: 0x06, UNSUPPORTED_REQ: 0x07,
} as const;

/** TN3270E functions. */
export const Func = { BIND_IMAGE: 0x00, DATA_STREAM_CTL: 0x01, RESPONSES: 0x02, SCS_CTL_CODES: 0x03, SYSREQ: 0x04 } as const;

/** The data type in a TN3270E header. */
export const DataType = {
  DATA_3270: 0x00, SCS_DATA: 0x01, RESPONSE: 0x02, BIND_IMAGE: 0x03, UNBIND: 0x04,
  NVT_DATA: 0x05, REQUEST: 0x06, SSCP_LU_DATA: 0x07, PRINT_EOJ: 0x08,
} as const;

/** The response flag in a TN3270E header: from the host, what it wants back; from us, the answer. */
export const ResponseFlag = { NO: 0x00, ERROR: 0x01, ALWAYS: 0x02, POSITIVE: 0x00, NEGATIVE: 0x01 } as const;

/** Write commands. Hosts use either the local (CCW) or the SNA code. */
export const Command = {
  W: [0x01, 0xf1], EW: [0x05, 0xf5], EWA: [0x0d, 0x7e], EAU: [0x0f, 0x6f], WSF: [0x11, 0xf3],
  RB: [0x02, 0xf2], RM: [0x06, 0xf6], RMA: [0x0e, 0x6e], NOP: [0x03],
} as const;
export type CommandName = keyof typeof Command;

export function commandName(byte: number): CommandName | undefined {
  for (const [name, codes] of Object.entries(Command)) if ((codes as readonly number[]).includes(byte)) return name as CommandName;
  return undefined;
}

/** Orders inside a write. */
export const Order = {
  PT: 0x05, GE: 0x08, SBA: 0x11, EUA: 0x12, IC: 0x13, SF: 0x1d, SA: 0x28, SFE: 0x29, MF: 0x2c, RA: 0x3c,
} as const;

/** Write control character bits. */
export const WCC = { RESET: 0x40, START_PRINTER: 0x08, ALARM: 0x04, RESTORE: 0x02, RESET_MDT: 0x01 } as const;

/** Field attribute bits. */
export const FA = {
  PROTECTED: 0x20, NUMERIC: 0x10, DISPLAY: 0x0c, INTENSIFIED: 0x08, NONDISPLAY: 0x0c, MDT: 0x01,
} as const;

/** Extended attribute types (SFE, SA, MF). */
export const XA = {
  ALL: 0x00, HIGHLIGHT: 0x41, FOREGROUND: 0x42, CHARSET: 0x43, BACKGROUND: 0x45, TRANSPARENCY: 0x46,
  FIELD: 0xc0, VALIDATION: 0xc1, OUTLINING: 0xc2,
} as const;

export const Highlight = { DEFAULT: 0x00, NORMAL: 0xf0, BLINK: 0xf1, REVERSE: 0xf2, UNDERSCORE: 0xf4, INTENSIFY: 0xf8 } as const;

/** Field validation bits. */
export const Validation = { MANDATORY_FILL: 0x04, MANDATORY_ENTRY: 0x02, TRIGGER: 0x01 } as const;

/** Structured field ids in Write Structured Field. */
export const SF = { READ_PARTITION: 0x01, ERASE_RESET: 0x03, SET_REPLY_MODE: 0x09, OUTBOUND_3270DS: 0x40 } as const;

/** Read Partition types. */
export const ReadPartition = { QUERY: 0x02, QUERY_LIST: 0x03, RMA: 0x6e, RB: 0xf2, RM: 0xf6 } as const;

/** Query reply codes. */
export const QCode = {
  SUMMARY: 0x80, USABLE_AREA: 0x81, CHARACTER_SETS: 0x85, COLOR: 0x86, HIGHLIGHT: 0x87,
  REPLY_MODES: 0x88, IMPLICIT_PARTITION: 0xa6, NULL: 0xff,
} as const;

/** Attention identifiers. */
export const Aid = {
  NONE: 0x60, ENTER: 0x7d, CLEAR: 0x6d, PA1: 0x6c, PA2: 0x6e, PA3: 0x6b, SYSREQ: 0xf0, STRUCTURED_FIELD: 0x88,
} as const;

/** PF1-PF24. */
export const PF_AIDS = [
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c,
  0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c,
] as const;

/** Keys that send only the AID: no cursor, no fields (a short read). */
export const SHORT_READ_AIDS: ReadonlySet<number> = new Set([Aid.CLEAR, Aid.PA1, Aid.PA2, Aid.PA3]);

/** Screen sizes of the 3278 models: the default size is always 24x80. */
export const MODELS: Record<number, { rows: number; cols: number }> = {
  2: { rows: 24, cols: 80 }, 3: { rows: 32, cols: 80 }, 4: { rows: 43, cols: 80 }, 5: { rows: 27, cols: 132 },
};
