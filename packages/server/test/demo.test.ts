// The demo's screen definitions (dev/screens) still fit the demo host's
// screens: the map demo reads the addresses the host shows, and the cards demo
// shows the contacts list and runs its options against the demo host.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { matchScreen, validateDefinition, type ScreenDefinition } from '@veneer/screens';
import { Session, Terminal, buildRecord, getCodepage, snapshot, type ScreenSnapshot } from '@veneer/tn5250';
// The browser's view of a screen, as the client builds it for components.
import { tablesOf } from '../../client/src/custom/components.ts';
import { customize } from '../../client/src/transform/customize.ts';
import { transform } from '../../client/src/transform/index.ts';
import * as cards from '../dev/components/cards.js';
import * as map from '../dev/components/map.js';
import { CONTACTS, CONTACTS_PAGE, CUSTOMERS, DemoHost, NOTE_ROWS, SHIP_VIA, contacts, customerAddresses, orderEntry, shippingNotes } from '../dev/demoHost.ts';
import { stepValue } from '../../client/src/ui/spinner.ts';
import { fitText, textOf } from '../../client/src/ui/textArea.ts';

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

// ---- the cards demo

const contactsDef = () => definitions.find((d) => d.id === 'demo-contacts')!;
const cardSettings = () => cards.settings((contactsDef().changes.find((c) => c.op === 'component') as { options: unknown }).options);
/** The lists a component on the contacts screen sees. */
const contactTables = (snap: ScreenSnapshot) => tablesOf(customize(transform(snap), contactsDef()));

test('the contacts definition matches every page of contacts', () => {
  const pages = Math.ceil(CONTACTS.length / CONTACTS_PAGE);
  assert.ok(pages >= 2, 'the demo pages');
  for (let p = 0; p < pages; p++) assert.equal(matchScreen(screen(contacts(p)), definitions)?.id, 'demo-contacts');
});

test('the cards show the contacts in place of the hidden list, legend and More...', () => {
  const snap = screen(contacts(0));
  const view = customize(transform(snap), contactsDef());
  assert.equal(view.items.some((i) => i.kind === 'table'), false, 'the list is hidden');
  const drawn = JSON.stringify(view.items);
  assert.doesNotMatch(drawn, /2=Change|Type options|More/, 'so are its legend and marker');
  const [list] = tablesOf(view);
  assert.ok(list?.hidden);
  assert.deepEqual(list.options.map((o) => o.value), ['2', '4', '5']);
  const shown = cards.cardsOf(cards.pickTable([list], cardSettings()), cardSettings());
  assert.deepEqual(shown.map((c) => c.title), CONTACTS.slice(0, CONTACTS_PAGE).map((c) => c[0]));
  assert.equal(shown[0]!.subtitle, 'Lakeside Hardware');
  assert.deepEqual(shown[0]!.facts.map((f) => f.value), ['Chicago', '312-555-0142', 'Active']);
  assert.deepEqual(shown.map((c) => c.record.option), CONTACTS.slice(0, CONTACTS_PAGE).map((_, i) => `${7 + i}:3`));
  assert.equal(cards.defaultAction(list, cardSettings())?.label, 'Display');
});

test('the demo\'s style rules mark contacts on hold and inactive', () => {
  const shown = cards.cardsOf(contactTables(screen(contacts(0)))[0]!, cardSettings());
  const byName = new Map(shown.map((c) => [c.title, c.role]));
  assert.equal(byName.get('Priya Raman'), 'warning', 'on hold');
  assert.equal(byName.get('Aiko Tanaka'), 'muted', 'inactive');
  assert.equal(byName.get('Maria Gonzalez'), '');
});

test('the cards box covers the list and stays above the function keys', () => {
  const box = contactsDef().changes.find((c) => c.op === 'component')!;
  assert.ok(box.op === 'component');
  assert.ok(box.at.row <= 3 && box.at.row + box.height - 1 >= 15, 'from the legend to More...');
  assert.ok(box.at.row + box.height - 1 < 22);
  assert.ok(box.at.col + box.width - 1 <= 80);
});

test('against the demo host, a card\'s option and the pager do what the user would', async (t) => {
  const host = new DemoHost();
  const port = await host.listen();
  const session = new Session({ host: '127.0.0.1', port, connectTimeoutMs: 5000 });
  t.after(() => { session.close(); host.server.close(); });
  await session.connect();
  await session.waitForInput(5000);
  const send = async (aid: Parameters<Session['submit']>[0]['aid'], fields?: Record<string, string>) => {
    session.submit({ aid, ...(fields ? { fields } : {}) });
    return session.waitForInput(5000);
  };
  await send('Enter', { '6:53': 'DEMO' });
  let snap = await send('Enter', { '20:7': '4' });

  // What the component does, with ctx.press going to the host.
  const ctx = { press: (aid: Parameters<Session['submit']>[0]['aid'], fields?: Record<string, string>) => { pending = send(aid, fields); } };
  let pending: Promise<ScreenSnapshot> | undefined;
  const cardsNow = () => cards.cardsOf(contactTables(snap)[0]!, cardSettings());

  const james = cardsNow().find((c) => c.title === 'James Okafor')!;
  assert.equal(cards.run(ctx, james.record, '5'), true);
  snap = await pending!;
  assert.match(snap.lines[23]!, /Display James Okafor \(option 5\)/);

  ctx.press('PageDown');
  snap = await pending!;
  assert.deepEqual(cardsNow().map((c) => c.title), CONTACTS.slice(CONTACTS_PAGE).map((c) => c[0]));
  assert.equal(contactTables(snap)[0]!.more, false, 'no Next on the last page');

  const last = cardsNow().at(-1)!;
  cards.run(ctx, last.record, '2');
  snap = await pending!;
  assert.match(snap.lines[23]!, new RegExp(`Change ${CONTACTS.at(-1)![0]}`));

  ctx.press('PageUp');
  snap = await pending!;
  assert.equal(cardsNow()[0]!.title, 'Maria Gonzalez');
});

// ---- options 5 and 6: the same screens without the components

test('the plain customer addresses and contacts screens match no definition', () => {
  CUSTOMERS.forEach((_, i) => assert.equal(matchScreen(screen(customerAddresses(i, undefined, true)), definitions), undefined));
  for (let p = 0; p < Math.ceil(CONTACTS.length / CONTACTS_PAGE); p++) {
    assert.equal(matchScreen(screen(contacts(p, undefined, true)), definitions), undefined);
  }
});

test('the plain screens show the same data as the customized ones', () => {
  const body = (snap: ScreenSnapshot) => snap.lines.slice(1);
  assert.deepEqual(body(screen(customerAddresses(1, undefined, true))), body(screen(customerAddresses(1))));
  assert.deepEqual(body(screen(contacts(1, undefined, true))), body(screen(contacts(1))));
  assert.match(screen(contacts(0, undefined, true)).lines[0]!, /Work with Contacts \(no cards\)/);
  assert.match(screen(customerAddresses(0, undefined, true)).lines[0]!, /Customer Addresses \(no map\)/);
});

test('on the demo host, options 5 and 6 open the plain screens, and they page like the others', async (t) => {
  const host = new DemoHost();
  const port = await host.listen();
  const session = new Session({ host: '127.0.0.1', port, connectTimeoutMs: 5000 });
  t.after(() => { session.close(); host.server.close(); });
  await session.connect();
  await session.waitForInput(5000);
  const send = (aid: Parameters<Session['submit']>[0]['aid'], fields?: Record<string, string>) => {
    session.submit({ aid, ...(fields ? { fields } : {}) });
    return session.waitForInput(5000);
  };
  let snap = await send('Enter', { '6:53': 'DEMO' });
  assert.match(snap.lines.join('\n'), /5\. Customer addresses without the maps/);
  assert.match(snap.lines.join('\n'), /6\. Customer contacts without the cards/);

  snap = await send('Enter', { '20:7': '5' });
  assert.match(snap.lines[0]!, /\(no map\)/);
  snap = await send('PageDown');
  assert.match(snap.lines[0]!, /\(no map\)/, 'still plain after paging');
  assert.match(snap.lines[3]!, new RegExp(CUSTOMERS[1]!.name));
  await send('F3');

  snap = await send('Enter', { '20:7': '6' });
  assert.match(snap.lines[0]!, /\(no cards\)/);
  snap = await send('PageDown');
  assert.match(snap.lines[0]!, /\(no cards\)/);
  snap = await send('Enter', { [`7:3`]: '5' });
  assert.match(snap.lines[23]!, new RegExp(`Display ${CONTACTS[CONTACTS_PAGE]![0]}`));
  assert.match(snap.lines[0]!, /\(no cards\)/);
});

// ---- option 7: radio buttons, spinners and a text area

const shippingDef = () => definitions.find((d) => d.id === 'demo-shipping-notes')!;

test('the shipping notes definition shows its fields as radio buttons, spinners and a text area', () => {
  const snap = screen(shippingNotes());
  assert.equal(matchScreen(snap, definitions)?.id, 'demo-shipping-notes');
  const view = customize(transform(snap), shippingDef());
  const field = (id: string) => view.items.find((i) => i.kind === 'field' && i.field.id === id) as { widget?: { type: string; options?: Array<{ value: string }> }; parts?: Array<{ id: string; value: string }> } | undefined;
  const via = field('6:22')!.widget!;
  assert.equal(via.type, 'radio');
  assert.deepEqual(via.options!.map((o) => o.value), Object.keys(SHIP_VIA), 'every code the host knows');
  assert.equal(field('7:22')!.widget!.type, 'spinner');
  assert.equal(field('8:22')!.widget!.type, 'spinner');
  const notes = field('11:22')!;
  assert.deepEqual(notes.parts!.map((p) => p.id), NOTE_ROWS.map((r) => `${r}:22`));
  for (const r of NOTE_ROWS.slice(1)) assert.equal(field(`${r}:22`), undefined, 'under the text area');
  assert.match(textOf(notes.parts!.map((p) => p.value)), /^Leave at the loading dock if nobody is\nthere\. Call ahead on weekends\.\n\n$/);
});

test('on the demo host, the widgets send what typing would', async (t) => {
  const host = new DemoHost();
  const port = await host.listen();
  const session = new Session({ host: '127.0.0.1', port, connectTimeoutMs: 5000 });
  t.after(() => { session.close(); host.server.close(); });
  await session.connect();
  await session.waitForInput(5000);
  const send = async (aid: Parameters<Session['submit']>[0]['aid'], fields?: Record<string, string>) => {
    session.submit({ aid, ...(fields ? { fields } : {}) });
    return session.waitForInput(5000);
  };
  await send('Enter', { '6:53': 'DEMO' });
  let snap = await send('Enter', { '20:7': '7' });
  assert.match(snap.lines[0]!, /Shipping Notes/);
  const f = (id: string) => snap.fields.find((x) => x.id === id)!;
  const spin = (id: string, up: boolean) => {
    const w = shippingDef().changes.find((c) => c.op === 'widget' && c.field === id)!;
    return stepValue(f(id).value, f(id), (w as { widget: { min?: number; max?: number; step?: number } }).widget, up)!;
  };

  // A note typed on the third line, as the text area fits it.
  const parts = NOTE_ROWS.map((r) => f(`${r}:22`));
  const before = textOf(parts.map((p) => p.value));
  const typed = before.replace(/\n\n$/, '\nGate code 4471.\n');
  const fitted = fitText(typed, typed.length - 1, parts)!;
  const notes = Object.fromEntries(parts.flatMap((p, i) => (fitted.values[i] !== p.value ? [[p.id, fitted.values[i]!]] : [])));
  assert.deepEqual(Object.keys(notes), ['13:22'], 'only the changed line is sent');

  snap = await send('Enter', { '6:22': 'A', '7:22': spin('7:22', true), '8:22': spin('8:22', true), ...notes });
  assert.match(snap.lines[23]!, /Received: ship A \(Air\), cartons 4, weight 13\.0, 1 comment line changed/);

  // A comment the host rejects: shown again as typed, the cursor on the bad character.
  snap = await send('Enter', { '6:22': 'O', '13:22': 'Use door <B>' });
  assert.match(snap.lines[23]!, /Comments cannot contain < or > \(line 3\)/);
  assert.deepEqual(snap.cursor, { row: 13, col: 22 + 'Use door '.length });
  assert.equal(snap.fields.find((x) => x.id === '13:22')!.value, 'Use door <B>');
  assert.equal(snap.fields.find((x) => x.id === '6:22')!.value, 'O');
  assert.equal(snap.fields.find((x) => x.id === '11:22')!.value, 'Leave at the loading dock if nobody is', 'lines not sent keep the host\'s text');
});
