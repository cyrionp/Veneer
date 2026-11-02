// Radio buttons, spinner and text area: the logic behind the widgets (the
// spinner's arithmetic, fitting text into fields), how a definition applies
// them to a screen, and the designer's helpers for building a text area.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateDefinition, type ScreenDefinition, type Widget } from '@veneer/screens';
import type { FieldSnapshot } from '@veneer/tn5250';
import { describeChange } from '../src/designer/changes.ts';
import { fieldsBelow, resolveSelection, setWidget, textAreaOf, toggleTextAreaField } from '../src/designer/edit.ts';
import { customize } from '../src/transform/customize.ts';
import { transform, type FieldItem } from '../src/transform/index.ts';
import { keyAction } from '../src/ui/keys.ts';
import { layoutOf } from '../src/ui/layout.ts';
import { parseValue, stepValue } from '../src/ui/spinner.ts';
import { fitText, indexAt, lineAt, partAt, roomLeft, textOf, type Part } from '../src/ui/textArea.ts';
import { orderNotes } from './screens.ts';

// ---- spinner ----------------------------------------------------------------

const numeric = (length: number, shift: FieldSnapshot['shift']) => ({ length, shift });

describe('spinner', () => {
  test('steps whole numbers up and down, by 1 unless set', () => {
    const f = numeric(5, 'numericOnly');
    assert.equal(stepValue('41', f, {}, true), '42');
    assert.equal(stepValue('41', f, {}, false), '40');
    assert.equal(stepValue('40', f, { step: 5 }, true), '45');
    assert.equal(stepValue('  7 ', f, {}, true), '8', 'blanks around the number');
    assert.equal(stepValue('', f, {}, true), '1', 'blank reads as 0');
    assert.equal(stepValue('', f, {}, false), '-1');
  });

  test('stays within min and max, and says when it can\'t move', () => {
    const f = numeric(5, 'numericOnly');
    const spin = { min: 1, max: 10 };
    assert.equal(stepValue('10', f, spin, true), null, 'at the top');
    assert.equal(stepValue('1', f, spin, false), null, 'at the bottom');
    assert.equal(stepValue('50', f, spin, false), '10', 'out of range: back to the edge');
    assert.equal(stepValue('', f, spin, false), '1', 'blank goes to the lowest value');
    assert.equal(stepValue('9', f, { min: 1, max: 10, step: 4 }, true), '10');
    assert.equal(stepValue('abc', f, spin, true), null, 'not a number: left alone');
  });

  test('signed numeric fields: digits with the sign after, decimals implied', () => {
    const f = numeric(5, 'signedNumeric');
    assert.equal(stepValue('1', f, {}, false), '0');
    assert.equal(stepValue('0', f, {}, false), '1-', 'the sign goes after, as Field- leaves it');
    assert.equal(stepValue('5-', f, {}, true), '4-');
    assert.equal(stepValue('-5', f, {}, true), '4-', 'a leading minus is read too');
    assert.equal(stepValue('1250', f, { step: 100 }, true), '1350', '12.50 + 1.00, typed in units');
    assert.equal(stepValue('9999', f, {}, true), null, 'four digits fill it: the last position is the sign');
    assert.equal(stepValue('10', f, { step: 0.5 }, true), null, 'no decimal point to type');
  });

  test('numeric-only fields keep the decimals and the separator typed', () => {
    const f = numeric(8, 'numericOnly');
    assert.equal(stepValue('12.50', f, {}, true), '13.50');
    assert.equal(stepValue('12,50', f, {}, true), '13,50');
    assert.equal(stepValue('1', f, { step: 0.25 }, true), '1.25');
    assert.equal(stepValue('0.1', f, { step: 0.2 }, true), '0.3', 'exact, not 0.30000000000000004');
    assert.equal(stepValue('0.5', f, {}, false), '-0.5');
    assert.equal(stepValue('1,234.50', f, {}, true), '1235.50', 'thousands separators read, not kept');
    assert.equal(stepValue('99999.9', f, {}, true), '100000.9', 'just fits');
    assert.equal(stepValue('99999.9', numeric(7, 'numericOnly'), {}, true), null, 'too long for the field');
  });

  test('digits-only fields don\'t go below 0', () => {
    const f = numeric(3, 'digitsOnly');
    assert.equal(stepValue('1', f, {}, false), '0');
    assert.equal(stepValue('0', f, {}, false), null);
    assert.equal(stepValue('999', f, {}, true), null, 'too long for the field');
  });

  test('reading a value', () => {
    assert.deepEqual(parseValue('12.50-', { shift: 'numericOnly' }), { units: -1250n, decimals: 2, separator: '.' });
    assert.deepEqual(parseValue('+7', { shift: 'numericOnly' }), { units: 7n, decimals: 0, separator: '.' });
    assert.equal(parseValue('1.5', { shift: 'signedNumeric' }), null, 'no point in a signed field');
    assert.equal(parseValue('1 2', { shift: 'numericOnly' }), null);
  });
});

// ---- text area --------------------------------------------------------------

const part = (length: number, more: Partial<Part> = {}): Part => ({ length, monocase: false, shift: 'alpha', ...more } as Part);
const four = [part(10), part(10), part(10), part(10)];

/** Type `text` at a caret marked `|` in the box, as the browser would leave it. */
function typeAt(box: string, text: string, parts = four) {
  const at = box.indexOf('|');
  const typed = box.slice(0, at) + text + box.slice(at + 1);
  return fitText(typed, at + text.length, parts);
}
/** The fitted text with the caret shown as `|`. */
const shown = (r: ReturnType<typeof fitText>) => {
  if (!r) return null;
  const t = r.values.join('\n');
  return t.slice(0, r.caret) + '|' + t.slice(r.caret);
};

describe('text area', () => {
  test('one line per field, as the host sent them', () => {
    assert.equal(textOf(['ONE', '', 'THREE', '']), 'ONE\n\nTHREE\n');
    assert.equal(roomLeft(['ONE', '', 'THREE', ''], four), 40 - 8);
    assert.equal(roomLeft(['', '', '', ''], four), 40);
  });

  test('typing within a line changes that field only', () => {
    assert.equal(shown(typeAt('ab|\n\n\n', 'c')), 'abc|\n\n\n');
  });

  test('a word that runs past the field moves to the next line, caret with it', () => {
    assert.equal(shown(typeAt('the quick|\n\n\n', ' fox')), 'the quick\nfox|\n\n');
    // Typed in the middle: the last word moves down; the caret, in front of it, goes too.
    assert.equal(shown(typeAt('the |quick\n\n\n', 'big ')), 'the big\n|quick\n\n');
    assert.equal(shown(typeAt('|the quick\n\n\n', 'a ')), 'a |the\nquick\n\n', 'on a line that stays: stays');
  });

  test('wrapped text pushes the next line along, and so on down', () => {
    // The caret was in front of "bbbb", so it goes down with it.
    assert.equal(shown(typeAt('aaaa |bbbb\ncccc dddd\neeee\n', 'xxx ')), 'aaaa xxx\n|bbbb cccc\ndddd eeee\n');
  });

  test('a caret on the line text is pushed into stays with its own text', () => {
    // Line 1 too long (pasted over a selection, say) with the caret after "xx" on line 2.
    const text = 'aaaa bbbbbb\nxx\n\n';
    assert.equal(shown(fitText(text, text.indexOf('xx') + 2, four)), 'aaaa\nbbbbbb xx|\n\n');
  });

  test('a word longer than the field breaks at the field\'s end', () => {
    assert.equal(shown(typeAt('|\n\n\n', 'abcdefghijklmn')), 'abcdefghij\nklmn|\n\n');
  });

  test('Enter starts the next line, pushing the lines below down', () => {
    assert.equal(shown(typeAt('one two|\nthree\n\n', '\n')), 'one two\n|\nthree\n');
    assert.equal(shown(typeAt('one |two\n\n\n', '\n')), 'one \n|two\n\n', 'splits the line at the caret');
  });

  test('nothing is lost: an edit that would push text past the last field is refused', () => {
    assert.equal(typeAt('a\nb\nc\nd|', '\n'), null, 'no line left for Enter');
    assert.equal(typeAt('a|\nb\nc\nd', '\n'), null, 'pushing d off the end');
    assert.equal(typeAt('a\nb\nc\nabcdefghij|', 'k'), null, 'the last field is full');
    assert.equal(typeAt('|\n\n\n', 'x'.repeat(41)), null, 'a paste too long for all four');
    assert.equal(shown(typeAt('|\n\n\n', 'x'.repeat(40))), 'xxxxxxxxxx\nxxxxxxxxxx\nxxxxxxxxxx\nxxxxxxxxxx|', 'exactly full');
  });

  test('deleting a line break joins the lines; the fields below move up', () => {
    // Backspace at the start of line 2 of "one / two / three / four": the rest move up.
    assert.equal(shown(fitText('onetwo\nthree\nfour', 3, four)), 'one|two\nthree\nfour\n');
    // Joined text too long for the field wraps back.
    const r = fitText('aaaa bbbbbcccc dddd\n\n\n', 10, four);
    assert.deepEqual(r?.values, ['aaaa', 'bbbbbcccc', 'dddd', '']);
  });

  test('each field\'s rules apply to its line', () => {
    const parts = [part(5, { monocase: true }), part(5, { shift: 'digitsOnly' })];
    assert.deepEqual(fitText('abc\n12x3', 8, parts)?.values, ['ABC', '123']);
    assert.equal(shown(fitText('abc\n1x2', 6, parts)), 'ABC\n1|2', 'the caret allows for a dropped character');
  });

  test('fields of different lengths', () => {
    const parts = [part(5), part(20)];
    assert.equal(shown(typeAt('hello|\n', ' world', parts)), 'hello\nworld|');
  });

  test('caret positions: text index to line and field, and back', () => {
    const text = 'one\ntwo\n\nfour';
    assert.deepEqual(lineAt(text, 0), { line: 0, col: 0 });
    assert.deepEqual(lineAt(text, 5), { line: 1, col: 1 });
    assert.deepEqual(lineAt(text, text.length), { line: 3, col: 4 });
    assert.equal(indexAt(text, 1, 1), 5);
    assert.equal(indexAt(text, 2, 7), 8, 'past a line\'s end: its end');
    assert.equal(indexAt(text, 9, 0), text.length);
    assert.deepEqual(partAt(text, 5, four), { part: 1, offset: 1 });
    assert.deepEqual(partAt('x'.repeat(10), 10, four), { part: 0, offset: 9 }, 'the cursor stays inside the field');
  });

  test('Enter in a text area is a new line, not the Enter key', () => {
    const key = (tagName: string) => keyAction({ key: 'Enter', target: { tagName } } as unknown as KeyboardEvent);
    assert.equal(key('TEXTAREA'), null);
    assert.equal(key('INPUT'), 'Enter');
  });
});

// ---- on a screen ------------------------------------------------------------

const definition = (changes: ScreenDefinition['changes']): ScreenDefinition =>
  validateDefinition({ id: 'notes', name: 'Notes', match: { text: [{ row: 1, col: 33, text: 'Order Notes' }] }, changes });
const areaChange = (fields = ['8:20', '9:20', '10:20', '11:20']) => ({ op: 'widget' as const, field: '8:20', widget: { type: 'textarea' as const, fields } });
const fieldItem = (items: ReturnType<typeof transform>['items'], id: string) =>
  items.find((i): i is FieldItem => i.kind === 'field' && i.field.id === id);

describe('applying the widgets to a screen', () => {
  test('radio buttons and a spinner are set on their fields', () => {
    const radio: Widget = { type: 'radio', options: [{ value: 'A', label: 'Air' }, { value: 'O', label: 'Ocean' }] };
    const view = customize(transform(orderNotes()), definition([
      { op: 'widget', field: '4:20', widget: radio },
      { op: 'widget', field: '5:20', widget: { type: 'spinner', max: 999 } },
    ]));
    assert.deepEqual(fieldItem(view.items, '4:20')?.widget, radio);
    assert.deepEqual(fieldItem(view.items, '5:20')?.widget, { type: 'spinner', max: 999 });
  });

  test('a text area: the first field draws the box, the others are gone from the page', () => {
    const view = customize(transform(orderNotes()), definition([areaChange()]));
    const head = fieldItem(view.items, '8:20')!;
    assert.deepEqual(head.parts?.map((f) => f.id), ['8:20', '9:20', '10:20', '11:20']);
    assert.equal(head.parts?.[1]?.value, 'FRAGILE', 'with the host\'s values');
    for (const id of ['9:20', '10:20', '11:20']) assert.equal(fieldItem(view.items, id), undefined, id);
    assert.ok(fieldItem(view.items, '12:40'), 'a field not in it is untouched');
  });

  test('the page is tall enough for the box, down to its last field\'s row', () => {
    // Just the comments: the box on row 8 covers rows 8-11, though the fields under it are gone.
    const comments = transform(orderNotes());
    comments.items = comments.items.filter((i) => i.kind === 'field' && i.row >= 8 && i.row <= 11);
    assert.equal(layoutOf(customize(comments, definition([areaChange()]))).bottom, 11);
  });

  test('in the designer the other lines stay, ghosted and selectable', () => {
    const snap = orderNotes();
    const view = customize(transform(snap), definition([areaChange()]), { design: true });
    const second = fieldItem(view.items, '9:20')!;
    assert.equal(second.hidden, true);
    assert.equal(second.partOf, '8:20');
    const picked = resolveSelection(view, snap, { row: 9, col: 20 });
    assert.equal(picked?.kind === 'field' && picked.field.id, '9:20');
  });

  test('lines not on this screen are skipped; a first field not on it changes nothing', () => {
    const view = customize(transform(orderNotes()), definition([areaChange(['8:20', '9:20', '20:20'])]));
    assert.deepEqual(fieldItem(view.items, '8:20')?.parts?.map((f) => f.id), ['8:20', '9:20']);
    const none = customize(transform(orderNotes()), definition([{ op: 'widget', field: '20:20', widget: { type: 'textarea', fields: ['20:20', '9:20'] } }]));
    assert.ok(fieldItem(none.items, '9:20'), 'its lines stay plain fields');
  });
});

// ---- the designer -----------------------------------------------------------

describe('designer: building a text area', () => {
  const start = () => setWidget(definition([]), '8:20', { type: 'textarea', fields: ['8:20'] });
  const fieldsOf = (def: ScreenDefinition) => textAreaOf(def, '8:20')?.widget.fields;

  test('Add the fields below finds the same column and length on the next rows', () => {
    const snap = orderNotes();
    assert.deepEqual(fieldsBelow(start(), snap, '8:20'), ['9:20', '10:20', '11:20'], 'not 12:40, in another column');
    const all = fieldsBelow(start(), snap, '8:20').reduce((d, id) => toggleTextAreaField(d, '8:20', id), start());
    assert.deepEqual(fieldsOf(all), ['8:20', '9:20', '10:20', '11:20']);
    assert.deepEqual(fieldsBelow(all, snap, '8:20'), [], 'nothing left to add');
    assert.doesNotThrow(() => validateDefinition(all), 'what it builds is valid');
  });

  test('stops at a field already used by another widget', () => {
    const def = setWidget(start(), '10:20', { type: 'checkbox', on: 'Y', off: 'N' });
    assert.deepEqual(fieldsBelow(def, orderNotes(), '8:20'), ['9:20']);
  });

  test('clicking fields adds them in screen order; clicking again takes them out', () => {
    let def = toggleTextAreaField(start(), '8:20', '10:20');
    def = toggleTextAreaField(def, '8:20', '9:20');
    assert.deepEqual(fieldsOf(def), ['8:20', '9:20', '10:20']);
    assert.deepEqual(textAreaOf(def, '10:20')?.first, '8:20', 'a line knows its text area');
    def = toggleTextAreaField(def, '8:20', '9:20');
    assert.deepEqual(fieldsOf(def), ['8:20', '10:20']);
  });

  test('the first field, a field above it, or one in use elsewhere can\'t be added', () => {
    const def = start();
    assert.equal(toggleTextAreaField(def, '8:20', '8:20'), def);
    assert.equal(toggleTextAreaField(def, '8:20', '5:20'), def, 'above the first');
    const other = setWidget(def, '11:20', { type: 'textarea', fields: ['11:20'] });
    assert.equal(toggleTextAreaField(other, '8:20', '11:20'), other, 'the first of another text area');
    const select = setWidget(def, '9:20', { type: 'select', options: [] });
    assert.equal(toggleTextAreaField(select, '8:20', '9:20'), select, 'shown as a dropdown');
    assert.equal(toggleTextAreaField(definition([]), '8:20', '9:20').changes.length, 0, 'no text area there');
  });

  test('the Changes list says what each widget is', () => {
    const snap = orderNotes();
    const view = transform(snap);
    const label = (widget: Widget, field = '4:20') => describeChange({ op: 'widget', field, widget }, view, snap).label;
    assert.match(label({ type: 'radio', options: [] }), /as radio buttons$/);
    assert.match(label({ type: 'spinner' }, '5:20'), /as a spinner$/);
    assert.match(label({ type: 'textarea', fields: ['8:20', '9:20', '10:20'] }, '8:20'), /as a text area \(3 lines\)$/);
    assert.match(label({ type: 'textarea', fields: ['8:20'] }, '8:20'), /\(1 line\)$/);
  });
});
