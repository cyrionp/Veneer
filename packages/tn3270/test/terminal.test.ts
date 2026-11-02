import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScreenSnapshot } from '@veneer/terminal';
import { ADDRESS_CODES, decodeAddress, encodeAddress } from '../src/address.ts';
import { Color, Highlight } from '../src/hostStream.ts';
import { aidByte } from '../src/keys.ts';
import { modelOf } from '../src/session.ts';
import { ProtocolError } from '../src/terminal.ts';
import { cp, e, makeTerminal, parseQueryReply, parseReadModified, signOn, stream } from './helpers.ts';

const ENTER = 0x7d;
const field = (snap: ScreenSnapshot, id: string) => snap.fields.find((f) => f.id === id)!;
/** The display attribute of one position. */
const attrAt = (snap: ScreenSnapshot, row: number, col: number) =>
  snap.segments[row - 1]!.findLast((s) => s.col <= col)!.attr;
const termField = (t: ReturnType<typeof makeTerminal>, row: number, col: number) =>
  t.terminal.screen.fields().find((f) => f.start === t.terminal.screen.address(row, col))!;

// ---- Addresses ----------------------------------------------------------

test('12-bit addresses go through the code table, 14-bit ones are binary', () => {
  assert.equal(ADDRESS_CODES.length, 64);
  assert.equal(new Set(ADDRESS_CODES).size, 64);
  assert.deepEqual(encodeAddress(0, 1920), [0x40, 0x40]);
  // Row 5, column 30 of 24x80 is 349 = 5 * 64 + 29.
  assert.deepEqual(encodeAddress(349, 1920), [0xc5, 0x5d]);
  assert.deepEqual(encodeAddress(1919, 1920), [0x5d, 0x7f]);
  for (let a = 0; a < 4096; a++) assert.equal(decodeAddress(...encodeAddress(a, 3564)), a);
  assert.equal(decodeAddress(0x0d, 0x70), 3440, '14-bit');
  assert.deepEqual(encodeAddress(5000, 6000), [0x13, 0x88]);
  assert.equal(decodeAddress(0x13, 0x88), 5000);
});

// ---- Writes and the snapshot -------------------------------------------

test('an Erase/Write draws text and fields; the snapshot is a 3270 screen', () => {
  const t = signOn();
  const snap = t.snap();
  assert.deepEqual(t.warnings, []);
  assert.equal(snap.host, '3270');
  assert.deepEqual([snap.rows, snap.cols], [24, 80]);
  assert.equal(snap.messageRow, undefined);
  assert.equal(snap.error, null);
  assert.equal(snap.keyboardLocked, false);
  assert.deepEqual(snap.cursor, { row: 5, col: 30 });
  assert.equal(snap.lines[0]!.trim(), 'Sign On');
  assert.match(snap.lines[4]!, /^ {9}User {16} {8} +$/);
  const inputs = snap.fields.filter((f) => !f.bypass);
  assert.deepEqual(inputs.map((f) => [f.id, f.length, f.numeric ?? false, f.attr.nonDisplay]), [
    ['5:30', 8, false, false], ['6:30', 8, false, true], ['7:30', 5, true, false],
  ]);
  assert.equal(field(snap, '5:10').value, 'User');
  assert.equal(field(snap, '5:10').bypass, true);
});

test('without extended colour, fields take the 3279 base colours', () => {
  const snap = signOn().snap();
  assert.equal(attrAt(snap, 1, 30).color, 'white', 'protected, intensified');
  assert.equal(attrAt(snap, 5, 10).color, 'blue', 'protected');
  assert.equal(attrAt(snap, 5, 30).color, 'green', 'input');
  const t = makeTerminal();
  t.host(stream().eraseWrite().at(2, 10).field({ attr: 0x08 }).chars('hot').build());
  assert.equal(attrAt(t.snap(), 2, 11).color, 'red', 'input, intensified');
});

test('the keyboard is locked until the host first writes, and after a key until a write restores it', () => {
  const t = makeTerminal();
  assert.equal(t.snap().keyboardLocked, true, 'waiting for the first screen');
  t.host(stream().eraseWrite({ restore: false }).text(1, 2, 'Hello').build());
  assert.equal(t.snap().keyboardLocked, false, 'any first write lets the user type');
  t.terminal.sendAid(ENTER);
  assert.equal(t.snap().keyboardLocked, true);
  t.host(stream().write({ restore: false }).at(2, 2).chars('Working').build());
  assert.equal(t.snap().keyboardLocked, true, 'a write without restore keeps it locked');
  t.host(stream().write().build());
  assert.equal(t.snap().keyboardLocked, false);
});

test('a Write starts at the cursor', () => {
  const t = signOn();
  t.host([0xf1, 0x02, ...e('HI')]);
  assert.equal(field(t.snap(), '5:30').value, 'HI');
});

test('a field can wrap from the end of the buffer to the start', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().at(24, 78).field({ attr: 0 }).chars('ABCD').at(1, 5).field({ attr: 0x20 }).build());
  const snap = t.snap();
  assert.deepEqual([field(snap, '24:79').length, field(snap, '24:79').value], [6, 'ABCD']);
  assert.equal(snap.lines[0]!.slice(0, 2), 'CD');
  t.terminal.setFieldValue(termField(t, 24, 79), 'ABCDEF');
  t.terminal.sendAid(ENTER);
  assert.deepEqual(parseReadModified(t.sent[0]!).fields, { '24:79': 'ABCDEF' });
});

test('one attribute makes one field of the rest of the buffer', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().at(1, 1).field({ attr: 0 }).build());
  assert.deepEqual(t.snap().fields.map((f) => [f.id, f.length]), [['1:2', 1919]]);
});

test('Erase/Write Alternate uses the model size; Erase/Write and Clear go back to 24x80', () => {
  const t = makeTerminal(5);
  t.host(stream().eraseWrite({ alternate: { rows: 27, cols: 132 } }).text(27, 120, 'Bottom right').cursor(27, 2).build());
  let snap = t.snap();
  assert.deepEqual([snap.rows, snap.cols], [27, 132]);
  assert.equal(snap.lines[26]!.trim(), 'Bottom right');
  assert.deepEqual(snap.cursor, { row: 27, col: 2 });
  t.terminal.sendAid(0x6d);
  assert.deepEqual(t.sent.at(-1), [0x6d], 'Clear sends only its AID');
  snap = t.snap();
  assert.deepEqual([snap.rows, snap.cols, snap.fields.length], [24, 80, 0], 'Clear blanks the screen at the default size');
  // Erase/Reset (a structured field) can pick either size.
  t.host([0xf3, 0x00, 0x04, 0x03, 0x80]);
  assert.deepEqual([t.snap().rows, t.snap().cols], [27, 132]);
  t.host([0xf3, 0x00, 0x04, 0x03, 0x00]);
  assert.deepEqual([t.snap().rows, t.snap().cols], [24, 80]);
});

test('model sizes come from the terminal type', () => {
  assert.equal(modelOf('IBM-3278-2-E'), 2);
  assert.equal(modelOf('IBM-3278-4'), 4);
  assert.equal(modelOf('IBM-3279-5-E'), 5);
  assert.throws(() => modelOf('IBM-3179-2'), /not supported/);
  assert.throws(() => modelOf('IBM-DYNAMIC'), /not supported/);
  const t = makeTerminal(4);
  assert.deepEqual(t.terminal.screen.alternate, { rows: 43, cols: 80 });
});

test('Start Field Extended sets colour, highlighting and validation', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite()
    .at(2, 10).field({ attr: 0, color: Color.YELLOW, highlight: Highlight.REVERSE, mandatoryEntry: true, mandatoryFill: true })
    .at(2, 20).field({ attr: 0x20, color: Color.TURQUOISE, highlight: Highlight.UNDERSCORE })
    .chars('Note')
    .at(2, 30).field({ attr: 0x20 })
    .build());
  const snap = t.snap();
  const input = field(snap, '2:11');
  assert.deepEqual([input.attr.color, input.attr.reverse, input.mandatoryEnter, input.adjust], ['yellow', true, true, 'mandatoryFill']);
  const note = field(snap, '2:21');
  assert.deepEqual([note.attr.color, note.attr.underline, note.mandatoryEnter, note.adjust], ['turquoise', true, false, undefined]);
});

test('non-display fields never show their contents', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().input(3, 10, 8, { attr: 0x0c, value: 'SECRET' }).build());
  const snap = t.snap();
  assert.equal(field(snap, '3:10').value, '');
  assert.equal(snap.lines[2]!.trim(), '');
});

test('Set Attribute colours characters until reset', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().at(3, 2).field({ attr: 0x20 })
    .chars('ab').charAttr('color', Color.RED).chars('cd').charAttr('highlight', Highlight.BLINK).chars('e')
    .charAttr('reset').chars('f').build());
  const snap = t.snap();
  // The attribute is at 3:2, so 'a' is at 3:3 and 'f' at 3:8.
  assert.deepEqual([3, 4, 5, 6, 7, 8].map((c) => attrAt(snap, 3, c).color), ['blue', 'blue', 'red', 'red', 'red', 'blue']);
  assert.deepEqual([6, 7, 8].map((c) => attrAt(snap, 3, c).blink), [false, true, false]);
});

test('Modify Field changes an attribute in place', () => {
  const t = signOn();
  t.host([0xf1, 0x02, 0x11, ...encodeAddress(t.terminal.screen.address(5, 29), 1920), 0x2c, 0x02, 0xc0, 0x20, 0x42, 0xf6, ...e('Z')]);
  const f = field(t.snap(), '5:30');
  assert.deepEqual([f.bypass, f.attr.color, f.value], [true, 'yellow', 'Z'], 'the address moves past the attribute');
  assert.deepEqual(t.warnings, []);
});

test('Repeat to Address fills up to the stop address, the whole buffer when they match', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().at(2, 1).repeat('-', 2, 11).bytes(0x3c, ...encodeAddress(200, 1920), 0x08, 0xad).build());
  let snap = t.snap();
  assert.equal(snap.lines[1]!.slice(0, 12), '----------' + cp.decodeChar(0xad).repeat(2));
  assert.equal(t.terminal.screen.buffer[199], 0xad, 'a GE character is stored as is');
  t.host(stream().eraseWrite().at(1, 1).repeat('x', 1, 1).build());
  snap = t.snap();
  assert.ok(snap.lines.every((l) => l === 'x'.repeat(80)));
});

test('Erase Unprotected to Address nulls input positions only', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().text(1, 2, 'Keep').input(2, 10, 5, { value: 'ABCDE' }).input(3, 10, 5, { value: 'FGHIJ' }).build());
  t.host(stream().write().at(1, 1).bytes(0x12, ...encodeAddress(t.terminal.screen.address(3, 1), 1920)).build());
  const snap = t.snap();
  assert.deepEqual(['1:2', '2:10', '3:10'].map((id) => field(snap, id).value), ['Keep', '', 'FGHIJ']);
});

test('Program Tab moves to the next input field, nulling the rest of a field it typed into', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().input(2, 10, 5, { value: '12345' }).input(4, 10, 5, { value: '67890' }).build());
  t.host(stream().write().at(2, 10).chars('AB').bytes(0x05).chars('X').build());
  let snap = t.snap();
  assert.deepEqual([field(snap, '2:10').value, field(snap, '4:10').value], ['AB', 'X7890']);
  // Straight after an order, PT only moves: the field it leaves keeps its text.
  t.host(stream().write().at(2, 10).chars('12345').build());
  t.host(stream().write().at(2, 12).bytes(0x05).chars('Y').build());
  snap = t.snap();
  assert.deepEqual([field(snap, '2:10').value, field(snap, '4:10').value], ['12345', 'Y7890']);
  // On an input field's attribute, PT steps onto the field.
  t.host(stream().write().at(2, 9).bytes(0x05).chars('Q').build());
  assert.equal(field(t.snap(), '2:10').value, 'Q2345');
});

test('Erase All Unprotected clears input, resets changes, restores the keyboard and homes the cursor', () => {
  const t = signOn();
  t.terminal.setFieldValue(termField(t, 5, 30), 'IBMUSER');
  t.terminal.screen.cursor = t.terminal.screen.address(7, 32);
  t.terminal.sendAid(ENTER);
  t.host([0x6f]);
  const snap = t.snap();
  assert.equal(field(snap, '5:30').value, '');
  assert.equal(field(snap, '5:30').modified, false);
  assert.equal(snap.keyboardLocked, false);
  assert.deepEqual(snap.cursor, { row: 5, col: 30 });
});

// ---- Keys and reads ------------------------------------------------------

test('Enter sends the AID, the cursor and only the changed fields, without nulls', () => {
  const t = signOn();
  const s = t.terminal.screen;
  assert.equal(t.terminal.setFieldValue(termField(t, 5, 30), 'IBMUSER'), true);
  assert.equal(t.terminal.setFieldValue(termField(t, 6, 30), 'secret'), true);
  assert.equal(t.terminal.setFieldValue(termField(t, 7, 30), ''), false, 'unchanged: not marked');
  s.cursor = s.address(6, 36);
  t.terminal.sendAid(ENTER);
  const sent = t.sent[0]!;
  assert.deepEqual(sent.slice(0, 6), [ENTER, ...encodeAddress(s.address(6, 36), 1920), 0x11, 0xc5, 0x5d]);
  assert.deepEqual(parseReadModified(sent), {
    aid: ENTER, cursor: { row: 6, col: 36 }, fields: { '5:30': 'IBMUSER', '6:30': 'secret' },
  });
  assert.ok(!sent.includes(0x00), 'nulls are left out');
});

test('a field the host sent as changed goes back even if the user left it', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().input(3, 10, 4, { value: 'KEEP', modified: true }).input(4, 10, 4).build());
  assert.equal(field(t.snap(), '3:10').modified, true);
  t.terminal.sendAid(ENTER);
  assert.deepEqual(parseReadModified(t.sent[0]!).fields, { '3:10': 'KEEP' });
  t.host(stream().write({ resetMdt: true }).build());
  assert.equal(field(t.snap(), '3:10').modified, false, 'the WCC can reset every change flag');
});

test('values are cut to the field, typed over what was there, and protected fields refuse them', () => {
  const t = signOn();
  t.terminal.setFieldValue(termField(t, 7, 30), '1234567');
  assert.equal(field(t.snap(), '7:30').value, '12345');
  t.terminal.setFieldValue(termField(t, 7, 30), '9');
  assert.equal(field(t.snap(), '7:30').value, '9');
  assert.throws(() => t.terminal.setFieldValue(termField(t, 5, 10), 'x'), ProtocolError);
});

test('PA keys and Clear send a short read', () => {
  for (const aid of [0x6c, 0x6e, 0x6b, 0x6d]) {
    const t = signOn();
    t.terminal.setFieldValue(termField(t, 5, 30), 'IBMUSER');
    t.terminal.sendAid(aid);
    assert.deepEqual(t.sent, [[aid]]);
  }
});

test('key names map to 3270 AIDs; 5250-only keys are refused', () => {
  assert.deepEqual(['Enter', 'Clear', 'PA1', 'PA2', 'PA3'].map((k) => aidByte(k as never)), [0x7d, 0x6d, 0x6c, 0x6e, 0x6b]);
  assert.deepEqual([1, 9, 10, 11, 12, 13, 21, 22, 23, 24].map((n) => aidByte(`F${n}` as never)),
    [0xf1, 0xf9, 0x7a, 0x7b, 0x7c, 0xc1, 0xc9, 0x4a, 0x4b, 0x4c]);
  for (const k of ['PageUp', 'PageDown', 'Help', 'Print', 'RecordBackspace']) {
    assert.throws(() => aidByte(k as never), /A 3270 has no/);
  }
});

test('the host can read the screen: Read Buffer, Read Modified and Read Modified All', () => {
  const t = signOn();
  t.host([0xf2]);
  const rb = t.sent[0]!;
  const attrs = t.terminal.screen.attrs.filter(Boolean).length;
  assert.equal(rb[0], 0x60, 'no key pressed yet');
  assert.equal(rb.length, 3 + 1920 + attrs, 'each attribute is an SF order and its byte');
  const title = 3 + t.terminal.screen.address(1, 29);
  assert.deepEqual(rb.slice(title, title + 2), [0x1d, ADDRESS_CODES[0x28]]);

  t.terminal.setFieldValue(termField(t, 5, 30), 'IBMUSER');
  t.host([0xf6]);
  assert.deepEqual(parseReadModified(t.sent[1]!).fields, { '5:30': 'IBMUSER' });
  t.terminal.sendAid(0x6c);
  t.host([0xf6]);
  assert.deepEqual(t.sent.at(-1), [0x6c], 'after PA1, Read Modified is a short read');
  t.host([0x6e]);
  assert.deepEqual(parseReadModified(t.sent.at(-1)!).fields, { '5:30': 'IBMUSER' }, 'Read Modified All sends fields anyway');
  t.host(stream().write().build());
  t.host([0xf6]);
  assert.equal(t.sent.at(-1)![0], 0x60, 'restoring the keyboard resets the AID');
});

test('an unformatted screen sends everything on it', () => {
  const t = makeTerminal();
  t.host(stream().eraseWrite().at(1, 1).chars('READY').cursor(2, 1).build());
  assert.equal(t.snap().fields.length, 0);
  t.terminal.writeText(t.terminal.screen.address(2, 1), 'LOGON IBMUSER');
  t.terminal.sendAid(ENTER);
  assert.deepEqual(t.sent[0], [ENTER, ...encodeAddress(80, 1920), ...e('READY'), ...e('LOGON IBMUSER')]);
});

// ---- Structured fields ---------------------------------------------------

test('Read Partition Query gets the query replies, sized for the model', () => {
  const t = makeTerminal(4, 1047);
  t.host([0xf3, 0x00, 0x05, 0x01, 0xff, 0x02]);
  const replies = parseQueryReply(t.sent[0]!);
  assert.deepEqual([...replies.keys()], [0x80, 0x81, 0x85, 0x86, 0x87, 0x88, 0xa6]);
  assert.deepEqual(replies.get(0x80), [0x80, 0x81, 0x85, 0x86, 0x87, 0x88, 0xa6], 'the summary lists them all');
  const usable = replies.get(0x81)!;
  assert.deepEqual(usable.slice(2, 6), [0x00, 80, 0x00, 43]);
  assert.deepEqual(usable.slice(-2), [3440 >> 8, 3440 & 0xff]);
  assert.deepEqual(replies.get(0xa6), [0x00, 0x00, 0x0b, 0x01, 0x00, 0, 80, 0, 24, 0, 80, 0, 43]);
  assert.deepEqual(replies.get(0x85)!.slice(12, 16), [0x02, 0xb9, 0x04, 0x17], 'GCSGID 697 with code page 1047');
  const color = replies.get(0x86)!;
  assert.deepEqual(color.slice(0, 4), [0x00, 0x08, 0x00, 0xf4]);
  assert.equal(color.length, 2 + 8 * 2);
  assert.deepEqual(replies.get(0x87), [0x05, 0x00, 0xf0, 0xf1, 0xf1, 0xf2, 0xf2, 0xf4, 0xf4, 0xf8, 0xf8]);
  assert.deepEqual(replies.get(0x88), [0x00]);
  assert.deepEqual(t.warnings, []);
});

test('Query List answers what was asked, or a null reply', () => {
  const t = makeTerminal();
  t.host([0xf3, 0x00, 0x07, 0x01, 0xff, 0x03, 0x00, 0x86]);
  assert.deepEqual([...parseQueryReply(t.sent[0]!).keys()], [0x86]);
  t.host([0xf3, 0x00, 0x07, 0x01, 0xff, 0x03, 0x00, 0x99]);
  assert.deepEqual([...parseQueryReply(t.sent[1]!).keys()], [0xff]);
  t.host([0xf3, 0x00, 0x06, 0x01, 0xff, 0x03, 0x80]);
  assert.equal(parseQueryReply(t.sent[2]!).size, 7, 'a request for all');
});

test('Outbound 3270DS carries a write; other structured fields are warned about', () => {
  const t = makeTerminal();
  const write = stream().eraseWrite().text(2, 2, 'Inside').build();
  const sf = [0x40, 0x00, ...write];
  t.host([0xf3, 0x00, sf.length + 2, ...sf]);
  assert.equal(t.snap().lines[1]!.trim(), 'Inside');
  assert.equal(t.snap().keyboardLocked, false);
  t.host([0xf3, 0x00, 0x05, 0x09, 0x00, 0x02]);
  t.host([0xf3, 0x00, 0x04, 0x4a, 0x00]);
  assert.deepEqual(t.warnings, ['Reply mode 0x2 is not supported; staying in field mode', 'Structured field 0x4a is not supported']);
});

test('bad data is warned about, not thrown', () => {
  const t = makeTerminal();
  t.host([0x99]);
  t.host([0xf1, 0x02, 0x11, 0x40]);
  t.host([0xf1, 0x02, 0x11, 0x0f, 0xa0]);
  t.host([0xf3, 0x00, 0x09, 0x01]);
  assert.deepEqual(t.warnings, [
    'Unknown 3270 command 0x99',
    'A write ends in the middle of an order',
    'Buffer address 4000 is outside the 24x80 screen',
    'A structured field has a bad length (9)',
  ]);
});

// ---- SSCP-LU -----------------------------------------------------------------

test('the SSCP-LU session shows plain text and takes plain text back', () => {
  const t = makeTerminal();
  t.terminal.processSscpLu(Uint8Array.from([...e('Welcome'), 0x15, ...e('Enter command:')]));
  let snap = t.snap();
  assert.equal(snap.lines[0]!.trim(), 'Welcome');
  assert.equal(snap.lines[1]!.trim(), 'Enter command:');
  assert.deepEqual(snap.cursor, { row: 2, col: 15 });
  assert.equal(snap.keyboardLocked, false);
  t.terminal.writeText(t.terminal.screen.cursor, 'LOGON APPLID(TSO)');
  assert.throws(() => t.terminal.sendAid(0xf1), /Only Enter and Clear/);
  t.terminal.sendAid(ENTER);
  assert.deepEqual(t.sscp, [e('LOGON APPLID(TSO)')], 'only what was typed after the host text');
  assert.deepEqual(t.sent, []);
  t.terminal.processSscpLu(Uint8Array.from(e('OK')));
  t.terminal.sendAid(0x6d);
  snap = t.snap();
  assert.equal(snap.lines.join('').trim(), '', 'Clear blanks the screen');
  assert.equal(t.sscp.length, 1, 'and sends nothing');
  // 3270 data means an application is in charge again.
  t.host(stream().eraseWrite().text(1, 2, 'CICS').build());
  assert.equal(t.terminal.sscpLu, false);
});

test('unbinding blanks the screen and locks the keyboard until the host writes', () => {
  const t = signOn();
  t.terminal.unbind();
  const snap = t.snap();
  assert.equal(snap.fields.length, 0);
  assert.equal(snap.keyboardLocked, true);
});
