// A fake IBM i for trying Veneer without one: sign-on, main menu and a
// pageable Work with Active Jobs subfile. Any user and password sign on.

import net from 'node:net';
import { Attr, HostStream, buildRecord, getCodepage } from '@veneer/tn5250';

const cp = getCodepage(37);
const IAC = 0xff;
const { WHITE, BLUE, NONDISPLAY } = Attr;
const PAGE_SIZE = 9;

const JOBS = [
  ['QBATCH', 'QSYS', 'SBS', '.0', '', 'DEQW'],
  ['QSYSWRK', 'QSYS', 'SBS', '.0', '', 'DEQW'],
  ['QZSOSIGN', 'QUSER', 'PJ', '.0', '', 'TIMW'],
  ['QINTER', 'QSYS', 'SBS', '.0', '', 'DEQW'],
  ['QPADEV0001', 'DLONG', 'INT', '.4', 'CMD-WRKACTJOB', 'RUN'],
  ['QPADEV0002', 'ACCTPAY', 'INT', '.0', 'PGM-AP100R', 'DSPW'],
  ['QPADEV0003', 'WAREHOUSE', 'INT', '2.1', 'PGM-INV300', 'DSPW'],
  ['QSPL', 'QSYS', 'SBS', '.0', '', 'DEQW'],
  ['PRT01', 'QSPLJOB', 'WTR', '.0', '', 'MSGW'],
  ['QSERVER', 'QSYS', 'SBS', '.0', '', 'DEQW'],
  ['QPWFSERVSD', 'QUSER', 'BCH', '.0', '', 'SELW'],
  ['QUSRWRK', 'QSYS', 'SBS', '.0', '', 'DEQW'],
  ['ORDERSYNC', 'APPUSER', 'BCH', '14.8', 'PGM-ORD500', 'RUN'],
  ['NIGHTLY', 'APPUSER', 'BCH', '.0', 'DLY-60', 'DLYW'],
  ['QHTTPSVR', 'QSYS', 'SBS', '.0', '', 'DEQW'],
  ['ADMIN', 'QTMHHTTP', 'BCI', '.1', 'PGM-QZHBMAIN', 'SIGW'],
];

type State =
  | { screen: 'signon' }
  | { screen: 'menu'; user: string }
  | { screen: 'menuWindow'; user: string }
  | { screen: 'order'; user: string }
  | { screen: 'customer'; user: string; index: number }
  | { screen: 'jobs'; user: string; page: number }
  /** Help, shown from `back` (the screen Help was pressed on) about `topic`. */
  | { screen: 'help'; user: string; back: 'order' | 'menu'; topic: string; page: number };

/** Simulated host latency, to exercise type-ahead (VENEER_DEMO_DELAY_MS). */
const DELAY_MS = Number(process.env.VENEER_DEMO_DELAY_MS ?? 0);

export class DemoHost {
  readonly server = net.createServer((s) => this.onConnection(s));

  async listen(port = 0): Promise<number> {
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    return (this.server.address() as net.AddressInfo).port;
  }

  private onConnection(socket: net.Socket): void {
    socket.on('error', () => {});
    socket.write(Buffer.from([IAC, 0xfd, 0x18, IAC, 0xfd, 0x19, IAC, 0xfb, 0x19, IAC, 0xfd, 0x00, IAC, 0xfb, 0x00]));
    let state: State = { screen: 'signon' };
    const show = (stream: number[]) => send(socket, stream);
    show(signOn());

    onRecords(socket, (rec) => {
      if (rec[9] !== 0x03 || rec.length < 13) return;
      const aid = rec[12]!;
      const fields = parseFields(rec.subarray(13));
      const s = state;
      // The Help key: a help window for the order entry field at the cursor,
      // full-screen help for the main menu, none elsewhere.
      if (aid === 0xf3 && s.screen !== 'signon' && s.screen !== 'help') {
        const row = rec[10]!;
        if (s.screen === 'order') {
          const topic = ORDER_HELP[row] ? String(row) : 'order';
          state = { screen: 'help', user: s.user, back: 'order', topic, page: 0 };
          return show(helpWindow(topic, 0));
        }
        if (s.screen === 'menu') {
          state = { screen: 'help', user: s.user, back: 'menu', topic: 'menu', page: 0 };
          return show(menuHelp(0));
        }
        return show(new HostStream().errorMessage('CPD9001 - Help is not available for this display.').build());
      }
      if (s.screen === 'help') {
        const pages = s.back === 'menu' ? MENU_HELP.length : (ORDER_HELP[s.topic] ?? ORDER_HELP.order!).length;
        const draw = (page: number) => (s.back === 'menu' ? menuHelp(page) : helpWindow(s.topic, page));
        if (aid === 0x33 || aid === 0x3c || aid === 0xf1) { // F3, F12, Enter: back where Help was pressed
          state = s.back === 'menu' ? { screen: 'menu', user: s.user } : { screen: 'order', user: s.user };
          return show(s.back === 'menu' ? mainMenu(s.user) : orderEntry());
        }
        if (aid === 0xf5) {
          if (s.page + 1 >= pages) return show(new HostStream().errorMessage('CPF6A07 - Already at bottom of help.').build());
          state = { ...s, page: s.page + 1 };
          return show(draw(s.page + 1));
        }
        if (aid === 0xf4 && s.page > 0) {
          state = { ...s, page: s.page - 1 };
          return show(draw(s.page - 1));
        }
        return show(draw(s.page));
      }
      if (s.screen === 'signon') {
        const user = (fields.get('6:53') ?? '').trim().toUpperCase();
        if (aid !== 0xf1) return show(signOn());
        if (!user) return show(signOn('CPF1120 - User blank not valid.'));
        state = { screen: 'menu', user };
        return show(mainMenu(user));
      }
      if (s.screen === 'menu') {
        if (aid === 0x33 || aid === 0x3c) { state = { screen: 'signon' }; return show(signOn()); } // F3, F12
        const cmd = (fields.get('20:7') ?? '').trim().toUpperCase();
        if (cmd === '90' || cmd === 'SIGNOFF') return void socket.end();
        if (cmd === '2') {
          state = { screen: 'order', user: s.user };
          return show(orderEntry());
        }
        if (cmd === '3') {
          state = { screen: 'customer', user: s.user, index: 0 };
          return show(customerAddresses(0));
        }
        if (aid === 0x34 || cmd === '9') { // F4 or "Display a menu"
          state = { screen: 'menuWindow', user: s.user };
          return show(menuWindow());
        }
        if (cmd === 'WRKACTJOB' || cmd === '1') {
          state = { screen: 'jobs', user: s.user, page: 0 };
          return show(jobs(0));
        }
        if (!cmd) return show(mainMenu(s.user));
        return show(new HostStream().errorMessage(`CPD0030 - Command ${cmd} in library *LIBL not found.`).build());
      }
      if (s.screen === 'order') {
        if (aid === 0x3c || aid === 0x33) { state = { screen: 'menu', user: s.user }; return show(mainMenu(s.user)); }
        const qty = decodeSigned(fields.get('8:22'));
        const value = (id: string) => (fields.get(id) ?? '').trim();
        // Keep it within one 80-column row.
        const summary = `Accepted: ${value('6:22')} ${value('7:22')} qty ${qty} item ${value('9:22')} ` +
          `ship ${value('10:22') || '-'} rush ${value('11:22') || 'N'}`.slice(0, 78);
        return show(orderEntry(summary));
      }
      if (s.screen === 'customer') {
        if (aid === 0x3c || aid === 0x33) { state = { screen: 'menu', user: s.user }; return show(mainMenu(s.user)); }
        const typed = (fields.get('4:22') ?? '').trim();
        const found = typed ? CUSTOMERS.findIndex((c) => c.number === typed.padStart(6, '0')) : -1;
        // Enter with a known number shows it; otherwise PageDown/Enter goes to the next customer, PageUp back.
        const index = found >= 0 ? found
          : aid === 0xf4 ? (s.index + CUSTOMERS.length - 1) % CUSTOMERS.length
          : (s.index + 1) % CUSTOMERS.length;
        state = { ...s, index };
        return show(customerAddresses(index, typed && found < 0 ? `Customer ${typed} not found.` : undefined));
      }
      if (s.screen === 'menuWindow') {
        const menu = (fields.get('11:38') ?? '').trim().toUpperCase();
        if (aid === 0x3c || aid === 0x33 || (aid === 0xf1 && menu)) { // F12, F3, or a menu name
          state = { screen: 'menu', user: s.user };
          return show(mainMenu(s.user, menu && aid === 0xf1 ? `Menu ${menu} is not available in the demo.` : undefined));
        }
        return show(new HostStream().errorMessage('CPD0071 - Value required for Menu.').build());
      }
      if (s.screen === 'jobs') {
        const pages = Math.ceil(JOBS.length / PAGE_SIZE);
        if (aid === 0x33 || aid === 0x3c) { state = { screen: 'menu', user: s.user }; return show(mainMenu(s.user)); }
        if (aid === 0xf5) {
          if (s.page + 1 >= pages) return show(jobs(s.page, 'Already at bottom of area.'));
          state = { ...s, page: s.page + 1 };
          return show(jobs(s.page + 1));
        }
        if (aid === 0xf4) {
          if (s.page === 0) return show(jobs(0, 'Already at top of area.'));
          state = { ...s, page: s.page - 1 };
          return show(jobs(s.page - 1));
        }
        const picked = [...fields].filter(([id, v]) => id !== '21:7' && v.trim());
        if (picked.length > 0) {
          const [id, opt] = picked[0]!;
          const row = Number(id.split(':')[0]);
          const job = JOBS[s.page * PAGE_SIZE + (row - 11)];
          return show(jobs(s.page, `Option ${opt.trim()} selected for job ${job?.[0] ?? '?'}.`));
        }
        return show(jobs(s.page));
      }
    });
  }
}

function signOn(error?: string): number[] {
  const s = new HostStream().clear().write()
    .text(1, 36, 'Sign On', WHITE)
    .text(2, 48, 'System  . . . . . :   VENEER')
    .text(3, 48, 'Subsystem . . . . :   QINTER')
    .text(4, 48, 'Display . . . . . :   QPADEV0001')
    .text(6, 17, 'User  . . . . . . . . . . . . . .')
    .field(6, 53, 10, { ffw: 0x4020 })
    .text(7, 17, 'Password  . . . . . . . . . . . .')
    .field(7, 53, 10, { attr: NONDISPLAY })
    .text(9, 17, 'Program/procedure . . . . . . . .')
    .field(9, 53, 10, { ffw: 0x4020 })
    .text(10, 17, 'Menu  . . . . . . . . . . . . . .')
    .field(10, 53, 10, { ffw: 0x4020 })
    .text(24, 40, '(C) COPYRIGHT IBM CORP. 1980, 2024.')
    .cursor(6, 53).readMdt().build();
  return error ? [...s, ...new HostStream().errorMessage(error).build()] : s;
}

/** Order entry: mandatory, mandatory-fill, signed numeric and auto-enter fields. */
export function orderEntry(message?: string): number[] {
  const s = new HostStream().clear().write()
    .text(1, 2, 'ORD100')
    .text(1, 34, 'Order Entry', WHITE)
    .text(3, 2, 'Type choices, press Enter.', BLUE)
    .text(6, 4, 'Customer . . . .').field(6, 22, 6, { ffw: 0x4028 }).text(6, 30, 'Required', BLUE)
    .text(7, 4, 'State  . . . . .').field(7, 22, 2, { ffw: 0x4027 }).text(7, 30, 'Two letters', BLUE)
    .text(8, 4, 'Quantity . . . .').field(8, 22, 6, { ffw: 0x4706 }).text(8, 30, 'Negative for a return', BLUE)
    .text(9, 4, 'Item code  . . .').field(9, 22, 3, { ffw: 0x4580 }).text(9, 30, '3 digits, submits when full', BLUE)
    .text(10, 4, 'Ship date  . . .').field(10, 22, 8, { ffw: 0x4500 }).text(10, 32, 'YYYYMMDD', BLUE)
    .text(11, 4, 'Rush order . . .').field(11, 22, 1, { ffw: 0x4020 }).text(11, 30, 'Y=Yes, N=No', BLUE)
    .text(22, 2, 'F3=Exit   F12=Cancel', BLUE);
  if (message) s.text(24, 2, message);
  return s.cursor(6, 22).readMdt().build();
}

/** Customers with a bill-to and a ship-to address, for the map component demo. */
export const CUSTOMERS = [
  {
    number: '000123', name: 'Lakeside Hardware',
    bill: ['233 S Wacker Dr', 'Chicago', 'IL', '60606'],
    ship: ['1060 W Addison St', 'Chicago', 'IL', '60613'],
  },
  {
    number: '000456', name: 'Harbor Supply Co',
    bill: ['1 Ferry Building', 'San Francisco', 'CA', '94111'],
    ship: ['24 Willie Mays Plaza', 'San Francisco', 'CA', '94107'],
  },
  {
    number: '000789', name: 'Capitol Office Goods',
    bill: ['1600 Pennsylvania Ave NW', 'Washington', 'DC', '20500'],
    ship: ['350 Fifth Avenue', 'New York', 'NY', '10118'],
  },
];

/**
 * Customer addresses: bill-to on the left, ship-to on the right. The street is
 * at column 4 or 44 of row 8, the city at row 9, then state and ZIP code.
 */
export function customerAddresses(index: number, message?: string): number[] {
  const c = CUSTOMERS[index]!;
  const s = new HostStream().clear().write()
    .text(1, 2, 'CUS200')
    .text(1, 31, 'Customer Addresses', WHITE)
    .text(2, 2, 'Type a customer number, press Enter. Page Down for the next customer.', BLUE)
    .text(4, 2, 'Customer . . . .').field(4, 22, 6, { value: c.number })
    .text(4, 30, c.name, WHITE)
    .text(6, 4, 'Bill to', WHITE).text(6, 44, 'Ship to', WHITE);
  for (const [col, a] of [[4, c.bill], [44, c.ship]] as const) {
    s.text(8, col, a[0]).text(9, col, a[1]).text(10, col, a[2]).text(10, col + 4, a[3]);
  }
  s.text(22, 2, 'F3=Exit   F12=Cancel', BLUE);
  if (message) s.text(24, 2, message);
  return s.cursor(4, 22).readMdt().build();
}

/** Help text for the order entry screen, by the row of the field, in pages of lines. */
const ORDER_HELP: Record<string, string[][]> = {
  order: [['Order Entry - Help', '', 'Type the details of a new order, then press', 'Enter to place it. F12 goes back to the menu.']],
  6: [['Customer - Help', '', 'The number of the customer placing the order.', 'It is required: the order cannot be placed', 'without one.']],
  7: [['State - Help', '', 'The two-letter code of the state the order', 'ships to, such as CA or TX.']],
  8: [
    ['Quantity - Help', '', 'How many items to ship. Type a negative number', 'for a return: -5, or 5- as on a 5250. The', 'number is whole: there are no decimal places.'],
    ['Quantity - Help', '', 'Returns are credited when the goods arrive back', 'at the warehouse.', '', 'Large orders (over 1,000) are checked by a', 'supervisor before they ship.'],
  ],
  9: [['Item code - Help', '', 'The three-digit code from the catalog. The order', 'is placed as soon as all three digits are typed.']],
  10: [['Ship date - Help', '', 'The date to ship the order, as YYYYMMDD.', 'Leave it blank to ship as soon as possible.']],
  11: [['Rush order - Help', '', 'Y ships the order overnight, for an extra charge.', 'N ships it with the standard service.']],
};

/** A UIM-style help window over the order entry screen. */
function helpWindow(topic: string, page: number): number[] {
  const pages = ORDER_HELP[topic] ?? ORDER_HELP.order!;
  const lines = pages[page]!;
  const s = new HostStream().write().text(12, 8, '.'.repeat(58), BLUE);
  for (let r = 13; r <= 21; r++) s.text(r, 8, ':', BLUE).fill(r, 10, 54).text(r, 65, ':', BLUE);
  s.text(22, 8, ':' + '.'.repeat(56) + ':', BLUE);
  lines.forEach((line, i) => s.text(13 + i, 11, line, i === 0 ? WHITE : undefined));
  return s.text(20, 55, page + 1 < pages.length ? 'More...' : 'Bottom')
    .text(21, 11, 'F2=Extended help   F12=Cancel', BLUE)
    .cursor(13, 11).build();
}

const MENU_HELP: string[][] = [
  [
    'The main menu lists what you can do. Type the number of an option',
    'on the command line and press Enter, or click it.',
    '',
    'You can also type a command, such as WRKACTJOB, and press Enter.',
  ],
  [
    'Option 2 opens the order entry screen, which shows how Veneer checks',
    'fields before they are sent: required fields, numbers and dates.',
    '',
    'Option 9 opens a pop-up window over the menu.',
  ],
];

/** Full-screen help for the main menu. */
function menuHelp(page: number): number[] {
  const s = new HostStream().clear().write().text(1, 32, 'Main Menu - Help', WHITE);
  MENU_HELP[page]!.forEach((line, i) => s.text(3 + i, 2, line));
  return s.text(20, 73, page + 1 < MENU_HELP.length ? 'More...' : 'Bottom')
    .text(22, 2, 'F3=Exit help   F12=Cancel', BLUE)
    .cursor(1, 1).build();
}

/** Decode a signed numeric field as sent: a D zone on the last digit means negative. */
function decodeSigned(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (!t) return '0';
  const last = t.at(-1)!;
  const negIndex = '}JKLMNOPQR'.indexOf(last);
  return negIndex >= 0 ? `-${t.slice(0, -1)}${negIndex}` : t;
}

/** A prompt window over the main menu, drawn with border characters as IBM i does. */
function menuWindow(): number[] {
  const s = new HostStream().write()
    .text(7, 18, '.... Display a Menu ' + '.'.repeat(26), BLUE);
  // Like IBM i, blank the interior first so the screen underneath does not show through.
  for (let r = 8; r <= 15; r++) s.text(r, 18, ':', BLUE).fill(r, 20, 42).text(r, 63, ':', BLUE);
  return s.text(16, 18, ':' + '.'.repeat(44) + ':', BLUE)
    .text(9, 21, 'Type choice, press Enter.', BLUE)
    .text(11, 21, 'Menu . . . . . .')
    .field(11, 38, 10, { ffw: 0x4020 })
    .text(11, 50, 'Name', BLUE)
    .text(12, 21, 'Library  . . . .')
    .field(12, 38, 10, { ffw: 0x4020, value: '*LIBL' })
    .text(15, 21, 'F4=Prompt   F12=Cancel', BLUE)
    .cursor(11, 38).readMdt().build();
}

function mainMenu(user: string, message?: string): number[] {
  return new HostStream().clear().write()
    .text(1, 2, 'MAIN')
    .text(1, 33, 'IBM i Main Menu', WHITE)
    .text(1, 64, 'System:   VENEER')
    .text(3, 2, 'Select one of the following:')
    .text(5, 6, '1. User tasks')
    .text(6, 6, '2. Order entry (field rules demo)')
    .text(7, 6, '3. Customer addresses (map demo)')
    .text(8, 6, '4. Files, libraries, and folders')
    .text(10, 6, '6. Communications')
    .text(12, 6, '8. Problem handling')
    .text(13, 6, '9. Display a menu')
    .text(14, 5, '10. Information Assistant options')
    .text(15, 5, '11. IBM i Access tasks')
    .text(17, 5, '90. Sign off')
    .text(19, 2, 'Selection or command')
    .text(20, 2, '===>')
    .field(20, 7, 70)
    .text(22, 2, 'F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel   F13=Information Assistant', BLUE)
    .text(23, 2, 'F23=Set initial menu', BLUE)
    .text(24, 2, message ?? `Signed on as ${user}. Try option 1, option 9, or the command WRKACTJOB.`)
    .cursor(20, 7).readMdt().build();
}

function jobs(page: number, message?: string): number[] {
  const s = new HostStream().clear().write()
    .text(1, 30, 'Work with Active Jobs', WHITE)
    .text(1, 72, 'VENEER')
    .text(3, 52, '10/23/26  11:42:07 CDT')
    .text(4, 2, 'CPU %:     4.7     Elapsed time:   00:12:31     Active jobs:   ' + JOBS.length)
    .text(6, 2, 'Type options, press Enter.', BLUE)
    .text(7, 3, '2=Change   3=Hold   4=End   5=Work with   6=Release   7=Display message', BLUE)
    .text(8, 3, '8=Work with spooled files   13=Disconnect ...', BLUE)
    .text(10, 2, 'Opt  Subsystem/Job  User        Type  CPU %  Function        Status', WHITE);
  const slice = JOBS.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  slice.forEach(([job, user, type, cpu, fn, status], i) => {
    const row = 11 + i;
    const sub = type === 'SBS';
    s.field(row, 3, 2)
      .text(row, sub ? 7 : 9, job!)
      .text(row, 22, user!.padEnd(11) + ' ' + type!)
      .text(row, 45 - cpu!.length, cpu!);
    if (fn) s.text(row, 47, fn);
    s.text(row, 63, status!);
  });
  const last = (page + 1) * PAGE_SIZE >= JOBS.length;
  s.text(20, 73, last ? 'Bottom' : 'More...')
    .text(21, 2, 'Parameters or command')
    .text(22, 2, '===>')
    .field(22, 7, 73)
    .text(23, 2, 'F3=Exit   F5=Refresh   F7=Find   F10=Restart statistics   F12=Cancel', BLUE);
  if (message) s.text(24, 2, message);
  return s.cursor(11, 3).readMdt().build();
}

/** Split inbound bytes into 5250 records, dropping Telnet negotiation. */
function onRecords(socket: net.Socket, onRecord: (rec: Buffer) => void): void {
  let pending: number[] = [];
  let skip = 0, inSub = false, iac = false;
  socket.on('data', (chunk) => {
    for (const b of chunk) {
      if (skip > 0) { skip--; continue; }
      if (iac) {
        iac = false;
        if (b === IAC) { if (!inSub) pending.push(b); }
        else if (b === 0xef) { onRecord(Buffer.from(pending)); pending = []; }
        else if (b >= 0xfb && b <= 0xfe) skip = 1;
        else if (b === 0xfa) inSub = true;
        else if (b === 0xf0) inSub = false;
        continue;
      }
      if (b === IAC) iac = true;
      else if (!inSub) pending.push(b);
    }
  });
}

/** Parse "SBA row col data..." entries from a Read MDT Fields response. */
function parseFields(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length && data[i] === 0x11) {
    const row = data[i + 1]!, col = data[i + 2]!;
    let j = i + 3;
    while (j < data.length && data[j] !== 0x11) j++;
    out.set(`${row}:${col}`, cp.decode(data.subarray(i + 3, j)));
    i = j;
  }
  return out;
}

function send(socket: net.Socket, stream: number[]): void {
  const out: number[] = [];
  for (const b of buildRecord(0x03, stream)) { out.push(b); if (b === IAC) out.push(IAC); }
  const bytes = Buffer.from([...out, IAC, 0xef]);
  if (DELAY_MS > 0) setTimeout(() => socket.write(bytes), DELAY_MS);
  else socket.write(bytes);
}
