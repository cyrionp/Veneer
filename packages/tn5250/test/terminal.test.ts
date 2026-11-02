import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshot } from '../src/screen.ts';
import { CLEAR, UNLOCK, cp, e, ic, makeTerminal, readMdt, sba, sf, wtd } from './helpers.ts';

// A small sign-on-like screen: a title, a user field and a hidden password field.
function signOn() {
  const t = makeTerminal();
  t.host([
    ...CLEAR,
    ...wtd(0x00, UNLOCK,
      ...sba(1, 35), 0x22, ...e('Sign On'), 0x20,
      ...sba(6, 17), ...e('User'),
      ...sba(6, 52), ...sf(0x4000, 0x24, 10), ...sba(6, 63), 0x20,
      ...sba(7, 17), ...e('Password'),
      ...sba(7, 52), ...sf(0x4000, 0x27, 10), ...sba(7, 63), 0x20,
      ...ic(6, 53)),
    ...readMdt(),
  ]);
  return t;
}

test('renders text, fields, attributes and cursor', () => {
  const { terminal, warnings } = signOn();
  const snap = snapshot(terminal.screen, cp);
  assert.deepEqual(warnings, []);
  assert.equal(snap.lines[0]!.trim(), 'Sign On');
  assert.match(snap.lines[5]!, /^\s+User\s+$/);
  assert.equal(snap.keyboardLocked, false);
  assert.deepEqual(snap.cursor, { row: 6, col: 53 });
  assert.equal(snap.host, '5250');
  assert.equal(snap.messageRow, 24);
  assert.deepEqual(snap.fields.map((f) => [f.id, f.length, f.attr.nonDisplay]), [
    ['6:53', 10, false], ['7:53', 10, true],
  ]);
  const title = snap.segments[0]!.find((s) => s.text.includes('Sign On'))!;
  assert.equal(title.attr.color, 'white');
  assert.ok(snap.fields[0]!.attr.underline);
});

test('sends cursor, AID and modified fields for Read MDT Fields', () => {
  const { terminal, sent } = signOn();
  const [user, pass] = terminal.screen.fields;
  terminal.setFieldValue(user!, 'qsecofr');
  terminal.setFieldValue(pass!, 'secret');
  terminal.sendAid(0xf1);
  const data = [...sent[0]!.subarray(10)];
  assert.equal(sent[0]![9], 0x03, 'Put/Get opcode');
  assert.deepEqual(data, [6, 53, 0xf1,
    0x11, 6, 53, ...e('qsecofr'),
    0x11, 7, 53, ...e('secret')]);
  assert.ok(terminal.screen.keyboardLocked);
});

test('applies monocase and right-adjust rules', () => {
  const t = makeTerminal();
  t.host([...CLEAR,
    ...wtd(0x00, UNLOCK, ...sba(2, 2), ...sf(0x4020, 0x20, 5), ...sba(3, 2), ...sf(0x4305, 0x20, 5)),
    ...readMdt()]);
  const [upper, num] = t.terminal.screen.fields;
  t.terminal.setFieldValue(upper!, 'abc');
  t.terminal.setFieldValue(num!, '42');
  const snap = snapshot(t.terminal.screen, cp);
  assert.equal(snap.fields[0]!.value, 'ABC');
  assert.equal(snap.fields[1]!.value, '00042');
});

test('only changed values set MDT', () => {
  const { terminal, sent } = signOn();
  terminal.setFieldValue(terminal.screen.fields[0]!, '');
  terminal.sendAid(0xf1);
  assert.deepEqual([...sent[0]!.subarray(10)], [6, 53, 0xf1]);
});

test('first SF after a read replaces the format table', () => {
  const t = signOn();
  t.terminal.sendAid(0xf1);
  t.host([...wtd(0x00, UNLOCK, ...sba(10, 10), ...sf(0x4000, 0x20, 4)), ...readMdt()]);
  assert.deepEqual(snapshot(t.terminal.screen, cp).fields.map((f) => f.id), ['10:11']);
});

test('write error code locks the keyboard until reset restores the line', () => {
  const t = signOn();
  t.host([0x04, 0x21, 0x22, ...e('Password not correct'), 0x20]);
  let snap = snapshot(t.terminal.screen, cp);
  assert.equal(snap.error, 'Password not correct');
  assert.ok(snap.keyboardLocked);
  t.terminal.reset();
  snap = snapshot(t.terminal.screen, cp);
  assert.equal(snap.error, null);
  assert.equal(snap.lines[23]!.trim(), '');
  assert.equal(snap.keyboardLocked, false);
});

test('answers the 5250 query', () => {
  const t = makeTerminal();
  t.host([0x04, 0xf3, 0x00, 0x05, 0xd9, 0x70, 0x00], 0x00);
  const reply = t.sent[0]!;
  assert.equal(reply.length, 10 + 61);
  assert.deepEqual([...reply.subarray(10, 17)], [0, 0, 0x88, 0x00, 58, 0xd9, 0x70]);
  assert.equal(cp.decode(reply.subarray(40, 44)), '3179');
  assert.equal(cp.decode(reply.subarray(44, 47)), '002');
});

test('save screen output restores the same screen', () => {
  const a = signOn();
  a.terminal.setFieldValue(a.terminal.screen.fields[0]!, 'BOB');
  a.host([0x04, 0x02], 0x04);
  const saved = a.sent[0]!;
  assert.equal(saved[9], 0x04);

  const b = makeTerminal();
  b.host([...saved.subarray(10)], 0x05);
  const sa = snapshot(a.terminal.screen, cp), sb = snapshot(b.terminal.screen, cp);
  assert.deepEqual(sb.lines, sa.lines);
  assert.deepEqual(sb.fields, sa.fields);
  assert.deepEqual(sb.cursor, sa.cursor);
});

test('cancel invite is echoed and clears the pending read', () => {
  const t = signOn();
  t.host([], 0x0a);
  assert.equal(t.sent[0]![9], 0x0a);
  assert.equal(t.terminal.readPending, false);
});

test('a short error message replaces the whole message line', () => {
  const t = signOn();
  t.host([...wtd(0x00, UNLOCK, ...sba(24, 2), ...e('A much longer informational message')), ...readMdt()]);
  t.host([0x04, 0x21, 0x22, ...e('Short error'), 0x20]);
  assert.equal(snapshot(t.terminal.screen, cp).error, 'Short error');
  t.terminal.reset();
  assert.equal(snapshot(t.terminal.screen, cp).lines[23]!.trim(), 'A much longer informational message');
});

// Signed numeric (shift 7) and numeric-only (shift 3) fields, blank fill.
function numericScreen() {
  const t = makeTerminal();
  t.host([...CLEAR,
    ...wtd(0x00, UNLOCK, ...sba(2, 2), ...sf(0x4706, 0x20, 6), ...sba(3, 2), ...sf(0x4306, 0x20, 5)),
    ...readMdt()]);
  return t;
}

test('signed numeric: right-adjusted digits, sign folded into the last digit when sent', () => {
  const { terminal, sent } = numericScreen();
  const [signed, numeric] = terminal.screen.fields;
  terminal.setFieldValue(signed!, '-123');
  terminal.setFieldValue(numeric!, '45');
  assert.equal(snapshot(terminal.screen, cp).fields[0]!.value, '123-');
  terminal.sendAid(0xf1);
  assert.deepEqual([...sent[0]!.subarray(13)], [
    0x11, 2, 3, 0x40, 0x40, 0xf1, 0xf2, 0xd3, // "  12" + 3 with D zone; sign position not sent
    0x11, 3, 3, 0x40, 0x40, 0x40, 0xf4, 0xf5,
  ]);
});

test('signed numeric takes digits only; IBM i rejects a decimal point (CPF0886, seen on PUB400)', () => {
  const { terminal } = numericScreen();
  const signed = terminal.screen.fields[0]!;
  assert.throws(() => terminal.setFieldValue(signed, '-1.5'), /digits only/);
  assert.throws(() => terminal.setFieldValue(signed, '1,5'), /digits only/);
  assert.equal(terminal.setFieldValue(signed, '15-'), true);
});

test('numeric-only: a negative value zones the last digit and displays with a minus', () => {
  const { terminal } = numericScreen();
  const numeric = terminal.screen.fields[1]!;
  terminal.setFieldValue(numeric, '7-');
  assert.deepEqual([...terminal.screen.fieldBytes(numeric)], [0x40, 0x40, 0x40, 0x40, 0xd7]);
  assert.equal(snapshot(terminal.screen, cp).fields[1]!.value, '7-');
});

test('reformatted but identical values do not mark a field modified', () => {
  const { terminal } = numericScreen();
  const signed = terminal.screen.fields[0]!;
  assert.equal(terminal.setFieldValue(signed, '123-'), true);
  assert.equal(terminal.setFieldValue(signed, '  -123 '), false);
  assert.equal(terminal.setFieldValue(signed, '123'), true, 'sign change is a change');
});

test('auto-enter fields are flagged in the snapshot', () => {
  const t = makeTerminal();
  t.host([...CLEAR, ...wtd(0x00, UNLOCK, ...sba(2, 2), ...sf(0x4080, 0x20, 2)), ...readMdt()]);
  assert.equal(snapshot(t.terminal.screen, cp).fields[0]!.autoEnter, true);
});

test('Clear Unit Alternate switches to 27x132 and addresses rows past 24', () => {
  const t = makeTerminal();
  t.host([0x04, 0x20, 0x00, ...wtd(0x00, UNLOCK, ...sba(27, 120), ...e('Bottom right'), ...sba(26, 2), ...sf(0x4000, 0x24, 100)), ...readMdt()]);
  const snap = snapshot(t.terminal.screen, cp);
  assert.equal(snap.rows, 27);
  assert.equal(snap.cols, 132);
  assert.equal(snap.lines[26]!.trim(), 'Bottom right');
  assert.equal(snap.fields[0]!.id, '26:3');
  assert.equal(snap.fields[0]!.length, 100);
});
