// A pretend mainframe for trying Veneer on 3270 without one. It speaks
// TN3270E (with an SSCP-LU logon screen, BIND and UNBIND) and falls back to
// plain TN3270 (an unformatted logon screen) for clients that turn TN3270E
// down. After logon it asks what the terminal can do with a Query, then uses
// colour and highlighting if the reply offers them, and the alternate screen
// size (Erase/Write Alternate) for the order list.
//
// Screens: logon, sign-on, a menu, a customer inquiry, an update form with
// numeric and mandatory fields, and an order list paged with PF7/PF8. PF3 goes
// back, Clear blanks the screen as transaction systems do, PA1/PA2 work, and
// mistakes are reported the way host programs do: alarm, message, and the
// cursor on the field to fix. Any user ID and password sign on.
//
// Every record from a terminal is kept in `connections`, for tests.

import net from 'node:net';
import { getCodepage } from '@veneer/terminal';
import { Attr, Color, HostStream, Highlight, decodeAddress } from '@veneer/tn3270';

const cp = getCodepage(37);

const IAC = 0xff, SB = 0xfa, SE = 0xf0, EOR = 0xef, WILL = 0xfb, WONT = 0xfc, DO = 0xfd;
const BINARY = 0x00, TTYPE = 0x18, OPT_EOR = 0x19, TN3270E = 0x28;
/** TN3270E words and data types (RFC 2355). */
const E = { CONNECT: 0x01, DEVICE_TYPE: 0x02, FUNCTIONS: 0x03, IS: 0x04, REASON: 0x05, REJECT: 0x06, REQUEST: 0x07, SEND: 0x08 };
const T = { DATA: 0x00, RESPONSE: 0x02, BIND: 0x03, UNBIND: 0x04, SSCP_LU: 0x07 };
const FUNCTIONS = [0x00, 0x02]; // BIND-IMAGE, RESPONSES

/** AIDs. */
export const AID = {
  ENTER: 0x7d, CLEAR: 0x6d, PA1: 0x6c, PA2: 0x6e, PA3: 0x6b, QUERY_REPLY: 0x88,
  PF3: 0xf3, PF7: 0xf7, PF8: 0xf8,
} as const;
const SHORT_READS: ReadonlySet<number> = new Set([AID.CLEAR, AID.PA1, AID.PA2, AID.PA3]);
const PF_NAMES = new Map([
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c,
  0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c,
].map((b, i) => [b, `PF${i + 1}`]));

/** The application name the logon screen takes. */
export const APPLICATION = 'DEMO';

// ---- Data

export interface Customer {
  number: string;
  name: string;
  city: string;
  phone: string;
  /** Whole currency units, as typed. */
  credit: string;
  balance: string;
  /** A (active), H (on hold) or I (inactive). */
  status: string;
}

export const CUSTOMERS: readonly Customer[] = [
  { number: '100100', name: 'Lakeside Hardware', city: 'Chicago', phone: '312-555-0142', credit: '25000', balance: '4120.50', status: 'A' },
  { number: '100200', name: 'Harbor Supply Co', city: 'San Francisco', phone: '415-555-0198', credit: '50000', balance: '18877.00', status: 'A' },
  { number: '100300', name: 'Capitol Office Goods', city: 'Washington', phone: '202-555-0117', credit: '10000', balance: '9950.25', status: 'H' },
  { number: '100400', name: 'Pacific Imports', city: 'Seattle', phone: '206-555-0181', credit: '0', balance: '0.00', status: 'I' },
  { number: '100500', name: 'Desert Freight', city: 'Phoenix', phone: '602-555-0129', credit: '15000', balance: '312.80', status: 'A' },
];

export const STATUS: Record<string, string> = { A: 'Active', H: 'On hold', I: 'Inactive' };

const SHIP_VIA = ['Truck', 'Air', 'Ocean', 'Pickup', 'Rail'];
const REPS = ['M. Ortiz', 'J. Chen', 'P. Walsh', 'R. Singh'];
const ORDER_STATUS = ['Open', 'Picked', 'Shipped', 'Invoiced', 'On hold'];

export interface Order {
  number: string;
  customer: string;
  date: string;
  status: string;
  amount: string;
  shipVia: string;
  items: number;
  rep: string;
}

/** 40 orders, made up the same way every time. */
export const ORDERS: readonly Order[] = Array.from({ length: 40 }, (_, i) => {
  const customer = CUSTOMERS[i % CUSTOMERS.length]!;
  const day = String(1 + ((i * 7) % 28)).padStart(2, '0');
  const month = String(1 + (i % 10)).padStart(2, '0');
  return {
    number: String(500001 + i),
    customer: customer.name,
    date: `2026-${month}-${day}`,
    status: ORDER_STATUS[(i * 3) % ORDER_STATUS.length]!,
    amount: ((i * 7919) % 90000 / 100 + 25).toFixed(2),
    shipVia: SHIP_VIA[i % SHIP_VIA.length]!,
    items: 1 + ((i * 5) % 12),
    rep: REPS[i % REPS.length]!,
  };
});

// ---- Screens

/** What the terminal said it can do, from its Query reply. */
export interface Capabilities {
  /** Colour and extended highlighting: use SFE, SA and MF. */
  extended: boolean;
  /** The alternate (largest) screen size. */
  alternate: { rows: number; cols: number };
}

export const BASIC: Capabilities = { extended: false, alternate: { rows: 24, cols: 80 } };

const MESSAGE_ROW = 23;
const KEYS_ROW = 24;

/** Field ids ("row:col") of the input fields, for tests and the demo's definitions. */
export const FIELDS = {
  signOn: { user: '7:24', password: '8:24' },
  menu: { option: '20:14' },
  inquiry: { number: '4:24' },
  update: { number: '4:24', name: '6:24', phone: '7:24', credit: '8:24', status: '9:24' },
} as const;

class Screen3270 {
  readonly s: HostStream;
  private readonly caps: Capabilities;
  readonly cols: number;

  constructor(caps: Capabilities, size?: { rows: number; cols: number }) {
    this.caps = caps;
    this.s = new HostStream().eraseWrite(size ? { alternate: size } : {});
    this.cols = size?.cols ?? 80;
  }

  /** The title line: system name, centred title. */
  title(title: string): this {
    this.s.text(1, 2, 'DEMOHOST', this.color(Color.BLUE));
    this.s.text(1, Math.floor((this.cols - title.length) / 2) + 1, title, { attr: Attr.BRIGHT, ...this.color(Color.TURQUOISE) });
    return this;
  }

  text(row: number, col: number, text: string, color?: number, highlight?: number): this {
    this.s.text(row, col, text, { ...this.color(color), ...(this.caps.extended && highlight ? { highlight } : {}) });
    return this;
  }

  /** A field label with leader dots: "Name . . . . . . ." */
  label(row: number, text: string): this {
    let s = `${text} `;
    // Dots on alternate columns, the same columns on every row.
    while (s.length < 20) s += s.length % 2 === 0 ? ' ' : '.';
    return this.text(row, 2, s, Color.GREEN);
  }

  input(row: number, col: number, length: number, opts: { value?: string; numeric?: boolean; hidden?: boolean; mandatoryEntry?: boolean; mandatoryFill?: boolean; modified?: boolean } = {}): this {
    const attr = opts.hidden ? Attr.HIDDEN : opts.numeric ? Attr.NUMERIC : Attr.INPUT;
    this.s.input(row, col, length, {
      attr,
      ...(opts.value ? { value: opts.value } : {}),
      ...(opts.modified ? { modified: true } : {}),
      ...(this.caps.extended ? {
        color: Color.YELLOW,
        highlight: Highlight.UNDERSCORE,
        ...(opts.mandatoryEntry ? { mandatoryEntry: true } : {}),
        ...(opts.mandatoryFill ? { mandatoryFill: true } : {}),
      } : {}),
    });
    return this;
  }

  /** The message line and the key legend. */
  footer(keys: string, message?: Message): this {
    this.s.text(MESSAGE_ROW, 2, (message?.text ?? '').padEnd(this.cols - 2), {
      attr: Attr.BRIGHT, ...this.color(message?.error ? Color.RED : Color.WHITE),
    });
    this.text(KEYS_ROW, 2, keys, Color.BLUE);
    return this;
  }

  cursor(row: number, col: number): number[] {
    return this.s.cursor(row, col).build();
  }

  private color(color?: number): { color?: number } {
    return this.caps.extended && color ? { color } : {};
  }
}

interface Message {
  text: string;
  error?: boolean;
}

/** The logon screen's text, as SSCP-LU lines or an unformatted screen. */
export const LOGON_LINES = [
  'DEMOHOST - a pretend mainframe for trying Veneer. Nothing here is real.',
  '',
  'Type the name of an application and press Enter:',
  `  ${APPLICATION.padEnd(8)} The demo application (Enter alone starts it too)`,
  '',
];

/** The unformatted logon screen, for plain TN3270. */
export function logonScreen(message?: string): number[] {
  const s = new HostStream().eraseWrite();
  LOGON_LINES.forEach((line, i) => { if (line) s.at(i + 2, 2).chars(line); });
  if (message) s.at(9, 2).chars(message);
  return s.cursor(12, 2).build();
}

export function signOn(caps: Capabilities, message?: Message, user = ''): number[] {
  return new Screen3270(caps)
    .title('Sign On')
    .text(4, 2, 'Type your user ID and password, then press Enter. Any user ID works.')
    .label(7, 'User ID').input(7, 24, 8, { value: user, mandatoryEntry: true })
    .label(8, 'Password').input(8, 24, 8, { hidden: true })
    .footer('PF3=Exit', message)
    .cursor(7, 24);
}

export function menu(caps: Capabilities, user: string, message?: Message): number[] {
  return new Screen3270(caps)
    .title('Main Menu')
    .text(3, 2, `Signed on as ${user}.`)
    .text(5, 2, 'Type an option number and press Enter.')
    .text(7, 6, '1  Customer inquiry', Color.TURQUOISE)
    .text(8, 6, '2  Update a customer', Color.TURQUOISE)
    .text(9, 6, '3  Order list', Color.TURQUOISE)
    .text(20, 2, 'Option ===>').input(20, 14, 2, { numeric: true })
    .footer('PF3=Sign off  Clear=Blank screen  PA2=Redisplay', message)
    .cursor(20, 14);
}

const statusColor = (status: string) => (status === 'A' ? Color.GREEN : status === 'H' ? Color.YELLOW : Color.PINK);

export function inquiry(caps: Capabilities, customer?: Customer, message?: Message, typed = ''): number[] {
  const s = new Screen3270(caps)
    .title('Customer Inquiry')
    .label(4, 'Customer number').input(4, 24, 6, { numeric: true, value: customer?.number ?? typed });
  if (customer) {
    s.label(6, 'Name').text(6, 24, customer.name, Color.WHITE)
      .label(7, 'City').text(7, 24, customer.city, Color.WHITE)
      .label(8, 'Phone').text(8, 24, customer.phone, Color.WHITE)
      .label(9, 'Credit limit').text(9, 24, customer.credit.padStart(9), Color.WHITE)
      .label(10, 'Balance').text(10, 24, customer.balance.padStart(12), Color.WHITE)
      .label(11, 'Status').text(11, 24, STATUS[customer.status] ?? customer.status, statusColor(customer.status), Highlight.REVERSE);
  } else {
    s.text(6, 2, `Type a customer number, such as ${CUSTOMERS[0]!.number}, and press Enter.`);
  }
  return s.footer('PF3=Return  Clear=Blank screen  PA2=Redisplay', message).cursor(4, 24);
}

/**
 * The update form. The customer number must be typed, all six digits
 * (mandatory entry and fill). Once a customer is loaded it is sent with its
 * modified flag on, so it comes back with every key, as host programs do to
 * keep their place, and counts as entered.
 */
export function update(caps: Capabilities, customer?: Customer, message?: Message, cursor = { row: 4, col: 24 }): number[] {
  const s = new Screen3270(caps)
    .title('Update Customer')
    .label(4, 'Customer number').input(4, 24, 6, { numeric: true, mandatoryEntry: true, mandatoryFill: true, value: customer?.number ?? '', modified: Boolean(customer) });
  if (customer) {
    // Not mandatory entry: that would make the user retype the name before every Enter.
    s.label(6, 'Name').input(6, 24, 30, { value: customer.name })
      .label(7, 'Phone').input(7, 24, 12, { value: customer.phone })
      .label(8, 'Credit limit').input(8, 24, 9, { value: customer.credit, numeric: true })
      .label(9, 'Status').input(9, 24, 1, { value: customer.status })
      .text(9, 27, 'A=Active  H=On hold  I=Inactive')
      .text(12, 2, 'Change the details and press Enter to save them.');
  } else {
    s.text(6, 2, `Type a customer number, such as ${CUSTOMERS[0]!.number}, and press Enter.`);
  }
  return s.footer('PF3=Return  Clear=Blank screen  PA2=Undo changes', message).cursor(cursor.row, cursor.col);
}

/** Orders per page on a screen of some size: the rows between the headings and the message line. */
export const ordersPerPage = (rows: number) => rows - 9;

/**
 * The order list. On a terminal with a larger alternate size it uses that
 * size (Erase/Write Alternate): more rows on models 3 and 4, and more
 * columns on a model 5.
 */
export function orders(caps: Capabilities, page: number, message?: Message): number[] {
  const size = caps.alternate;
  const alternate = size.rows !== 24 || size.cols !== 80;
  const wide = size.cols >= 132;
  const rows = alternate ? size.rows : 24;
  const perPage = ordersPerPage(rows);
  const s = new Screen3270(caps, alternate ? size : undefined).title('Order List');
  const pages = Math.ceil(ORDERS.length / perPage);
  s.text(3, 2, `Page ${page + 1} of ${pages}`);
  const head = ['Order', 'Customer', 'Date', 'Status', 'Amount', ...(wide ? ['Ship via', 'Items', 'Sales rep'] : [])];
  const cols = [2, 10, 34, 46, 56, ...(wide ? [70, 82, 90] : [])];
  head.forEach((h, k) => s.text(5, cols[k]!, h, Color.WHITE, Highlight.UNDERSCORE));
  ORDERS.slice(page * perPage, (page + 1) * perPage).forEach((o, i) => {
    const row = 6 + i;
    const cells = [o.number, o.customer.slice(0, 22), o.date, o.status, o.amount.padStart(10), ...(wide ? [o.shipVia, String(o.items).padStart(5), o.rep] : [])];
    cells.forEach((c, k) => s.text(row, cols[k]!, c, k === 3 && o.status === 'On hold' ? Color.YELLOW : undefined));
  });
  // The message line and keys sit at the bottom of whichever size is in use.
  s.s.text(rows - 1, 2, (message?.text ?? '').padEnd(s.cols - 2), { attr: Attr.BRIGHT, ...(caps.extended ? { color: message?.error ? Color.RED : Color.WHITE } : {}) });
  s.text(rows, 2, 'PF3=Return  PF7=Back  PF8=Forward  Clear=Blank screen', Color.BLUE);
  return s.s.cursor(rows, 2).build();
}

/**
 * A host program's answer to a mistake: a Write (not an erase) that sounds
 * the alarm, shows the message, marks the field and puts the cursor on it.
 * What the user typed stays on the screen, still marked as changed.
 */
export function fieldError(caps: Capabilities, message: string, at: { row: number; col: number }, cols = 80): number[] {
  const s = new HostStream().write({ alarm: true });
  s.at(MESSAGE_ROW, 2);
  if (caps.extended) s.charAttr('color', Color.RED);
  s.chars(message.padEnd(cols - 2));
  if (caps.extended) {
    s.charAttr('reset');
    // Modify Field on the field's attribute: reverse video, red.
    s.at(at.row, at.col - 1).bytes(0x2c, 2, 0x41, Highlight.REVERSE, 0x42, Color.RED);
  }
  return s.cursor(at.row, at.col).build();
}

/** A message on the current screen, keeping everything else. */
export function note(message: string, cols = 80, row = MESSAGE_ROW, alarm = false): number[] {
  return new HostStream().write({ alarm }).at(row, 2).chars(message.padEnd(cols - 2)).build();
}

/** Where the Query asks what the terminal can do. */
export const QUERY = [0xf3, 0x00, 0x05, 0x01, 0xff, 0x02];

/** A plausible BIND for an LU 2 session. Veneer only notes that one came. */
const BIND = [0x31, 0x01, 0x03, 0x03, 0xb1, 0x90, 0x30, 0x80, 0x00, 0x00, 0x87, 0x87, 0xf8, 0x87, 0x00, 0x02, 0x80, 0x00, 0x00, 0x00, 0x00, 0x18, 0x50, 0x00, 0x7e, 0x00];

/** What a terminal can do, from its Query reply. */
export function capabilities(reply: number[]): Capabilities {
  const replies = new Map<number, number[]>();
  for (let i = 1; i + 4 <= reply.length;) {
    const length = (reply[i]! << 8) | reply[i + 1]!;
    if (length < 4 || reply[i + 2] !== 0x81) break;
    replies.set(reply[i + 3]!, reply.slice(i + 4, i + length));
    i += length;
  }
  const area = replies.get(0x81);
  const alternate = area && area.length >= 6
    ? { cols: (area[2]! << 8) | area[3]!, rows: (area[4]! << 8) | area[5]! }
    : { rows: 24, cols: 80 };
  return { extended: replies.has(0x86) && replies.has(0x87), alternate };
}

// ---- Inbound records

export interface Inbound {
  aid: number;
  cursor?: { row: number; col: number };
  /** Changed fields by "row:col" (formatted screens). */
  fields: Map<string, string>;
  /** Everything typed on an unformatted screen, in buffer order. */
  text: string;
}

/** Split a Read Modified: AID, cursor, then SBA + data per changed field (or plain data, unformatted). */
export function parseInbound(data: number[], cols: number): Inbound {
  const aid = data[0]!;
  const fields = new Map<string, string>();
  if (data.length < 3) return { aid, fields, text: '' };
  const at = (a: number) => ({ row: Math.floor(a / cols) + 1, col: (a % cols) + 1 });
  const cursor = at(decodeAddress(data[1]!, data[2]!));
  if (data[3] !== 0x11) return { aid, cursor, fields, text: cp.decode(data.slice(3)) };
  let i = 3;
  while (i < data.length && data[i] === 0x11) {
    const { row, col } = at(decodeAddress(data[i + 1]!, data[i + 2]!));
    i += 3;
    const start = i;
    while (i < data.length && data[i] !== 0x11) i++;
    fields.set(`${row}:${col}`, cp.decode(data.slice(start, i)));
  }
  return { aid, cursor, fields, text: '' };
}

// ---- The host

type State =
  | { screen: 'logon' }
  | { screen: 'query' }
  | { screen: 'signon' }
  | { screen: 'menu' }
  | { screen: 'inquiry'; customer?: Customer }
  | { screen: 'update'; customer?: Customer }
  | { screen: 'orders'; page: number }
  /** After Clear: a blank, unformatted screen that takes a command. */
  | { screen: 'blank' };

/** One terminal's connection, for tests to inspect. */
export interface Connection {
  mode: 'tn3270e' | 'tn3270' | 'negotiating';
  terminalType?: string;
  lu?: string;
  /** 3270 data from the terminal, TN3270E header removed. */
  records: number[][];
  /** What was typed on the SSCP-LU logon screen. */
  sscp: string[];
  /** TN3270E responses to records sent with "always respond". */
  responses: Array<{ seq: number; positive: boolean }>;
  caps: Capabilities;
  user?: string;
}

export class DemoHost3270 {
  readonly server = net.createServer((s) => this.onConnection(s));
  readonly connections: Connection[] = [];
  private nextLu = 1;

  async listen(port = 0): Promise<number> {
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    return (this.server.address() as net.AddressInfo).port;
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  private onConnection(socket: net.Socket): void {
    socket.on('error', () => {});
    const conn: Connection = { mode: 'negotiating', records: [], sscp: [], responses: [], caps: BASIC };
    this.connections.push(conn);
    const customers = CUSTOMERS.map((c) => ({ ...c }));
    let state: State = { screen: 'logon' };
    let seq = 0;
    /** The host's own text on the unformatted screen showing, if any. */
    let hostText = '';

    const raw = (bytes: number[]) => socket.write(Buffer.from(bytes));
    const sub = (body: number[]) => raw([IAC, SB, ...body, IAC, SE]);
    const record = (type: number, data: number[], respond = false) => {
      const head = conn.mode === 'tn3270e' ? [type, 0x00, respond ? 0x02 : 0x00, (seq >> 8) & 0x7f, seq & 0xff] : [];
      seq = (seq + 1) & 0x7fff;
      const body = [...head, ...data].flatMap((b) => (b === IAC ? [b, b] : [b]));
      raw([...body, IAC, EOR]);
    };
    const show = (data: number[], respond = false) => record(T.DATA, data, respond);
    /** An unformatted screen: remember its text, which comes back with what the user types. */
    const showUnformatted = (data: number[]) => { hostText = unformattedText(data); show(data); };
    // Only the order list uses the alternate size.
    const cols = () => (state.screen === 'orders' ? conn.caps.alternate.cols : 80);
    const messageRow = () => (state.screen === 'orders' ? conn.caps.alternate.rows - 1 : MESSAGE_ROW);

    const logon = (message?: string) => {
      state = { screen: 'logon' };
      if (conn.mode === 'tn3270e') {
        const lines = message ? [message, ''] : LOGON_LINES;
        record(T.SSCP_LU, [...lines.flatMap((l) => [...cp.encode(l), 0x15])]);
      } else {
        showUnformatted(logonScreen(message));
      }
    };
    const startApplication = () => {
      if (conn.mode === 'tn3270e') record(T.BIND, BIND);
      state = { screen: 'query' };
      show(QUERY);
    };
    const signOff = () => {
      if (conn.mode === 'tn3270e') record(T.UNBIND, [0x01]);
      conn.user = undefined;
      logon();
    };
    const toMenu = (message?: Message) => { state = { screen: 'menu' }; show(menu(conn.caps, conn.user!, message)); };
    const unused = (aid: number) => show(note(`${PF_NAMES.get(aid) ?? 'That key'} is not used on this screen.`, cols(), messageRow(), true));

    const onLogonText = (typed: string) => {
      const words = typed.trim().toUpperCase().replace(/[()]/g, ' ').split(/\s+/).filter(Boolean);
      const app = words[0] === 'LOGON' ? words.find((w, i) => i > 0 && w !== 'APPLID') : words[0];
      if (app === undefined || app === APPLICATION) return startApplication();
      return logon(`${app} is not an application here. Type ${APPLICATION}, or press Enter.`);
    };

    const onData = (data: number[]) => {
      if (data.length === 0) return;
      conn.records.push(data);
      const s = state;
      if (data[0] === AID.QUERY_REPLY) {
        conn.caps = capabilities(data);
        if (s.screen === 'query') { state = { screen: 'signon' }; show(signOn(conn.caps), true); }
        return;
      }
      const input = parseInbound(data, cols());
      const { aid, fields } = input;
      if (s.screen === 'logon') {
        // Plain TN3270: the logon screen is an unformatted 3270 screen.
        if (aid === AID.CLEAR) return logon();
        if (aid !== AID.ENTER) return logon();
        return onLogonText(stripHostText(input.text, hostText));
      }
      if (s.screen === 'query') return;
      if (aid === AID.CLEAR) {
        // The screen is already blank at the terminal; unlock the keyboard.
        state = { screen: 'blank' };
        hostText = '';
        return show(new HostStream().write().build());
      }
      if (s.screen === 'blank') {
        const command = stripHostText(input.text, hostText).trim().toUpperCase();
        if (aid !== AID.ENTER) return show(new HostStream().write().build());
        if (!conn.user) { state = { screen: 'signon' }; return show(signOn(conn.caps)); }
        if (command === '' || command === 'MENU') return toMenu();
        if (command === 'LOGOFF' || command === 'SIGNOFF') return signOff();
        return showUnformatted(new HostStream().eraseWrite().at(1, 2).chars(`${command} is not a command here. Type MENU or LOGOFF, or press Enter for the menu.`).cursor(2, 2).build());
      }
      if (aid === AID.PA1 || aid === AID.PA3) {
        const name = aid === AID.PA1 ? 'PA1' : 'PA3';
        return show(note(`${name} sends no field data, so nothing you typed was read.`, cols(), messageRow()));
      }
      if (aid === AID.PA2) return redisplay();

      switch (s.screen) {
        case 'signon': {
          if (aid === AID.PF3) return signOff();
          if (aid !== AID.ENTER) return unused(aid);
          const user = (fields.get(FIELDS.signOn.user) ?? '').trim().toUpperCase();
          if (!user) return show(fieldError(conn.caps, 'Type a user ID. Any user ID works in the demo.', { row: 7, col: 24 }));
          conn.user = user;
          return toMenu();
        }
        case 'menu': {
          if (aid === AID.PF3) return signOff();
          if (aid !== AID.ENTER) return unused(aid);
          const option = (fields.get(FIELDS.menu.option) ?? '').trim();
          if (option === '1') { state = { screen: 'inquiry' }; return show(inquiry(conn.caps)); }
          if (option === '2') { state = { screen: 'update' }; return show(update(conn.caps)); }
          if (option === '3') { state = { screen: 'orders', page: 0 }; return show(orders(conn.caps, 0)); }
          return show(fieldError(conn.caps, option ? `${option} is not an option. Type 1, 2 or 3.` : 'Type an option number: 1, 2 or 3.', { row: 20, col: 14 }));
        }
        case 'inquiry': {
          if (aid === AID.PF3) return toMenu();
          if (aid !== AID.ENTER) return unused(aid);
          const number = (fields.get(FIELDS.inquiry.number) ?? s.customer?.number ?? '').trim();
          const customer = customers.find((c) => c.number === number);
          if (!customer) {
            return show(fieldError(conn.caps, number ? `There is no customer ${number}. Try ${customers[0]!.number}.` : 'Type a customer number.', { row: 4, col: 24 }));
          }
          state = { screen: 'inquiry', customer };
          return show(inquiry(conn.caps, customer));
        }
        case 'update': return onUpdate(s, aid, fields);
        case 'orders': {
          if (aid === AID.PF3) return toMenu();
          const rows = conn.caps.alternate.rows;
          const pages = Math.ceil(ORDERS.length / ordersPerPage(rows));
          if (aid === AID.PF7) {
            if (s.page === 0) return show(note('Already at the top of the list.', cols(), rows - 1));
            state = { screen: 'orders', page: s.page - 1 };
            return show(orders(conn.caps, s.page - 1));
          }
          if (aid === AID.PF8) {
            if (s.page + 1 >= pages) return show(note('Already at the bottom of the list.', cols(), rows - 1));
            state = { screen: 'orders', page: s.page + 1 };
            return show(orders(conn.caps, s.page + 1));
          }
          if (aid === AID.ENTER) return show(orders(conn.caps, s.page));
          return unused(aid);
        }
      }
    };

    const onUpdate = (s: Extract<State, { screen: 'update' }>, aid: number, fields: Map<string, string>) => {
      if (aid === AID.PF3) return toMenu();
      if (aid !== AID.ENTER) return unused(aid);
      const number = (fields.get(FIELDS.update.number) ?? '').trim();
      const customer = customers.find((c) => c.number === number);
      if (!customer) {
        return show(fieldError(conn.caps, number ? `There is no customer ${number}. Try ${customers[0]!.number}.` : 'Type a customer number.', FIELD_AT.number));
      }
      if (customer !== s.customer) {
        state = { screen: 'update', customer };
        return show(update(conn.caps, customer, { text: 'Change the details and press Enter.' }, FIELD_AT.name));
      }
      const changed = (k: keyof typeof FIELDS.update) => fields.get(FIELDS.update[k]);
      const name = changed('name')?.trim();
      const phone = changed('phone')?.trim();
      const credit = changed('credit')?.trim();
      const status = changed('status')?.trim().toUpperCase();
      if (name !== undefined && name === '') return show(fieldError(conn.caps, 'Type a name.', FIELD_AT.name));
      if (credit !== undefined && !/^\d{1,7}$/.test(credit)) return show(fieldError(conn.caps, 'The credit limit is a whole number, such as 5000.', FIELD_AT.credit));
      if (status !== undefined && !STATUS[status]) return show(fieldError(conn.caps, 'Type A (active), H (on hold) or I (inactive).', FIELD_AT.status));
      const what = (['name', 'phone', 'credit', 'status'] as const).filter((k) => changed(k) !== undefined);
      if (name !== undefined) customer.name = name;
      if (phone !== undefined) customer.phone = phone;
      if (credit !== undefined) customer.credit = String(Number(credit));
      if (status !== undefined) customer.status = status;
      const text = what.length === 0 ? 'Nothing was changed.' : `Customer ${customer.number} updated: ${what.map((k) => LABELS[k]).join(', ')}.`;
      return show(update(conn.caps, customer, { text }));
    };

    const redisplay = () => {
      const s = state;
      if (s.screen === 'signon') return show(signOn(conn.caps));
      if (s.screen === 'menu') return toMenu();
      if (s.screen === 'inquiry') return show(inquiry(conn.caps, s.customer));
      if (s.screen === 'update') return show(update(conn.caps, s.customer, s.customer ? { text: 'Your changes were undone.' } : undefined));
      if (s.screen === 'orders') return show(orders(conn.caps, s.page));
    };

    // ---- Telnet
    const onSub = (body: number[]) => {
      const [option, word, verb, ...rest] = body;
      if (option === TTYPE && word === 0x00) {
        // Plain TN3270: TERMINAL-TYPE IS type[@LU] (RFC 1646).
        const [type, lu] = String.fromCharCode(verb!, ...rest).split('@');
        conn.terminalType = type;
        conn.lu = lu || `DEMO${String(this.nextLu++).padStart(4, '0')}`;
        conn.mode = 'tn3270';
        raw([IAC, DO, OPT_EOR, IAC, WILL, OPT_EOR, IAC, DO, BINARY, IAC, WILL, BINARY]);
        return logon();
      }
      if (option !== TN3270E) return;
      if (word === E.DEVICE_TYPE && verb === E.REQUEST) {
        const connect = rest.indexOf(E.CONNECT);
        const type = String.fromCharCode(...rest.slice(0, connect < 0 ? undefined : connect));
        if (!/^IBM-327[89]-[2-5]-E$/.test(type)) {
          return sub([TN3270E, E.DEVICE_TYPE, E.REJECT, E.REASON, 0x04]); // invalid device type
        }
        conn.terminalType = type;
        conn.lu = connect < 0 ? `DEMO${String(this.nextLu++).padStart(4, '0')}` : String.fromCharCode(...rest.slice(connect + 1));
        return sub([TN3270E, E.DEVICE_TYPE, E.IS, ...Buffer.from(type), E.CONNECT, ...Buffer.from(conn.lu)]);
      }
      if (word === E.FUNCTIONS && (verb === E.REQUEST || verb === E.IS)) {
        const agreed = rest.filter((f) => FUNCTIONS.includes(f));
        if (verb === E.REQUEST && agreed.length !== rest.length) return sub([TN3270E, E.FUNCTIONS, E.REQUEST, ...agreed]);
        if (verb === E.REQUEST) sub([TN3270E, E.FUNCTIONS, E.IS, ...agreed]);
        conn.mode = 'tn3270e';
        return logon();
      }
    };

    const onRecord = (rec: number[]) => {
      if (conn.mode !== 'tn3270e') return onData(rec);
      const [type, , flag, s1, s2] = rec;
      const data = rec.slice(5);
      if (type === T.RESPONSE) return void conn.responses.push({ seq: (s1! << 8) | s2!, positive: flag === 0x00 });
      if (type === T.SSCP_LU && state.screen === 'logon') {
        const typed = cp.decode(data);
        conn.sscp.push(typed);
        return onLogonText(typed);
      }
      if (type === T.DATA) return onData(data);
    };

    let mode: 'data' | 'iac' | 'verb' | 'sb' | 'sbiac' = 'data';
    let verb = 0;
    let rec: number[] = [];
    let body: number[] = [];
    socket.on('data', (chunk) => {
      for (const b of chunk) {
        if (mode === 'data') { if (b === IAC) mode = 'iac'; else rec.push(b); }
        else if (mode === 'iac') {
          mode = 'data';
          if (b === IAC) rec.push(b);
          else if (b === EOR) { const r = rec; rec = []; if (r.length) onRecord(r); }
          else if (b === SB) { body = []; mode = 'sb'; }
          else if (b >= WILL && b <= 0xfe) { verb = b; mode = 'verb'; }
        } else if (mode === 'verb') {
          mode = 'data';
          if (b === TN3270E && verb === WILL) sub([TN3270E, E.SEND, E.DEVICE_TYPE]);
          else if (b === TN3270E && verb === WONT) raw([IAC, DO, TTYPE]);
          else if (b === TTYPE && verb === WILL && conn.mode === 'negotiating') sub([TTYPE, 0x01]);
        } else if (mode === 'sb') { if (b === IAC) mode = 'sbiac'; else body.push(b); }
        else if (b === SE) { mode = 'data'; onSub(body); }
        else { body.push(b); mode = 'sb'; }
      }
    });
    raw([IAC, DO, TN3270E]);
  }
}

const FIELD_AT = {
  number: { row: 4, col: 24 }, name: { row: 6, col: 24 }, phone: { row: 7, col: 24 }, credit: { row: 8, col: 24 }, status: { row: 9, col: 24 },
};
const LABELS = { name: 'name', phone: 'phone', credit: 'credit limit', status: 'status' } as const;

/** The characters an unformatted write puts on the screen, in buffer order (what a Read Modified returns of them). */
function unformattedText(stream: number[]): string {
  const out: number[] = [];
  for (let i = 2; i < stream.length; i++) {
    const b = stream[i]!;
    if (b === 0x11) i += 2;
    else if (b === 0x13) continue;
    else out.push(b);
  }
  return cp.decode(out);
}

/** What the user typed on an unformatted screen: the buffer less the host's own text. */
export function stripHostText(buffer: string, host: string): string {
  return buffer.startsWith(host) ? buffer.slice(host.length) : buffer;
}
