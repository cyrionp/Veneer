// Custom JavaScript from screen definitions, HTML boxes and the site-wide
// global.js / global-screen.js.
//
// Designers' code runs with the page's full rights, like the site's own code:
// it can read everything typed, passwords included. Only people trusted to
// change the site should get designer access.
//
// Every script is the body of `function (veneer, screen, element)`:
//   screen   the screen showing now (ScreenInfo), or null before the first one
//   element  the page element holding the screen; for an HTML box, the box
// and may return a function, called when what it set up should be undone (see
// SCREEN_EVENTS in @veneer/screens). Functions a script declares at its top
// level are also made global while it is active, so HTML can call them from
// attributes like onclick="doMessage()". `veneer` (also window.veneer) offers:
//   veneer.screen               the screen showing now
//   veneer.on('screen', fn)     call fn(screen, element) after each screen is drawn; returns an unsubscribe
//   veneer.getField('6:53')     a field's current value, including what the user typed
//   veneer.setField('6:53', v)  type into a field
//   veneer.press('F3', fields?) press a key, optionally filling fields first

import type { AidName, ScreenSnapshot } from '@veneer/terminal';

export interface ScreenInfo {
  /** Structural screen id (see @veneer/screens fingerprint). */
  id: string;
  /** Id of the screen definition applied, if any. */
  definition?: string;
  rows: number;
  cols: number;
  /** Screen text, one string per row. */
  lines: string[];
  fields: Array<{ id: string; row: number; col: number; length: number; value: string }>;
}

/** What scripts and components see of a screen. */
export function screenInfo(snap: ScreenSnapshot, id: string, definition?: string): ScreenInfo {
  return {
    id,
    ...(definition ? { definition } : {}),
    rows: snap.rows,
    cols: snap.cols,
    lines: snap.lines,
    fields: snap.fields.filter((f) => !f.bypass).map((f) => ({ id: f.id, row: f.row, col: f.col, length: f.length, value: f.value })),
  };
}

export interface VeneerApi {
  readonly screen: ScreenInfo | null;
  on(event: 'screen', fn: (screen: ScreenInfo, element: HTMLElement) => void): () => void;
  getField(id: string): string | undefined;
  setField(id: string, value: string): void;
  press(aid: AidName, fields?: Record<string, string>): void;
}

/** What the app provides to scripts. */
export interface ScriptHost {
  getField(id: string): string | undefined;
  setField(id: string, value: string): void;
  press(aid: AidName, fields?: Record<string, string>): void;
}

type Listener = (screen: ScreenInfo, element: HTMLElement) => void;

let host: ScriptHost | null = null;
let current: ScreenInfo | null = null;
let currentElement: HTMLElement | null = null;
const listeners = new Set<Listener>();

export const veneer: VeneerApi = {
  get screen() { return current; },
  on(event, fn) {
    if (event !== 'screen') throw new Error(`veneer.on: unknown event "${String(event)}"`);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  getField: (id) => host?.getField(id),
  setField: (id, value) => host?.setField(id, value),
  press: (aid, fields) => host?.press(aid, fields),
};

declare global {
  interface Window { veneer: VeneerApi }
}
if (typeof window !== 'undefined') window.veneer = veneer;

export function connectHost(next: ScriptHost): void {
  host = next;
}

/** Record the screen just drawn, before its scripts run. */
export function setScreen(screen: ScreenInfo, element: HTMLElement): void {
  current = screen;
  currentElement = element;
}

/** Call veneer.on('screen') handlers for the current screen. */
export function notifyScreen(only?: ReadonlySet<Listener>): void {
  if (!current || !currentElement) return;
  for (const fn of [...listeners]) {
    if (only && !only.has(fn)) continue;
    try { fn(current, currentElement); } catch (err) { console.error('Veneer: a veneer.on("screen") handler failed:', err); }
  }
}

export interface ScriptResult {
  cleanup?: () => void;
  error?: string;
}

/**
 * Run a script with the current screen. `element` defaults to the screen's
 * element. Errors are caught and reported, never thrown.
 */
export function runScript(code: string, label: string, element: HTMLElement | null = currentElement): ScriptResult {
  const names = declaredFunctions(code);
  const exported: Record<string, unknown> = {};
  try {
    // Function declarations are hoisted, so they can be handed out before the script's own code runs.
    const prelude = names.map((n) => `if (typeof ${n} === 'function') __export.${n} = ${n};`).join('\n');
    const fn = new Function('veneer', 'screen', 'element', '__export', `${prelude}\n${code}`) as
      (v: VeneerApi, s: ScreenInfo | null, el: HTMLElement | null, e: Record<string, unknown>) => unknown;
    const out = fn(veneer, current, element, exported);
    const unexport = exportGlobals(exported);
    const cleanup = typeof out === 'function' ? wrapCleanup(out as () => void, label) : undefined;
    return unexport || cleanup ? { cleanup: () => { cleanup?.(); unexport?.(); } } : {};
  } catch (err) {
    console.error(`Veneer: ${label} failed:`, err);
    return { error: (err as Error).message ?? String(err) };
  }
}

/**
 * Run global.js once, when the page loads. If a screen is already showing,
 * handlers it registers are called for that screen straight away.
 */
export function runSiteScript(code: string): ScriptResult {
  const before = new Set(listeners);
  const result = runScript(code, 'global.js');
  notifyScreen(new Set([...listeners].filter((l) => !before.has(l))));
  return result;
}

/** Names of functions declared in a script, e.g. `function doMessage() {`. */
export function declaredFunctions(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/(?:^|[;{}\s])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]!);
  return [...names];
}

/** Make functions global; the returned undo removes those still in place. */
function exportGlobals(fns: Record<string, unknown>): (() => void) | undefined {
  const entries = Object.entries(fns);
  if (entries.length === 0) return undefined;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [name, fn] of entries) g[name] = fn;
  return () => {
    for (const [name, fn] of entries) if (g[name] === fn) delete g[name];
  };
}

function wrapCleanup(fn: () => void, label: string): () => void {
  return () => {
    try { fn(); } catch (err) { console.error(`Veneer: the cleanup for ${label} failed:`, err); }
  };
}
