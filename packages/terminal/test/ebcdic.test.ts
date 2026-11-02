import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCodepage } from '../src/index.ts';

const cp = getCodepage(37);

test('round-trips printable text through CCSID 37', () => {
  const text = 'Sign On  System . . . : QPADEV0001 [a-z] {0-9} $@#|!¢¬';
  assert.equal(cp.decode(cp.encode(text)), text);
});

test('maps well-known code points', () => {
  assert.deepEqual(cp.encode('A1 '), [0xc1, 0xf1, 0x40]);
  assert.equal(cp.decodeChar(0x5b), '$');
  assert.equal(cp.decodeChar(0x22), ' ', 'attribute bytes display as blanks');
});

test('CCSID 1047 differs from 37 only in [ ] ^ ¬ Ý ¨', () => {
  const z = getCodepage(1047);
  assert.deepEqual(z.encode('[]^¬Ý¨'), [0xad, 0xbd, 0x5f, 0xb0, 0xba, 0xbb]);
  assert.deepEqual(cp.encode('[]^¬Ý¨'), [0xba, 0xbb, 0xb0, 0x5f, 0xad, 0xbd]);
  const text = 'LISTCAT ENT(\'SYS1.PROCLIB\') {a|b} $@#';
  assert.deepEqual(z.encode(text), cp.encode(text));
  assert.equal(z.decode(z.encode(text)), text);
});

test('unknown CCSIDs are refused', () => {
  assert.throws(() => getCodepage(9999), /CCSID 9999 is not registered/);
});
