// Custom components: developer-written ES modules the server serves from its
// components directory (/components/<name>.js). A `component` change draws one
// in a box on the screen, optionally in place of an input field.
//
// A component module exports:
//   label                      optional name for the designer
//   mount(element, ctx)        draw into element; may return { update(ctx), unmount() }
//                              or a cleanup function
// ctx (ComponentContext) has the change's options, the screen, the lists on it,
// the bound field's value and setValue, getField/setField, and press(), which
// goes through the same path as the user pressing a key.
//
// Components run with the page's full rights, like designers' scripts, but only
// whoever runs the server can install them. A component that fails to load or
// throws is reported in the console; a field it replaced gets its input back.

import type { ComponentOptions, Role } from '@veneer/screens';
import type { AidName } from '@veneer/tn5250';
import { useSyncExternalStore } from 'react';
import type { ScreenView, TableItem } from '../transform/types.ts';
import type { ScreenInfo } from './runtime.ts';

/** A list on the screen, as text: a heading and a cell per column. */
export interface TableInfo {
  row: number;
  col: number;
  columns: string[];
  /** Each row's cells as text (what the user typed, for input cells). */
  rows: string[][];
  /** The same rows with where they are and what they hold, in the same order. */
  records: TableRecord[];
  /** The options from the list's legend ("2=Change  5=Display"); empty if it has none. */
  options: Array<{ value: string; label: string }>;
  /** The host has more rows (paging down shows them). */
  more: boolean;
  /** A customization hid the list (a component is taking its place). */
  hidden: boolean;
}

/** One row of a list. */
export interface TableRecord {
  /** The screen row it is on. */
  row: number;
  cells: string[];
  /** Each cell's input field id ("row:col"), or null for text. */
  fields: Array<string | null>;
  /** The field to type an option into ("2", "5"), when the list has an option column. */
  option: string | null;
  /** The row's role from a style rule (e.g. "danger"), or null. */
  role: Role | null;
  /** Each cell's role: from a style rule, or the host's color. */
  roles: Role[];
}

/**
 * The lists on a screen, as text, in screen order: those drawn and those a
 * customization hid. Input cells hold the value on the screen.
 */
export function tablesOf(view: ScreenView): TableInfo[] {
  const tables = [...view.items, ...(view.window?.items ?? []), ...(view.hiddenTables ?? [])]
    .filter((i): i is TableItem => i.kind === 'table')
    .sort((a, b) => a.row - b.row || a.col - b.col);
  return tables.map((t) => {
    const records = t.rows.map((r): TableRecord => {
      const cells = r.cells.map((c) => (c.field?.value ?? c.text).trim());
      return {
        row: r.row,
        cells,
        fields: r.cells.map((c) => c.field?.id ?? null),
        option: r.cells.find((c) => c.options && c.field && !c.field.bypass)?.field!.id ?? null,
        role: r.role ?? null,
        roles: r.cells.map((c) => c.role),
      };
    });
    return {
      row: t.row,
      col: t.col,
      columns: t.columns.map((c) => c.header.trim()),
      rows: records.map((r) => r.cells),
      records,
      options: (t.rows.flatMap((r) => r.cells).find((c) => c.options)?.options ?? []).map((o) => ({ value: o.value, label: o.label })),
      more: t.more,
      hidden: !!t.hidden,
    };
  });
}

export interface ComponentContext {
  /** The change's options, as saved in the screen definition. */
  options: ComponentOptions;
  screen: ScreenInfo;
  tables: TableInfo[];
  /** The field the component replaces, if any: its id, value and a setter. */
  field?: { id: string; length: number };
  value?: string;
  setValue?: (value: string) => void;
  getField(id: string): string | undefined;
  setField(id: string, value: string): void;
  press(aid: AidName, fields?: Record<string, string>): void;
  /** True in the designer, where keys are not sent. */
  design: boolean;
}

export interface ComponentInstance {
  update?(ctx: ComponentContext): void;
  unmount?(): void;
}

export interface ComponentModule {
  label?: string;
  mount(element: HTMLElement, ctx: ComponentContext): ComponentInstance | (() => void) | void;
}

export type ComponentStatus = 'loading' | 'ready' | 'missing' | 'failed';

interface Entry {
  status: ComponentStatus;
  module?: ComponentModule;
  error?: string;
}

/** Installed components by name, with their versions; null until the server answers. */
let installed: Map<string, string> | null = null;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
/** Bumped on every change, so useSyncExternalStore sees one. */
let revision = 0;

function changed(): void {
  revision++;
  for (const fn of [...listeners]) fn();
}

/** The components the server has (from /api/components). A changed version is loaded again. */
export function setInstalled(list: Array<{ name: string; version: string }>): void {
  const next = new Map(list.map((c) => [c.name, c.version]));
  for (const [name, entry] of entries) {
    if (next.get(name) !== installed?.get(name) && entry.status !== 'loading') entries.delete(name);
  }
  installed = next;
  changed();
}

export function installedNames(): string[] {
  return [...(installed?.keys() ?? [])];
}

/** The module's state, starting to load it if needed. */
export function componentEntry(name: string): Entry {
  const known = entries.get(name);
  if (known) return known;
  if (!installed) return { status: 'loading' };
  const version = installed.get(name);
  if (version === undefined) {
    const entry: Entry = { status: 'missing', error: `No component "${name}" is installed` };
    entries.set(name, entry);
    return entry;
  }
  const entry: Entry = { status: 'loading' };
  entries.set(name, entry);
  import(/* @vite-ignore */ `/components/${encodeURIComponent(name)}.js?v=${encodeURIComponent(version)}`)
    .then((mod: Partial<ComponentModule>) => {
      if (typeof mod.mount !== 'function') throw new Error('it does not export a mount(element, ctx) function');
      entries.set(name, { status: 'ready', module: mod as ComponentModule });
    })
    .catch((err: Error) => {
      console.error(`Veneer: component "${name}" could not be loaded:`, err);
      entries.set(name, { status: 'failed', error: err.message });
    })
    .finally(changed);
  return entry;
}

/** A component threw: it stays off (its fields get their inputs back) until the page reloads. */
export function componentFailed(name: string, err: unknown): void {
  console.error(`Veneer: component "${name}" failed:`, err);
  const prev = entries.get(name);
  entries.set(name, { ...prev, status: 'failed', error: (err as Error)?.message ?? String(err) });
  changed();
}

/** Re-render when any component loads or fails; returns componentEntry to read them. */
export function useComponents(): (name: string) => Entry {
  useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => revision,
  );
  return componentEntry;
}

/** Run mount and wrap what it returns, so the caller only sees update and unmount. */
export function mountComponent(module: ComponentModule, element: HTMLElement, ctx: ComponentContext): ComponentInstance {
  const out = module.mount(element, ctx);
  if (typeof out === 'function') return { unmount: out };
  return out && typeof out === 'object' ? out : {};
}

/** For tests: forget everything. */
export function resetComponents(): void {
  installed = null;
  entries.clear();
  changed();
}
