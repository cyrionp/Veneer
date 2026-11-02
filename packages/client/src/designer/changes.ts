// One line per change in a definition, for the designer's Changes list:
// what it does, and where on the screen (to select it), if anywhere.

import { testOf, type Change, type Target } from '@veneer/screens';
import type { ScreenSnapshot } from '@veneer/terminal';
import type { ScreenView } from '../transform/types.ts';
import { ROLE_LABELS } from './edit.ts';
import { clip, nameAt } from './names.ts';

export interface ChangeLine {
  label: string;
  /** The screen position the change applies to, to select it. */
  at?: Target;
}

/** A field id ("6:22") as a position. */
const fieldAt = (id: string): Target => {
  const [row, col] = id.split(':').map(Number) as [number, number];
  return { row, col };
};

const WIDGET_LABELS = {
  select: 'a drop-down list', checkbox: 'a checkbox', date: 'a date picker', radio: 'radio buttons', spinner: 'a spinner', textarea: 'a text area',
} as const;

export function describeChange(change: Change, view: ScreenView, snap: ScreenSnapshot): ChangeLine {
  const name = (at: Target) => nameAt(view, snap, at);
  const fieldName = (id: string) => name(fieldAt(id));
  switch (change.op) {
    case 'hide':
      return { label: `Hide ${name(change.at)}`, at: change.at };
    case 'text':
      return { label: `Change ${name(change.at)} to “${clip(change.text)}”`, at: change.at };
    case 'role':
      return { label: `Show ${name(change.at)} as ${ROLE_LABELS[change.role]}`, at: change.at };
    case 'widget': {
      const lines = change.widget.type === 'textarea' ? ` (${change.widget.fields.length} line${change.widget.fields.length === 1 ? '' : 's'})` : '';
      return { label: `Show ${fieldName(change.field)} as ${WIDGET_LABELS[change.widget.type]}${lines}`, at: fieldAt(change.field) };
    }
    case 'move':
      return { label: `Move ${name(change.at)} to row ${change.to.row}, column ${change.to.col}`, at: change.at };
    case 'button':
      return { label: `Button “${clip(change.label)}”: ${'url' in change.action ? 'opens a web page' : `presses ${change.action.aid}`}` };
    case 'style': {
      const { test, value } = testOf(change.when);
      const subject = change.when.column !== undefined ? `column “${change.when.column}”` : name(change.when.at!);
      return {
        label: `${ROLE_LABELS[change.role]} when ${subject} ${TEST_WORDS[test]} “${clip(String(value))}”`,
        ...(change.when.at ? { at: change.when.at } : {}),
      };
    }
    case 'card':
      return {
        label: `Card${change.title ? ` “${clip(change.title)}”` : ''}, rows ${change.from.row}–${change.to.row}`,
        at: change.from,
      };
    case 'tabs':
      return { label: `Tabs: ${change.tabs.map((t) => t.title || 'Untitled').join(', ')}` };
    case 'component':
      return { label: `Component ${change.name}${change.field ? ` for ${fieldName(change.field)}` : ''}`, at: change.at };
    case 'html': {
      const text = change.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return { label: `HTML ${text ? `“${clip(text)}”` : '(no text)'}`, at: change.at };
    }
  }
}

const TEST_WORDS = { equals: 'is', contains: 'contains', matches: 'matches', lessThan: 'is under', greaterThan: 'is over' } as const;
