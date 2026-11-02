import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { screenId } from '@veneer/screens';
import { type ScreenSnapshot } from '@veneer/terminal';
import { Attr, HostStream, Terminal, buildRecord, getCodepage, snapshot } from '@veneer/tn5250';
import { ScreenInventory } from '../src/inventory.ts';

const cp = getCodepage(37);

function screen(title: string, fieldRow = 5, value = ''): ScreenSnapshot {
  const t = new Terminal({ codepage: cp, terminalType: 'IBM-3179-2', sendRecord: () => {} });
  const s = new HostStream().clear().write().text(1, 33, title, Attr.WHITE).field(fieldRow, 20, 10);
  if (value) s.text(fieldRow, 40, value);
  t.processRecord(buildRecord(0x03, s.readMdt().build()));
  return snapshot(t.screen, cp);
}

test('counts arrivals per session, not redraws, and keeps no screen data', async () => {
  const inv = new ScreenInventory();
  const menu = screen('Main Menu');
  inv.record('s1', menu);
  inv.record('s1', screen('Main Menu', 5, 'CUSTOMER 123')); // same layout, new data: a redraw
  inv.record('s2', menu);
  inv.record('s1', screen('Orders', 7));
  inv.record('s1', menu);
  const byTitle = Object.fromEntries(inv.list().map((e) => [e.title, e]));
  assert.equal(byTitle['Main Menu']?.visits, 3);
  assert.equal(byTitle['Orders']?.visits, 1);
  assert.equal(byTitle['Main Menu']?.id, screenId(menu));
  assert.ok(!JSON.stringify(inv.list()).includes('CUSTOMER'), 'screen contents are not stored');

  inv.forget('s1');
  inv.record('s1', menu);
  assert.equal(inv.list().find((e) => e.title === 'Main Menu')?.visits, 4, 'a new session arriving counts');
});

test('saves to a file and loads it back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-inv-'));
  const file = path.join(dir, 'sub', 'inventory.json');
  const inv = new ScreenInventory(file);
  inv.record('s1', screen('Main Menu'));
  await inv.flush();
  const again = new ScreenInventory(file);
  await again.load();
  assert.equal(again.list()[0]?.title, 'Main Menu');
  again.clear();
  assert.equal(again.list().length, 0);
});
