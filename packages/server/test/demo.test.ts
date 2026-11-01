// The demo's screen definitions (dev/screens) still fit the demo host's
// screens, and the map demo reads the addresses the host shows.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { matchScreen, validateDefinition, type ScreenDefinition } from '@veneer/screens';
import { Terminal, buildRecord, getCodepage, snapshot, type ScreenSnapshot } from '@veneer/tn5250';
import * as map from '../dev/components/map.js';
import { CUSTOMERS, customerAddresses, orderEntry } from '../dev/demoHost.ts';

const cp = getCodepage(37);
const screensDir = new URL('../dev/screens/', import.meta.url);

function screen(stream: number[]): ScreenSnapshot {
  const t = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
  t.processRecord(buildRecord(0x03, stream));
  return snapshot(t.screen, cp);
}

const definitions: ScreenDefinition[] = fs.readdirSync(screensDir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('global'))
  .map((f) => validateDefinition(JSON.parse(fs.readFileSync(new URL(f, screensDir), 'utf8'))));

test('every demo definition is valid', () => {
  assert.ok(definitions.length >= 2);
});

test('the order entry definition matches the order entry screen', () => {
  assert.equal(matchScreen(screen(orderEntry()), definitions)?.id, 'demo-order-entry');
});

test('the customer addresses definition matches every customer', () => {
  CUSTOMERS.forEach((_, i) => assert.equal(matchScreen(screen(customerAddresses(i)), definitions)?.id, 'demo-customer-addresses'));
});

test('its two maps read each customer\'s bill-to and ship-to addresses', () => {
  const def = definitions.find((d) => d.id === 'demo-customer-addresses')!;
  const maps = def.changes.filter((c) => c.op === 'component' && c.name === 'map');
  assert.equal(maps.length, 2);
  CUSTOMERS.forEach((customer, i) => {
    const snap = screen(customerAddresses(i));
    const read = (options: unknown) => map.readAddress({
      options,
      screen: { lines: snap.lines, fields: snap.fields.map((f) => ({ id: f.id, row: f.row, col: f.col, length: f.length, value: f.value })) },
      getField: () => undefined,
    });
    const [bill, ship] = maps.map((m) => read((m as { options?: unknown }).options));
    const expect = ([street, city, state, zip]: string[]) => `${street}, ${city}, ${state} ${zip}, USA`;
    assert.equal(bill, expect(customer.bill));
    assert.equal(ship, expect(customer.ship));
  });
});

test('the maps fit on the screen without covering the addresses', () => {
  const def = definitions.find((d) => d.id === 'demo-customer-addresses')!;
  for (const c of def.changes) {
    if (c.op !== 'component') continue;
    assert.ok(c.at.row > 10, 'below the addresses');
    assert.ok(c.at.row + c.height - 1 < 22, 'above the function keys');
    assert.ok(c.at.col + c.width - 1 <= 80, 'within 80 columns');
  }
});
