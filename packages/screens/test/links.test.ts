import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostStream, Terminal, buildRecord, getCodepage, snapshot } from '@veneer/tn5250';
import { fillUrl, isWebTemplate, placeholders, validateDefinition } from '../src/index.ts';

const cp = getCodepage(37);
const t = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
t.processRecord(buildRecord(0x03, new HostStream().clear().write()
  .text(1, 30, 'Customer Details')
  .text(4, 2, 'Customer . . :').field(4, 18, 6, { value: '004521' })
  .text(6, 2, 'Address  . . :').text(6, 18, '1 Main St  Suite 4')
  .text(7, 2, 'City . . . . :').text(7, 18, 'Saint Louis')
  .text(8, 2, 'Tracking . . :').text(8, 18, '1Z999AA10123456784XYZ')
  .readMdt().build()));
const snap = snapshot(t.screen, cp);

test('fills fields and screen text, URL-encoded', () => {
  assert.equal(fillUrl('https://crm.example.com/customers/{4:18}', snap), 'https://crm.example.com/customers/004521');
  assert.equal(
    fillUrl('https://maps.example.com/?q={6:18}, {7:18}', snap),
    'https://maps.example.com/?q=1%20Main%20St,%20Saint%20Louis',
    'screen text stops at a double space',
  );
  assert.equal(fillUrl('https://track.example.com/{8:18:18}', snap), 'https://track.example.com/1Z999AA10123456784', 'fixed width');
});

test('typed but unsent field values win, and characters are escaped', () => {
  assert.equal(fillUrl('https://crm.example.com/c?id={4:18}', snap, { '4:18': 'A&B=1' }), 'https://crm.example.com/c?id=A%26B%3D1');
});

test('only http(s) with a fixed host', () => {
  assert.ok(isWebTemplate('https://example.com/{4:18}'));
  for (const bad of ['javascript:alert(1)', 'ftp://example.com/', 'https://{4:18}/x', '//example.com', 'http:/x']) {
    assert.equal(isWebTemplate(bad), false, bad);
    assert.equal(fillUrl(bad, snap), undefined, bad);
  }
  assert.deepEqual(placeholders('https://x.example/{4:18}/{8:18:10}'), [{ row: 4, col: 18 }, { row: 8, col: 18, length: 10 }]);
});

test('definitions validate URL buttons', () => {
  const base = { id: 'x', name: 'X', match: { text: [{ row: 1, col: 1, text: 'X' }] } };
  const ok = validateDefinition({ ...base, changes: [{ op: 'button', label: 'Map', action: { url: 'https://maps.example.com/?q={6:18}', aid: 'F3' } }] });
  assert.deepEqual(ok.changes[0], { op: 'button', label: 'Map', action: { url: 'https://maps.example.com/?q={6:18}' } });
  for (const [url, why] of [['javascript:alert(1)', /http/], ['https://{6:18}.example.com/', /host/], ['https://x.example/{44:1}', /screen position/]] as const) {
    assert.throws(() => validateDefinition({ ...base, changes: [{ op: 'button', label: 'L', action: { url } }] }), why);
  }
});
