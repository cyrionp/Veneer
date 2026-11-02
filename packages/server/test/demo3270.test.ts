// The 3270 demo host (dev/demoHost3270.ts), driven by the real tn3270 session:
// what the host receives is exactly what Veneer's 3270 sends, so these are
// also round-trip tests of the session against a host that behaves like one.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, type TestContext } from 'node:test';
import { matchScreen, validateDefinition, type ScreenDefinition } from '@veneer/screens';
import { getCodepage, type AidName, type ScreenSnapshot } from '@veneer/terminal';
import { Session, Terminal, encodeAddress, snapshot } from '@veneer/tn3270';
import { loadConfig } from '../src/config.ts';
// The browser's view of a screen.
import { customize } from '../../client/src/transform/customize.ts';
import { transform } from '../../client/src/transform/index.ts';
import { demoEnv, demoHostType } from '../dev/demoEnv.ts';
import {
  BASIC, CUSTOMERS, FIELDS, LOGON_LINES, ORDERS, DemoHost3270, capabilities, inquiry, logonScreen, menu, orders, ordersPerPage, signOn, update,
  type Capabilities,
} from '../dev/demoHost3270.ts';

const cp = getCodepage(37);
const e = (s: string) => cp.encode(s);
const SBA = 0x11;
const addr = (row: number, col: number, cols = 80, rows = 24) => encodeAddress((row - 1) * cols + (col - 1), rows * cols);

/** Connect a 3270 session to a fresh demo host; `go` presses a key and waits for the host's answer. */
async function connect(t: TestContext, opts: { tn3270e?: boolean; terminalType?: string; deviceName?: string } = {}) {
  const host = new DemoHost3270();
  const port = await host.listen();
  /** Host-to-terminal records, TN3270E header included when in use. */
  const fromHost: Buffer[] = [];
  const session = new Session({
    host: '127.0.0.1', port, tls: false, connectTimeoutMs: 5000, ...opts,
    trace: (direction, record) => { if (direction === 'in') fromHost.push(record); },
  });
  const warnings: string[] = [];
  session.on('warning', (w) => warnings.push(w));
  t.after(async () => { session.close(); await host.close(); });
  await session.connect();
  const first = await session.waitForInput(5000);
  const go = (aid: AidName, fields?: Record<string, string>) => {
    session.submit({ aid, ...(fields ? { fields } : {}) });
    return session.waitForInput(5000);
  };
  const conn = () => host.connections.at(-1)!;
  /** The last record the terminal sent. */
  const sent = () => conn().records.at(-1)!;
  /** The 3270 data of the last record the host wrote. */
  const lastWrite = () => { const r = fromHost.at(-1)!; return [...(session.tn3270e ? r.subarray(5) : r)]; };
  /** The TN3270E data types of the host's records so far: 0x00 3270 data, 0x03 BIND, 0x04 UNBIND, 0x07 SSCP-LU. */
  const types = () => fromHost.map((r) => r[0]!);
  return { host, session, first, go, conn, sent, lastWrite, types, warnings };
}

/** Log on with Enter alone and sign on as ALICE: the main menu. */
async function signedOn(t: TestContext, opts: Parameters<typeof connect>[1] = {}) {
  const c = await connect(t, opts);
  await c.go('Enter');
  const snap = await c.go('Enter', { [FIELDS.signOn.user]: 'alice', [FIELDS.signOn.password]: 'secret' });
  assert.match(snap.lines[0]!, /Main Menu/);
  return c;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

const at = (snap: ScreenSnapshot) => `${snap.cursor.row}:${snap.cursor.col}`;
const text = (snap: ScreenSnapshot) => snap.lines.join('\n');

// ---- Connecting and logging on

test('TN3270E: the logon screen is SSCP-LU text, then a BIND, a Query and the sign-on screen', async (t) => {
  const c = await connect(t, { deviceName: 'VENLU001' });
  assert.equal(c.session.tn3270e, true);
  assert.equal(c.conn().mode, 'tn3270e');
  assert.equal(c.conn().lu, 'VENLU001', 'the LU asked for');
  assert.equal(c.conn().terminalType, 'IBM-3278-2-E');
  assert.equal(c.first.fields.length, 0, 'no fields: plain text');
  assert.equal(c.first.lines[0]!.trim(), LOGON_LINES[0]);

  let snap = await c.go('Enter', { [at(c.first)]: 'logon applid(tso)' });
  assert.deepEqual(c.conn().sscp, ['logon applid(tso)'], 'only what was typed, as SSCP-LU data');
  assert.match(text(snap), /TSO is not an application here/);

  assert.deepEqual(c.types(), [0x07, 0x07], 'SSCP-LU data only, so far');
  snap = await c.go('Enter', { [at(snap)]: 'logon applid(demo)' });
  assert.match(snap.lines[0]!, /Sign On/);
  assert.deepEqual(c.types().slice(2), [0x03, 0x00, 0x00], 'BIND, the Query, the sign-on screen');
  assert.equal(c.conn().records[0]![0], 0x88, 'the query reply came first');
  assert.deepEqual(c.conn().caps, { extended: true, alternate: { rows: 24, cols: 80 } });
  // The terminal answers as soon as it has the screen, so the answer may still be on its way.
  await until(() => c.conn().responses.length > 0);
  assert.deepEqual(c.conn().responses.map((r) => r.positive), [true], 'the sign-on screen asked for a response and got a positive one');
  assert.deepEqual(c.warnings, []);
});

test('plain TN3270: the logon screen is an unformatted 3270 screen, and the LU goes as TYPE@LU', async (t) => {
  const c = await connect(t, { tn3270e: false, deviceName: 'VENLU002', terminalType: 'IBM-3278-3-E' });
  assert.equal(c.session.tn3270e, false);
  assert.equal(c.conn().mode, 'tn3270');
  assert.equal(c.conn().lu, 'VENLU002');
  assert.equal(c.conn().terminalType, 'IBM-3278-3-E');
  assert.equal(c.first.fields.length, 0);
  assert.equal(c.first.lines[1]!.trim(), LOGON_LINES[0]);

  const snap = await c.go('Enter', { [at(c.first)]: 'DEMO' });
  assert.match(snap.lines[0]!, /Sign On/);
  // An unformatted Read Modified: AID, cursor, then every character on the screen, nulls left out.
  const logon = c.conn().records[0]!;
  assert.equal(logon[0], 0x7d);
  assert.deepEqual(logon.slice(-4), e('DEMO'));
  assert.equal(cp.decode(logon.slice(3)), LOGON_LINES.join('') + 'DEMO');
  assert.deepEqual(c.conn().caps.alternate, { rows: 32, cols: 80 }, 'the size from the query reply');
  assert.deepEqual(c.conn().responses, [], 'no responses without TN3270E');
});

test('a terminal type the host does not take: TN3270E is refused and plain TN3270 is used', async (t) => {
  // The host takes only the -E (extended) types over TN3270E.
  const c = await connect(t, { terminalType: 'IBM-3278-2' });
  assert.equal(c.session.tn3270e, false);
  assert.equal(c.conn().mode, 'tn3270');
  assert.equal(c.first.fields.length, 0);
});

// ---- What the terminal sends

test('Enter sends exactly what a 3270 sends: AID, cursor, then SBA and data for each changed field', async (t) => {
  const c = await connect(t);
  await c.go('Enter');
  await c.go('Enter', { [FIELDS.signOn.user]: 'alice', [FIELDS.signOn.password]: 'secret' });
  assert.deepEqual(c.sent(), [
    0x7d, ...addr(7, 24),
    SBA, ...addr(7, 24), ...e('alice'),
    SBA, ...addr(8, 24), ...e('secret'),
  ]);
});

test('only changed fields are sent, plus the one the host sent as changed', async (t) => {
  const c = await signedOn(t);
  await c.go('Enter', { [FIELDS.menu.option]: '2' });
  let snap = await c.go('Enter', { [FIELDS.update.number]: '100200' });
  assert.equal(snap.fields.find((f) => f.id === FIELDS.update.name)!.value, 'Harbor Supply Co');
  assert.equal(at(snap), FIELDS.update.name, 'the cursor goes to the first detail');

  snap = await c.go('Enter', { [FIELDS.update.phone]: '415-555-0100' });
  assert.deepEqual(c.sent(), [
    0x7d, ...addr(6, 24),
    // The customer number comes back unasked: the host sent it with its modified flag on.
    SBA, ...addr(4, 24), ...e('100200'),
    SBA, ...addr(7, 24), ...e('415-555-0100'),
  ]);
  assert.match(snap.lines[22]!, /Customer 100200 updated: phone\./);

  // Nothing typed: only the customer number. After saving, the cursor is back on it.
  assert.equal(at(snap), FIELDS.update.number);
  snap = await c.go('Enter');
  assert.deepEqual(c.sent(), [0x7d, ...addr(4, 24), SBA, ...addr(4, 24), ...e('100200')]);
  assert.match(snap.lines[22]!, /Nothing was changed/);

  await c.go('F3');
  await c.go('Enter', { [FIELDS.menu.option]: '1' });
  snap = await c.go('Enter', { [FIELDS.inquiry.number]: '100200' });
  assert.match(text(snap), /415-555-0100/, 'the change was kept');
});

test('PA keys send only their AID (a short read), and PA2 puts the screen back as the host has it', async (t) => {
  const c = await signedOn(t);
  await c.go('Enter', { [FIELDS.menu.option]: '2' });
  await c.go('Enter', { [FIELDS.update.number]: '100100' });

  let snap = await c.go('PA1', { [FIELDS.update.name]: 'Typed but not sent' });
  assert.deepEqual(c.sent(), [0x6c]);
  assert.match(snap.lines[22]!, /PA1 sends no field data/);
  assert.equal(snap.fields.find((f) => f.id === FIELDS.update.name)!.value, 'Typed but not sent', 'still on the screen');

  snap = await c.go('PA2');
  assert.deepEqual(c.sent(), [0x6e]);
  assert.equal(snap.fields.find((f) => f.id === FIELDS.update.name)!.value, 'Lakeside Hardware', 'the typing is undone');
  assert.match(snap.lines[22]!, /Your changes were undone/);

  await c.go('PA3');
  assert.deepEqual(c.sent(), [0x6b]);
});

test('Clear sends only its AID and blanks the screen; Enter on the blank screen goes to the menu, LOGOFF logs off', async (t) => {
  const c = await signedOn(t);
  let snap = await c.go('Enter', { [FIELDS.menu.option]: '1' });
  snap = await c.go('Clear', { [FIELDS.inquiry.number]: '100100' });
  assert.deepEqual(c.sent(), [0x6d]);
  assert.equal(snap.fields.length, 0, 'unformatted');
  assert.equal(text(snap).trim(), '');
  assert.equal(snap.keyboardLocked, false, 'the host unlocked the keyboard');
  assert.deepEqual(snap.cursor, { row: 1, col: 1 });

  snap = await c.go('Enter');
  assert.deepEqual(c.sent(), [0x7d, ...addr(1, 1)], 'nothing typed');
  assert.match(snap.lines[0]!, /Main Menu/);

  await c.go('Clear');
  snap = await c.go('Enter', { '1:1': 'whatever' });
  assert.match(snap.lines[0]!, /WHATEVER is not a command here/);
  snap = await c.go('Enter', { '3:1': 'logoff' });
  assert.deepEqual(c.types().slice(-2), [0x04, 0x07], 'UNBIND, then SSCP-LU data');
  assert.equal(snap.fields.length, 0);
  assert.equal(snap.lines[0]!.trim(), LOGON_LINES[0], 'UNBIND, then the SSCP-LU logon screen');
  snap = await c.go('Enter');
  assert.match(snap.lines[0]!, /Sign On/, 'and logging on again works');
});

// ---- Errors, paging and screen sizes

test('a mistake: the alarm, a message, the field marked and the cursor on it, with what was typed kept', async (t) => {
  const c = await signedOn(t);
  await c.go('Enter', { [FIELDS.menu.option]: '2' });
  await c.go('Enter', { [FIELDS.update.number]: '100300' });

  let snap = await c.go('Enter', { [FIELDS.update.credit]: '12x' });
  const write = c.lastWrite();
  assert.equal(write[0], 0xf1, 'a Write, not an Erase/Write');
  assert.ok(write[1]! & 0x04, 'the alarm');
  assert.ok(write[1]! & 0x02, 'the keyboard is unlocked again');
  assert.match(snap.lines[22]!, /The credit limit is a whole number/);
  assert.equal(at(snap), FIELDS.update.credit);
  const credit = snap.fields.find((f) => f.id === FIELDS.update.credit)!;
  assert.equal(credit.value, '12x');
  assert.equal(credit.modified, true, 'sent again with the next key');
  assert.equal(credit.attr.color, 'red');
  assert.equal(credit.attr.reverse, true);

  snap = await c.go('Enter', { [FIELDS.update.credit]: '7500' });
  assert.match(snap.lines[22]!, /updated: credit limit/);
  assert.equal(snap.fields.find((f) => f.id === FIELDS.update.credit)!.attr.reverse, false, 'redrawn');

  snap = await c.go('Enter', { [FIELDS.update.name]: '' });
  assert.match(snap.lines[22]!, /Type a name/);
  assert.equal(at(snap), FIELDS.update.name);
  snap = await c.go('Enter', { [FIELDS.update.name]: 'Capitol Goods', [FIELDS.update.status]: 'x' });
  assert.match(snap.lines[22]!, /Type A \(active\)/);
  assert.equal(at(snap), FIELDS.update.status);
});

test('mistakes on the sign-on screen and the menu put the cursor on the field', async (t) => {
  const c = await connect(t);
  await c.go('Enter');
  let snap = await c.go('Enter');
  assert.match(snap.lines[22]!, /Type a user ID/);
  assert.equal(at(snap), FIELDS.signOn.user);
  snap = await c.go('Enter', { [FIELDS.signOn.user]: 'bob' });
  snap = await c.go('Enter', { [FIELDS.menu.option]: '7' });
  assert.match(snap.lines[22]!, /7 is not an option/);
  assert.equal(at(snap), FIELDS.menu.option);
  snap = await c.go('F6');
  assert.match(snap.lines[22]!, /PF6 is not used on this screen/);
});

test('the order list pages with PF7 and PF8 and says when there is no more', async (t) => {
  const c = await signedOn(t);
  let snap = await c.go('Enter', { [FIELDS.menu.option]: '3' });
  const perPage = ordersPerPage(24);
  assert.equal(snap.lines[5]!.slice(1, 7), ORDERS[0]!.number);
  snap = await c.go('F7');
  assert.match(snap.lines[22]!, /Already at the top/);
  snap = await c.go('F8');
  assert.equal(snap.lines[5]!.slice(1, 7), ORDERS[perPage]!.number);
  snap = await c.go('F8');
  assert.equal(snap.lines[5]!.slice(1, 7), ORDERS[perPage * 2]!.number);
  snap = await c.go('F8');
  assert.match(snap.lines[22]!, /Already at the bottom/);
  snap = await c.go('F7');
  assert.match(snap.lines[2]!, /Page 2 of 3/);
  snap = await c.go('F3');
  assert.match(snap.lines[0]!, /Main Menu/);
});

test('the alternate screen size: a model 5 gets the order list at 27x132 with more columns', async (t) => {
  const c = await signedOn(t, { terminalType: 'IBM-3278-5-E' });
  assert.deepEqual(c.conn().caps.alternate, { rows: 27, cols: 132 });
  let snap = await c.go('Enter', { [FIELDS.menu.option]: '3' });
  assert.equal(c.lastWrite()[0], 0x7e, 'Erase/Write Alternate');
  assert.equal(snap.rows, 27);
  assert.equal(snap.cols, 132);
  assert.match(snap.lines[4]!, /Ship via +Items +Sales rep/);
  assert.match(snap.lines[25]!, /^ *$/, 'no message');
  assert.match(snap.lines[26]!, /PF3=Return/);

  snap = await c.go('F8');
  assert.equal(snap.cols, 132, 'paging stays at the alternate size');
  // The cursor address in what the terminal sends is in the 27x132 buffer.
  assert.deepEqual(c.sent(), [0xf8, ...addr(27, 2, 132, 27)]);
  assert.equal(snap.lines[5]!.slice(1, 7), ORDERS[ordersPerPage(27)]!.number);

  snap = await c.go('F3');
  assert.equal(c.lastWrite()[0], 0xf5, 'Erase/Write: back to the default size');
  assert.deepEqual([snap.rows, snap.cols], [24, 80]);
});

test('a model 2 gets the order list at 24x80 with Erase/Write, and a model 4 at 43 rows', async (t) => {
  const two = await signedOn(t);
  let snap = await two.go('Enter', { [FIELDS.menu.option]: '3' });
  assert.equal(two.lastWrite()[0], 0xf5);
  assert.deepEqual([snap.rows, snap.cols], [24, 80]);
  assert.doesNotMatch(snap.lines[4]!, /Ship via/);

  const four = await signedOn(t, { terminalType: 'IBM-3278-4-E' });
  snap = await four.go('Enter', { [FIELDS.menu.option]: '3' });
  assert.deepEqual([snap.rows, snap.cols], [43, 80]);
  assert.equal(snap.lines[5 + ordersPerPage(43) - 1]!.slice(1, 7), ORDERS[ordersPerPage(43) - 1]!.number, 'more orders per page');
  assert.doesNotMatch(snap.lines[4]!, /Ship via/);
});

// ---- Colour and the query reply

test('colour and highlighting are used when the query reply offers them', () => {
  const caps: Capabilities = { extended: true, alternate: { rows: 24, cols: 80 } };
  const sfe = (stream: number[]) => stream.includes(0x29);
  assert.equal(sfe(signOn(BASIC)), false, 'basic attributes only');
  assert.equal(sfe(signOn(caps)), true);

  const reply = (codes: number[]) => [0x88, ...codes.flatMap((c) => [0x00, 0x04, 0x81, c])];
  assert.equal(capabilities(reply([0x80, 0x86, 0x87])).extended, true);
  assert.equal(capabilities(reply([0x80, 0x86])).extended, false, 'no highlighting');
  assert.deepEqual(capabilities(reply([0x80])).alternate, { rows: 24, cols: 80 }, 'no usable area: the default size');

  const snap = screen(signOn(caps));
  const user = snap.fields.find((f) => f.id === FIELDS.signOn.user)!;
  assert.equal(user.attr.color, 'yellow');
  assert.equal(user.attr.underline, true);
  assert.equal(user.mandatoryEnter, true);
  assert.equal(snap.fields.find((f) => f.id === FIELDS.signOn.password)!.attr.nonDisplay, true);
  const number = screen(update(caps)).fields.find((f) => f.id === FIELDS.update.number)!;
  assert.equal(number.numeric, true);
  assert.equal(number.adjust, 'mandatoryFill');
});

// ---- The demo's screen definitions

function screen(stream: number[], model = 2): ScreenSnapshot {
  const t = new Terminal({ codepage: cp, model, send3270: () => {}, sendSscpLu: () => {}, onWarning: (w) => { throw new Error(w); } });
  t.processRecord(Uint8Array.from(stream));
  return snapshot(t.screen, cp);
}

const screensDir = new URL('../dev/screens/', import.meta.url);
const definitions: ScreenDefinition[] = fs.readdirSync(screensDir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('global'))
  .map((f) => validateDefinition(JSON.parse(fs.readFileSync(new URL(f, screensDir), 'utf8'))));
const defs3270 = definitions.filter((d) => d.host === '3270');
const EXTENDED = (model: number): Capabilities => ({ extended: true, alternate: { 2: { rows: 24, cols: 80 }, 3: { rows: 32, cols: 80 }, 4: { rows: 43, cols: 80 }, 5: { rows: 27, cols: 132 } }[model]! });

test('the 3270 demo definitions are for 3270 and match their screens', () => {
  assert.deepEqual(defs3270.map((d) => d.id).sort(), ['demo-3270-order-list', 'demo-3270-update-customer']);
  for (const c of CUSTOMERS) assert.equal(matchScreen(screen(update(EXTENDED(2), c)), definitions)?.id, 'demo-3270-update-customer');
  assert.equal(matchScreen(screen(update(EXTENDED(2))), definitions), undefined, 'not the empty form, which has none of the fields');
  for (const model of [2, 3, 4, 5]) {
    const pages = Math.ceil(ORDERS.length / ordersPerPage(EXTENDED(model).alternate.rows));
    for (let p = 0; p < pages; p++) assert.equal(matchScreen(screen(orders(EXTENDED(model), p), model), definitions)?.id, 'demo-3270-order-list', `model ${model} page ${p + 1}`);
  }
  for (const other of [signOn(EXTENDED(2)), menu(EXTENDED(2), 'A'), inquiry(EXTENDED(2), CUSTOMERS[0])]) {
    assert.equal(matchScreen(screen(other), definitions), undefined);
  }
});

test('the update definition\'s widgets sit on input fields that suit them', () => {
  const def = defs3270.find((d) => d.id === 'demo-3270-update-customer')!;
  const snap = screen(update(EXTENDED(2), CUSTOMERS[0]));
  for (const change of def.changes) {
    if (change.op !== 'widget') continue;
    const field = snap.fields.find((f) => f.id === change.field);
    assert.ok(field && !field.bypass, `${change.field} is an input field`);
    if (change.widget.type === 'spinner') assert.equal(field.numeric, true, 'a spinner on a numeric field');
    if (change.widget.type === 'radio') {
      assert.deepEqual(change.widget.options.map((o) => o.value), ['A', 'H', 'I']);
      assert.ok(change.widget.options.every((o) => o.value.length <= field.length));
    }
  }
  // The radio buttons replace the A/H/I legend: none of it may show through.
  assert.match(text(screen(update(EXTENDED(2), CUSTOMERS[0]))), /A=Active {2}H=On hold {2}I=Inactive/);
  const drawn = JSON.stringify(customize(transform(snap), def).items.filter((i) => !('hidden' in i && i.hidden)));
  assert.doesNotMatch(drawn, /=Active|=On hold|=Inactive/);
});

test('mandatory entry is on fields the user has to type, not ones the host fills in', () => {
  const loaded = screen(update(EXTENDED(2), CUSTOMERS[0]));
  const mandatory = loaded.fields.filter((f) => f.mandatoryEnter);
  assert.deepEqual(mandatory.map((f) => f.id), [FIELDS.update.number]);
  assert.equal(mandatory[0]!.modified, true, 'and that one is already entered once a customer is loaded');
  assert.equal(screen(update(EXTENDED(2))).fields.find((f) => f.id === FIELDS.update.number)!.modified, false, 'until then it must be typed');
});

// ---- Choosing the demo host

test('npm run demo -- --3270 or VENEER_HOST_TYPE=3270 picks the demo mainframe', () => {
  assert.equal(demoHostType([], {}), '5250');
  assert.equal(demoHostType(['--3270'], {}), '3270');
  assert.equal(demoHostType([], { VENEER_HOST_TYPE: '3270' }), '3270');

  const env = { VENEER_HOST: 'myibmi.example.com', VENEER_TERMINAL_TYPE: 'IBM-3179-2', VENEER_DEVNAME_PREFIX: 'VENEERSX', VENEER_TN3270E: 'false' };
  const as3270 = loadConfig(demoEnv('3270', 2323, env));
  assert.equal(as3270.host.type, '3270');
  assert.equal(as3270.host.host, '127.0.0.1');
  assert.equal(as3270.host.port, 2323);
  assert.equal(as3270.host.terminalType, undefined, 'a 5250 terminal type is dropped');
  assert.equal(as3270.host.tn3270e, false, 'kept');
  assert.equal(as3270.deviceNamePrefix, undefined, 'too long for an LU name');

  const as5250 = loadConfig(demoEnv('5250', 2323, { ...env, VENEER_HOST_TYPE: '3270', VENEER_TERMINAL_TYPE: 'IBM-3278-5-E' }));
  assert.equal(as5250.host.type, '5250');
  assert.equal(as5250.host.terminalType, undefined, 'a 3270 terminal type is dropped');
  assert.equal(as5250.deviceNamePrefix, 'VENEERSX');
  assert.equal(loadConfig(demoEnv('3270', 1, { VENEER_TERMINAL_TYPE: 'IBM-3278-5-E' })).host.terminalType, 'IBM-3278-5-E');
});

test('the demo is ours: no IBM product names or message ids on its screens', () => {
  const caps = EXTENDED(5);
  const screens = [
    screen(logonScreen('X')), screen(signOn(caps)), screen(menu(caps, 'A')),
    screen(inquiry(caps, CUSTOMERS[0])), screen(update(caps, CUSTOMERS[0])), screen(orders(caps, 0), 5),
  ];
  for (const snap of screens) {
    assert.doesNotMatch(text(snap), /\b(IBM|CICS|VTAM|TSO|ISPF|IMS|z\/OS)\b/);
    assert.doesNotMatch(text(snap), /\b[A-Z]{3,4}\d{3,5}[A-Z]?\b/, 'message ids such as ABC1234E');
  }
});
