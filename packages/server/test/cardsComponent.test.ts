// The cards component (dev/components/cards.js): its options, which list and
// columns it shows, and what it draws and presses, against a small fake DOM.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import * as cards from '../dev/components/cards.js';

// ---- lists as ctx.tables has them

const LEGEND = [{ value: '2', label: 'Change' }, { value: '4', label: 'Delete' }, { value: '5', label: 'Display' }];
const COLUMNS = ['Opt', 'Name', 'Company', 'City', 'Phone', 'Status'];
const PEOPLE = [
  ['Maria Gonzalez', 'Lakeside Hardware', 'Chicago', '312-555-0142', 'Active'],
  ['James Okafor', 'Harbor Supply Co', 'San Francisco', '415-555-0198', 'Active'],
  ['Priya Raman', 'Capitol Office Goods', 'Washington', '202-555-0117', 'On hold'],
];

interface Rec { row: number; cells: string[]; fields: Array<string | null>; option: string | null; role: string | null; roles: string[] }
interface Table { row: number; col: number; columns: string[]; rows: string[][]; records: Rec[]; options: typeof LEGEND; more: boolean; hidden: boolean }

function contacts(over: Partial<Table> = {}, people = PEOPLE): Table {
  const records: Rec[] = people.map((p, i) => ({
    row: 7 + i,
    cells: ['', ...p],
    fields: [`${7 + i}:3`, null, null, null, null, null],
    option: `${7 + i}:3`,
    role: null,
    roles: COLUMNS.map(() => 'normal'),
  }));
  return { row: 6, col: 2, columns: COLUMNS, rows: records.map((r) => r.cells), records, options: LEGEND, more: true, hidden: true, ...over };
}

/** A list without an option column or legend. */
function items(): Table {
  const rows = [['A100', 'Widget', '12'], ['B200', 'Gadget', '3']];
  return {
    row: 5, col: 2, columns: ['Item', 'Description', 'Qty'], rows,
    records: rows.map((cells, i) => ({ row: 6 + i, cells, fields: [null, null, null], option: null, role: null, roles: ['normal', 'normal', 'normal'] })),
    options: [], more: false, hidden: false,
  };
}

// ---- a fake DOM: enough for the component, with bubbling events and focus

interface FakeEvent { type: string; key?: string; target: FakeNode; stopped: boolean; prevented: boolean; stopPropagation(): void; preventDefault(): void }

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(e: FakeEvent) => void>>();
  className = '';
  type = '';
  title = '';
  disabled = false;
  styleProps = new Map<string, string>();
  style = { setProperty: (k: string, v: string) => { this.styleProps.set(k, v); } };
  private text = '';
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
  }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  append(...nodes: FakeNode[]): void {
    for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); }
  }
  replaceChildren(...nodes: FakeNode[]): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parent) if (n === this) return true;
    return false;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** Dispatch from this node up through its parents, as the browser does. */
  dispatch(type: string, extra: { key?: string } = {}): FakeEvent {
    const e: FakeEvent = {
      type, ...extra, target: this, stopped: false, prevented: false,
      stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; },
    };
    for (let n: FakeNode | null = this; n && !e.stopped; n = n.parent) {
      for (const fn of n.listeners.get(type) ?? []) fn(e);
    }
    return e;
  }
  click(): FakeEvent { return this.disabled ? this.dispatch('none') : this.dispatch('click'); }
  key(key: string): FakeEvent { return this.dispatch('keydown', { key }); }
  focus(): void { this.ownerDocument.activeElement = this; }
  get classes(): string[] { return this.className.split(/\s+/).filter(Boolean); }
  all(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  findAll(test: (n: FakeNode) => boolean): FakeNode[] { return this.all().filter(test); }
  /** The visible text, without style sheets. */
  get shown(): string {
    return this.tagName === 'style' ? '' : this.text + this.children.map((c) => c.shown).join(' ');
  }
}

class FakeDocument {
  activeElement: FakeNode | null = null;
  createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
}

const host = () => new FakeDocument().createElement('div');
const cardsIn = (el: FakeNode) => el.findAll((n) => n.tagName === 'li');
const buttonsIn = (el: FakeNode) => el.findAll((n) => n.tagName === 'button');
const button = (el: FakeNode, label: string) => buttonsIn(el).find((b) => b.textContent === label);
const titleOf = (card: FakeNode) => card.findAll((n) => n.tagName === 'h3')[0]?.textContent;

interface Pressed { aid: string; fields?: Record<string, string> }

/** A ctx; `pressed` collects its presses (pass one in to share it across screens). */
function context(options: Record<string, unknown>, tables: Table[] = [contacts()], design = false, pressed: Pressed[] = []) {
  return {
    pressed,
    ctx: {
      options, tables, design,
      screen: { id: 'x', lines: [], fields: [] },
      getField: () => undefined, setField: () => {},
      press: (aid: string, fields?: Record<string, string>) => { pressed.push(fields ? { aid, fields } : { aid }); },
    },
  };
}

// ---- options

describe('settings', () => {
  test('defaults', () => {
    const s = cards.settings({});
    assert.deepEqual(
      { title: s.title, subtitle: s.subtitle, fields: s.fields, actions: s.actions, default: s.default, pager: s.pager, width: s.width, empty: s.empty, error: s.error },
      { title: '', subtitle: '', fields: null, actions: null, default: '', pager: true, width: 220, empty: 'Nothing to show', error: '' },
    );
    assert.equal(cards.settings(undefined).error, '');
    assert.equal(cards.settings(null as never).error, '');
  });

  test('reads every option', () => {
    const s = cards.settings({ title: ' Name ', subtitle: 'Company', fields: ['Phone', ' Status ', ''], actions: [5, '2'], default: 5, pager: false, width: 300, empty: 'No contacts' });
    assert.equal(s.title, 'Name');
    assert.deepEqual(s.fields, ['Phone', 'Status']);
    assert.deepEqual(s.actions, ['5', '2'], 'numbers become option values');
    assert.equal(s.default, '5');
    assert.equal(s.pager, false);
    assert.equal(s.width, 300);
    assert.equal(s.empty, 'No contacts');
  });

  test('keeps the card width sensible', () => {
    assert.equal(cards.settings({ width: 10 }).width, 120);
    assert.equal(cards.settings({ width: 5000 }).width, 600);
    assert.equal(cards.settings({ width: '250' }).width, 250);
  });

  test('says what is wrong with an option', () => {
    assert.match(cards.settings({ fields: 'Phone' }).error, /"fields" must be a list/);
    assert.match(cards.settings({ fields: ['Phone', 3] }).error, /"fields" must be a list/);
    assert.match(cards.settings({ actions: '5' }).error, /"actions" must be a list/);
    assert.match(cards.settings({ actions: [{}] }).error, /"actions" must be a list/);
    assert.match(cards.settings({ width: 'wide' }).error, /"width" must be a number/);
    assert.match(cards.settings({ width: -5 }).error, /"width"/);
  });
});

// ---- which list and columns

describe('pickTable', () => {
  test('the first list with every column the options name, ignoring case', () => {
    const tables = [items(), contacts()];
    assert.equal(cards.pickTable(tables, cards.settings({ title: 'name', fields: ['PHONE'] })), tables[1]);
    assert.equal(cards.pickTable(tables, cards.settings({ title: 'Description' })), tables[0]);
  });

  test('the first list when no columns are named', () => {
    const tables = [items(), contacts()];
    assert.equal(cards.pickTable(tables, cards.settings({})), tables[0]);
  });

  test('none when no list has the columns, or there are no lists', () => {
    assert.equal(cards.pickTable([items(), contacts()], cards.settings({ title: 'Name', fields: ['Fax'] })), undefined);
    assert.equal(cards.pickTable([], cards.settings({})), undefined);
    assert.equal(cards.pickTable(undefined as never, cards.settings({})), undefined);
  });
});

describe('layout and cardsOf', () => {
  test('by default the title is the first column after the option column, and the rest are facts', () => {
    assert.deepEqual(cards.layout(contacts(), cards.settings({})), { title: 1, subtitle: -1, facts: [2, 3, 4, 5] });
    assert.deepEqual(cards.layout(items(), cards.settings({})), { title: 0, subtitle: -1, facts: [1, 2] });
  });

  test('named columns, facts in the order given; unknown ones are left out', () => {
    assert.deepEqual(
      cards.layout(contacts(), cards.settings({ title: 'Company', subtitle: 'name', fields: ['Status', 'Fax', 'Phone'] })),
      { title: 2, subtitle: 1, facts: [5, 4] },
    );
  });

  test('a card per row with its title, subtitle and facts', () => {
    const [first] = cards.cardsOf(contacts(), cards.settings({ title: 'Name', subtitle: 'Company', fields: ['City', 'Phone'] }));
    assert.equal(first!.title, 'Maria Gonzalez');
    assert.equal(first!.subtitle, 'Lakeside Hardware');
    assert.deepEqual(first!.facts, [{ label: 'City', value: 'Chicago', role: '' }, { label: 'Phone', value: '312-555-0142', role: '' }]);
    assert.equal(first!.record.option, '7:3');
    assert.equal(cards.cardsOf(contacts(), cards.settings({})).length, 3);
  });

  test('a row\'s role becomes the card\'s, a cell\'s the fact\'s; normal and unknown roles are ignored', () => {
    const t = contacts();
    t.records[2]!.role = 'danger';
    t.records[1]!.roles[5] = 'warning';
    t.records[0]!.role = 'sparkly';
    const c = cards.cardsOf(t, cards.settings({ fields: ['Status'] }));
    assert.deepEqual(c.map((x) => x.role), ['', '', 'danger']);
    assert.equal(c[1]!.facts[0]!.role, 'warning');
    assert.equal(c[0]!.facts[0]!.role, '', 'normal is no role');
  });

  test('a list from an older Veneer without records still makes cards', () => {
    const t = items() as Partial<Table>;
    delete t.records;
    const c = cards.cardsOf(t as Table, cards.settings({}));
    assert.deepEqual(c.map((x) => x.title), ['A100', 'B200']);
    assert.equal(c[0]!.record.option, null);
  });
});

describe('actions', () => {
  test('the legend\'s options by default', () => {
    assert.deepEqual(cards.actionsOf(contacts(), cards.settings({})), LEGEND);
  });

  test('"actions" picks and orders them; an option not in the legend gets a plain label', () => {
    assert.deepEqual(cards.actionsOf(contacts(), cards.settings({ actions: ['5', '9', '2'] })), [
      { value: '5', label: 'Display' }, { value: '9', label: 'Option 9' }, { value: '2', label: 'Change' },
    ]);
    assert.deepEqual(cards.actionsOf(contacts(), cards.settings({ actions: [] })), []);
  });

  test('the default action', () => {
    assert.deepEqual(cards.defaultAction(contacts(), cards.settings({ default: '5' })), { value: '5', label: 'Display' });
    assert.deepEqual(cards.defaultAction(contacts(), cards.settings({ default: '7' })), { value: '7', label: 'Option 7' });
    assert.equal(cards.defaultAction(contacts(), cards.settings({})), null);
  });

  test('run types the option into the row\'s option field and presses Enter', () => {
    const { ctx, pressed } = context({});
    assert.equal(cards.run(ctx, contacts().records[1]!, '5'), true);
    assert.deepEqual(pressed, [{ aid: 'Enter', fields: { '8:3': '5' } }]);
  });

  test('run does nothing for a row without an option field, or without an option', () => {
    const { ctx, pressed } = context({});
    assert.equal(cards.run(ctx, items().records[0]!, '5'), false);
    assert.equal(cards.run(ctx, contacts().records[0]!, ''), false);
    assert.deepEqual(pressed, []);
  });
});

// ---- drawing and pressing

describe('mount', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('draws a card per row with its title, subtitle and facts, and brings its styles', () => {
    const el = host();
    cards.mount(el, context({ title: 'Name', subtitle: 'Company', fields: ['Phone', 'Status'], width: 260 }).ctx);
    const list = cardsIn(el);
    assert.deepEqual(list.map(titleOf), ['Maria Gonzalez', 'James Okafor', 'Priya Raman']);
    assert.match(list[0]!.shown, /Lakeside Hardware/);
    assert.match(list[0]!.shown, /Phone 312-555-0142/);
    assert.match(list[2]!.shown, /Status On hold/);
    assert.doesNotMatch(list[0]!.shown, /Chicago/, 'City is not one of the fields');
    assert.equal(list[0]!.getAttribute('aria-label'), 'Maria Gonzalez, Lakeside Hardware');
    assert.ok(el.findAll((n) => n.tagName === 'style').length === 1, 'its own styles');
    assert.equal(el.children[0]!.styleProps.get('--vc-card-width'), '260px');
    assert.equal(el.findAll((n) => n.getAttribute('role') === 'list').length, 1);
  });

  test('each card offers the legend\'s options; a button types its option into that row and presses Enter', () => {
    const el = host();
    const { ctx, pressed } = context({});
    cards.mount(el, ctx);
    const second = cardsIn(el)[1]!;
    const labels = buttonsIn(second).map((b) => b.textContent);
    assert.deepEqual(labels, ['Change', 'Delete', 'Display']);
    const display = buttonsIn(second).find((b) => b.textContent === 'Display')!;
    assert.equal(display.getAttribute('aria-label'), 'Display James Okafor');
    assert.equal(display.type, 'button', 'not a submit button');
    display.click();
    assert.deepEqual(pressed, [{ aid: 'Enter', fields: { '8:3': '5' } }]);
  });

  test('"actions" chooses the buttons; [] shows none', () => {
    const el = host();
    cards.mount(el, context({ actions: ['5'] }).ctx);
    assert.deepEqual(buttonsIn(cardsIn(el)[0]!).map((b) => b.textContent), ['Display']);
    const bare = host();
    cards.mount(bare, context({ actions: [] }).ctx);
    assert.equal(buttonsIn(cardsIn(bare)[0]!).length, 0);
  });

  test('a click on a card runs the default; a click on a button runs only that button\'s option', () => {
    const el = host();
    const { ctx, pressed } = context({ default: '5' });
    cards.mount(el, ctx);
    const third = cardsIn(el)[2]!;
    assert.ok(third.classes.includes('vc-card-clickable'));
    assert.equal(third.title, 'Display');
    third.click();
    assert.deepEqual(pressed, [{ aid: 'Enter', fields: { '9:3': '5' } }]);
    const fresh = host();
    const second = context({ default: '5' });
    cards.mount(fresh, second.ctx);
    const change = buttonsIn(cardsIn(fresh)[0]!).find((b) => b.textContent === 'Change')!;
    const e = change.click();
    assert.equal(e.stopped, true, 'the card does not see it');
    assert.deepEqual(second.pressed, [{ aid: 'Enter', fields: { '7:3': '2' } }]);
  });

  test('without a default a card is not clickable', () => {
    const el = host();
    const { ctx, pressed } = context({});
    cards.mount(el, ctx);
    const card = cardsIn(el)[0]!;
    assert.ok(!card.classes.includes('vc-card-clickable'));
    card.click();
    assert.deepEqual(pressed, []);
  });

  test('Enter on a card runs the default and stops there, so the screen does not get Enter too', () => {
    const el = host();
    const { ctx, pressed } = context({ default: '5' });
    cards.mount(el, ctx);
    const e = cardsIn(el)[1]!.key('Enter');
    assert.equal(e.stopped, true);
    assert.equal(e.prevented, true);
    assert.deepEqual(pressed, [{ aid: 'Enter', fields: { '8:3': '5' } }]);
  });

  test('Enter on a card without a default is left for the screen', () => {
    const el = host();
    const { ctx, pressed } = context({});
    cards.mount(el, ctx);
    const e = cardsIn(el)[1]!.key('Enter');
    assert.equal(e.stopped, false);
    assert.deepEqual(pressed, []);
  });

  test('Enter on a card\'s button is the button\'s, not the card\'s default', () => {
    const el = host();
    const { ctx, pressed } = context({ default: '5' });
    cards.mount(el, ctx);
    const e = buttonsIn(cardsIn(el)[0]!)[0]!.key('Enter');
    assert.equal(e.prevented, false);
    assert.deepEqual(pressed, [], 'the browser turns it into a click on the button');
  });

  test('cards are focusable one at a time, and arrow keys, Home and End move between them', () => {
    const el = host();
    cards.mount(el, context({}).ctx);
    const doc = el.ownerDocument;
    const list = () => cardsIn(el);
    assert.deepEqual(list().map((c) => c.getAttribute('tabindex')), ['0', '-1', '-1'], 'Tab reaches the first card');
    list()[0]!.focus();
    list()[0]!.key('ArrowRight');
    assert.equal(doc.activeElement, list()[1]);
    assert.deepEqual(list().map((c) => c.getAttribute('tabindex')), ['-1', '0', '-1']);
    list()[1]!.key('ArrowDown');
    assert.equal(doc.activeElement, list()[2]);
    list()[2]!.key('ArrowRight');
    assert.equal(doc.activeElement, list()[2], 'stays on the last');
    list()[2]!.key('Home');
    assert.equal(doc.activeElement, list()[0]);
    list()[0]!.key('ArrowUp');
    assert.equal(doc.activeElement, list()[0], 'stays on the first');
    const e = list()[0]!.key('End');
    assert.equal(doc.activeElement, list()[2]);
    assert.equal(e.prevented, true, 'the page does not scroll');
  });

  test('one press per screen: the buttons wait for the next screen', () => {
    const el = host();
    const { ctx, pressed } = context({ default: '5' });
    const view = cards.mount(el, ctx);
    button(cardsIn(el)[0]!, 'Change')!.click();
    assert.equal(el.children[0]!.getAttribute('aria-busy'), 'true');
    assert.ok(buttonsIn(el).every((b) => b.disabled));
    button(cardsIn(el)[1]!, 'Delete')!.click();
    cardsIn(el)[2]!.click();
    cardsIn(el)[2]!.key('Enter');
    button(el, 'Next')!.click();
    assert.equal(pressed.length, 1, 'a double click sends one key');
    view.update(context({ default: '5' }, [contacts()], false, pressed).ctx);
    assert.equal(el.children[0]!.getAttribute('aria-busy'), null);
    assert.ok(buttonsIn(el).every((b) => !b.disabled));
    button(cardsIn(el)[1]!, 'Delete')!.click();
    assert.equal(pressed.length, 2);
  });

  test('if no screen comes after a press, the buttons come back', () => {
    const el = host();
    const { ctx, pressed } = context({});
    cards.mount(el, ctx);
    button(cardsIn(el)[0]!, 'Change')!.click();
    mock.timers.tick(cards.BUSY_MS - 1);
    assert.ok(buttonsIn(el).every((b) => b.disabled));
    mock.timers.tick(1);
    assert.ok(buttonsIn(el).every((b) => !b.disabled));
    assert.equal(el.children[0]!.getAttribute('aria-busy'), null);
    button(cardsIn(el)[0]!, 'Change')!.click();
    assert.equal(pressed.length, 2);
  });

  test('Previous presses Page Up; Next presses Page Down and shows only when there is more', () => {
    const el = host();
    const { ctx, pressed } = context({});
    const view = cards.mount(el, ctx);
    button(el, 'Next')!.click();
    assert.deepEqual(pressed, [{ aid: 'PageDown' }]);
    view.update(context({}, [contacts({ more: false })], false, pressed).ctx);
    assert.equal(button(el, 'Next'), undefined, 'at the bottom');
    button(el, 'Previous')!.click();
    assert.deepEqual(pressed, [{ aid: 'PageDown' }, { aid: 'PageUp' }]);
  });

  test('"pager": false hides Previous and Next', () => {
    const el = host();
    cards.mount(el, context({ pager: false }).ctx);
    assert.equal(button(el, 'Previous'), undefined);
    assert.equal(button(el, 'Next'), undefined);
  });

  test('a list without an option column: cards, but no buttons and nothing to click', () => {
    const el = host();
    const { ctx, pressed } = context({ default: '5' }, [items()]);
    cards.mount(el, ctx);
    assert.deepEqual(cardsIn(el).map(titleOf), ['A100', 'B200']);
    assert.match(cardsIn(el)[0]!.shown, /Description Widget/);
    assert.deepEqual(buttonsIn(el).map((b) => b.textContent), ['Previous'], 'only the pager');
    cardsIn(el)[0]!.click();
    cardsIn(el)[0]!.key('Enter');
    assert.deepEqual(pressed, []);
  });

  test('class names are prefixed, so the page\'s own styles (e.g. .card) do not reach the cards', () => {
    const t = contacts();
    t.records[0]!.role = 'danger';
    const el = host();
    cards.mount(el, context({ default: '5' }, [t]).ctx);
    const classes = el.all().flatMap((n) => n.classes);
    assert.ok(classes.length > 0);
    assert.deepEqual(classes.filter((c) => !c.startsWith('vc-')), []);
  });

  test('styled rows become styled cards, styled cells styled facts', () => {
    const t = contacts();
    t.records[2]!.role = 'danger';
    t.records[0]!.roles[5] = 'warning';
    const el = host();
    cards.mount(el, context({ fields: ['Status'] }, [t]).ctx);
    assert.deepEqual(cardsIn(el).map((c) => c.classes.includes('vc-role-danger')), [false, false, true]);
    const dd = cardsIn(el)[0]!.findAll((n) => n.tagName === 'dd')[0]!;
    assert.ok(dd.classes.includes('vc-role-warning'));
  });

  test('an empty list says so, in the words the options give', () => {
    const el = host();
    cards.mount(el, context({}, [contacts({}, [])]).ctx);
    assert.match(el.shown, /Nothing to show/);
    assert.equal(cardsIn(el).length, 0);
    assert.ok(button(el, 'Previous'), 'paging still works');
    const custom = host();
    cards.mount(custom, context({ empty: 'No contacts yet' }, [contacts({}, [])]).ctx);
    assert.match(custom.shown, /No contacts yet/);
  });

  test('no list, a list without the columns, or a bad option: a message instead', () => {
    const none = host();
    cards.mount(none, context({}, []).ctx);
    assert.match(none.shown, /No list on this screen/);
    const missing = host();
    cards.mount(missing, context({ title: 'Name', fields: ['Fax'] }).ctx);
    assert.match(missing.shown, /No list on this screen has the columns “Name”, “Fax”/);
    const bad = host();
    cards.mount(bad, context({ fields: 'Phone' }).ctx);
    assert.match(bad.shown, /Cards: "fields" must be a list/);
    assert.equal(buttonsIn(bad).length, 0);
  });

  test('in the designer, the cards are drawn but nothing is pressed', () => {
    const el = host();
    const { ctx, pressed } = context({ default: '5' }, [contacts()], true);
    cards.mount(el, ctx);
    assert.equal(cardsIn(el).length, 3);
    button(cardsIn(el)[0]!, 'Change')!.click();
    cardsIn(el)[0]!.click();
    button(el, 'Next')!.click();
    assert.deepEqual(pressed, []);
    assert.ok(buttonsIn(el).every((b) => !b.disabled), 'not waiting for a screen');
  });

  test('the next page redraws the cards, and the keyboard stays on the same card', () => {
    const el = host();
    const view = cards.mount(el, context({}).ctx);
    cardsIn(el)[1]!.focus();
    const page2 = contacts({ more: false }, [['Grace Kim', 'Bluewater Marine', 'Tampa', '813-555-0190', 'Active'], ['Owen Price', 'Price Electric', 'Denver', '303-555-0108', 'Inactive']]);
    view.update(context({}, [page2]).ctx);
    assert.deepEqual(cardsIn(el).map(titleOf), ['Grace Kim', 'Owen Price']);
    assert.equal(el.ownerDocument.activeElement, cardsIn(el)[1]);
    assert.deepEqual(cardsIn(el).map((c) => c.getAttribute('tabindex')), ['-1', '0']);
    view.update(context({}, [contacts({}, [PEOPLE[0]!])]).ctx);
    assert.equal(el.ownerDocument.activeElement, cardsIn(el)[0], 'the last card when there are fewer');
  });

  test('paging with Next puts the keyboard on the first card of the new page', () => {
    const el = host();
    const view = cards.mount(el, context({}).ctx);
    const next = button(el, 'Next')!;
    next.focus();
    next.click();
    view.update(context({}).ctx);
    assert.equal(el.ownerDocument.activeElement, cardsIn(el)[0]);
  });

  test('the keyboard is left alone when it is elsewhere on the page', () => {
    const el = host();
    const view = cards.mount(el, context({}).ctx);
    const outside = el.ownerDocument.createElement('input');
    outside.focus();
    view.update(context({}).ctx);
    assert.equal(el.ownerDocument.activeElement, outside);
  });

  test('changed options redraw', () => {
    const el = host();
    const view = cards.mount(el, context({ title: 'Name' }).ctx);
    view.update(context({ title: 'Company' }).ctx);
    assert.deepEqual(cardsIn(el).map(titleOf), ['Lakeside Hardware', 'Harbor Supply Co', 'Capitol Office Goods']);
  });

  test('unmount removes the cards and stops the wait', () => {
    const el = host();
    const { ctx } = context({});
    const view = cards.mount(el, ctx);
    button(cardsIn(el)[0]!, 'Change')!.click();
    view.unmount();
    assert.equal(el.children.length, 0);
    mock.timers.tick(cards.BUSY_MS);
    assert.equal(el.children.length, 0);
  });

  test('two card views on one screen keep to themselves', () => {
    const a = host();
    const b = host();
    const first = context({}, [contacts(), items()]);
    const second = context({ title: 'Item' }, [contacts(), items()]);
    cards.mount(a, first.ctx);
    cards.mount(b, second.ctx);
    assert.equal(cardsIn(a).length, 3);
    assert.equal(cardsIn(b).length, 2);
    button(cardsIn(a)[0]!, 'Change')!.click();
    assert.ok(buttonsIn(b).every((x) => !x.disabled));
    assert.deepEqual(second.pressed, []);
  });

  test('text from the screen is shown as text, never as HTML', () => {
    const el = host();
    cards.mount(el, context({}, [contacts({}, [['<img src=x onerror=alert(1)>', 'Co', 'City', '1', 'Active']])]).ctx);
    assert.equal(titleOf(cardsIn(el)[0]!), '<img src=x onerror=alert(1)>');
    assert.equal(el.findAll((n) => n.tagName === 'img').length, 0);
  });
});
