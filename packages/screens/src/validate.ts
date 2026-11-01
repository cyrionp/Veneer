// Strict validation of screen definitions from files or the designer API.

import { isWebTemplate, placeholders } from './links.ts';
import { STYLE_TESTS } from './styles.ts';
import { CORNERS, DATE_FORMATS, DENSITIES, FONTS, LOOKS, ROLES, SCREEN_EVENTS, SITE_EVENTS, STYLE_TARGETS, type Change, type ComponentOptions, type StyleCondition, type KeyAction, type ScreenEvent, type SiteCustomization, type SiteStyle, type ScreenDefinition, type TabBand, type Target, type TextMatch, type Widget } from './types.ts';

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AID = /^(Enter|Help|PageUp|PageDown|Print|Clear|RecordBackspace|F([1-9]|1\d|2[0-4]))$/;
const FIELD_ID = /^\d{1,3}:\d{1,3}$/;
const SCREEN_ID = /^[0-9a-f]{8,32}$/;
const MAX_CHANGES = 500;
const MAX_TABS = 10;
/** Limits for custom code, in characters. */
export const MAX_CSS = 64 * 1024;
export const MAX_SCRIPT = 64 * 1024;
export const MAX_HTML = 16 * 1024;
export const MAX_OPTIONS = 16 * 1024;

export class DefinitionError extends Error {
  override name = 'DefinitionError';
}

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new DefinitionError(`${path}: ${message}`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  return v as Obj;
}

function str(v: unknown, path: string, max = 200): string {
  if (typeof v !== 'string' || v.length > max) fail(path, `must be a string of at most ${max} characters`);
  return v;
}

function condition(v: unknown, path: string): StyleCondition {
  const o = obj(v, path);
  if ((o.column === undefined) === (o.at === undefined)) fail(path, 'needs either column or at');
  const when: StyleCondition = o.column !== undefined
    ? { column: str(o.column, `${path}.column`, 132) }
    : { at: target(o.at, `${path}.at`) };
  const tests = STYLE_TESTS.filter((t) => o[t] !== undefined);
  if (tests.length !== 1) fail(path, `needs exactly one of ${STYLE_TESTS.join(', ')}`);
  const test = tests[0]!;
  if (test === 'lessThan' || test === 'greaterThan') {
    if (typeof o[test] !== 'number' || !Number.isFinite(o[test])) fail(`${path}.${test}`, 'must be a number');
    when[test] = o[test] as number;
  } else {
    when[test] = str(o[test], `${path}.${test}`, 200);
    if (test === 'matches') {
      try { new RegExp(when.matches!, 'i'); } catch { fail(`${path}.matches`, 'is not a valid regular expression'); }
    }
  }
  return when;
}

function urlTemplate(v: unknown, path: string): string {
  const url = str(v, path, 2000);
  if (!isWebTemplate(url)) fail(path, 'must start with http:// or https:// and a host name (no placeholders in the host)');
  for (const p of placeholders(url)) {
    if (p.row < 1 || p.row > 27 || p.col < 1 || p.col > 132 || p.length === 0) fail(path, `{${p.row}:${p.col}} is not a screen position`);
  }
  return url;
}

function int(v: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail(path, `must be an integer ${min}-${max}`);
  return v as number;
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail(path, `must be an array of at most ${max} items`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) fail(path, `must be one of ${allowed.join(', ')}`);
  return v as T;
}

function target(v: unknown, path: string): Target {
  const o = obj(v, path);
  return { row: int(o.row, `${path}.row`, 1, 27), col: int(o.col, `${path}.col`, 1, 132) };
}

function textMatch(v: unknown, path: string): TextMatch {
  const o = obj(v, path);
  const text = str(o.text, `${path}.text`, 132);
  if (text.trim() === '') fail(`${path}.text`, 'must not be blank');
  return { ...target(o, path), text };
}

function widget(v: unknown, path: string): Widget {
  const o = obj(v, path);
  switch (o.type) {
    case 'select':
      return {
        type: 'select',
        options: arr(o.options, `${path}.options`, 200).map((x, i) => {
          const opt = obj(x, `${path}.options[${i}]`);
          return { value: str(opt.value, `${path}.options[${i}].value`, 132), label: str(opt.label, `${path}.options[${i}].label`) };
        }),
      };
    case 'checkbox':
      return { type: 'checkbox', on: str(o.on, `${path}.on`, 132), off: str(o.off, `${path}.off`, 132) };
    case 'date':
      return { type: 'date', format: oneOf(o.format, DATE_FORMATS, `${path}.format`) };
    default:
      fail(`${path}.type`, 'must be select, checkbox or date');
  }
}

function change(v: unknown, path: string): Change {
  const o = obj(v, path);
  switch (o.op) {
    case 'hide': return { op: 'hide', at: target(o.at, `${path}.at`) };
    case 'text': return { op: 'text', at: target(o.at, `${path}.at`), text: str(o.text, `${path}.text`) };
    case 'role': return { op: 'role', at: target(o.at, `${path}.at`), role: oneOf(o.role, ROLES, `${path}.role`) };
    case 'widget': {
      const field = str(o.field, `${path}.field`, 7);
      if (!FIELD_ID.test(field)) fail(`${path}.field`, 'must be a field id like "6:53"');
      return { op: 'widget', field, widget: widget(o.widget, `${path}.widget`) };
    }
    case 'button': {
      const a = obj(o.action, `${path}.action`);
      const label = str(o.label, `${path}.label`, 60);
      if (a.url !== undefined) return { op: 'button', label, action: { url: urlTemplate(a.url, `${path}.action.url`) } };
      const aid = str(a.aid, `${path}.action.aid`, 20);
      if (!AID.test(aid)) fail(`${path}.action.aid`, 'must be an AID key such as Enter or F3');
      const action: KeyAction = { aid: aid as never };
      if (a.fields !== undefined) {
        const f = obj(a.fields, `${path}.action.fields`);
        action.fields = {};
        for (const [id, value] of Object.entries(f)) {
          if (!FIELD_ID.test(id)) fail(`${path}.action.fields`, `"${id.slice(0, 20)}" is not a field id`);
          action.fields[id] = str(value, `${path}.action.fields["${id}"]`, 132);
        }
      }
      return { op: 'button', label, action };
    }
    case 'move':
      return { op: 'move', at: target(o.at, `${path}.at`), to: target(o.to, `${path}.to`) };
    case 'style': {
      const when = condition(o.when, `${path}.when`);
      const targetOf = oneOf(o.target, STYLE_TARGETS, `${path}.target`);
      if (when.column !== undefined && targetOf === 'item') fail(`${path}.target`, 'must be row or cell for a column condition');
      if (when.at !== undefined && targetOf !== 'item') fail(`${path}.target`, 'must be item for a condition on a position');
      return { op: 'style', when, role: oneOf(o.role, ROLES, `${path}.role`), target: targetOf };
    }
    case 'card': {
      const from = target(o.from, `${path}.from`);
      const to = target(o.to, `${path}.to`);
      if (to.row < from.row || to.col < from.col) fail(`${path}.to`, 'must be below and to the right of from');
      const title = o.title === undefined || o.title === '' ? undefined : str(o.title, `${path}.title`, 60);
      return { op: 'card', from, to, ...(title !== undefined ? { title } : {}) };
    }
    case 'tabs': {
      const tabs = arr(o.tabs, `${path}.tabs`, MAX_TABS).map((x, i): TabBand => {
        const t = obj(x, `${path}.tabs[${i}]`);
        const title = str(t.title, `${path}.tabs[${i}].title`, 40);
        if (title.trim() === '') fail(`${path}.tabs[${i}].title`, 'must not be blank');
        const from = int(t.from, `${path}.tabs[${i}].from`, 1, 27);
        const to = int(t.to, `${path}.tabs[${i}].to`, from, 27);
        return { title, from, to };
      });
      if (tabs.length < 2) fail(`${path}.tabs`, 'needs at least two tabs');
      tabs.forEach((t, i) => {
        if (i > 0 && t.from !== tabs[i - 1]!.to + 1) fail(`${path}.tabs[${i}].from`, `must be ${tabs[i - 1]!.to + 1}, the row after the tab before`);
      });
      return { op: 'tabs', tabs };
    }
    case 'component': {
      const name = str(o.name, `${path}.name`, 64);
      if (!ID_PATTERN.test(name)) fail(`${path}.name`, 'must be a component name: lowercase letters, digits and dashes');
      let field: string | undefined;
      if (o.field !== undefined) {
        field = str(o.field, `${path}.field`, 7);
        if (!FIELD_ID.test(field)) fail(`${path}.field`, 'must be a field id like "6:53"');
      }
      let options: ComponentOptions | undefined;
      if (o.options !== undefined) {
        const json = JSON.stringify(obj(o.options, `${path}.options`));
        if (json.length > MAX_OPTIONS) fail(`${path}.options`, `must be at most ${MAX_OPTIONS} characters of JSON`);
        options = JSON.parse(json) as ComponentOptions;
      }
      return {
        op: 'component', name,
        at: target(o.at, `${path}.at`),
        width: int(o.width, `${path}.width`, 1, 132),
        height: int(o.height, `${path}.height`, 1, 27),
        ...(field !== undefined ? { field } : {}),
        ...(options !== undefined ? { options } : {}),
      };
    }
    case 'html':
      return {
        op: 'html',
        at: target(o.at, `${path}.at`),
        html: str(o.html, `${path}.html`, MAX_HTML),
        width: int(o.width, `${path}.width`, 1, 132),
        height: int(o.height, `${path}.height`, 1, 27),
        ...(o.css !== undefined && o.css !== '' ? { css: str(o.css, `${path}.css`, MAX_CSS) } : {}),
        ...(o.script !== undefined && o.script !== '' ? { script: str(o.script, `${path}.script`, MAX_SCRIPT) } : {}),
      };
    default:
      fail(`${path}.op`, 'must be hide, text, role, widget, button, move, style, card, tabs, component or html');
  }
}

/** At most one set of tabs, and no card split between two tabs (or half outside them). */
function checkLayout(changes: Change[]): void {
  const tabs = changes.filter((c) => c.op === 'tabs');
  if (tabs.length > 1) fail('changes', 'may have only one tabs change');
  const bands = tabs[0]?.tabs;
  if (!bands) return;
  const bandOf = (row: number) => bands.findIndex((b) => row >= b.from && row <= b.to);
  changes.forEach((c, i) => {
    if (c.op === 'card' && bandOf(c.from.row) !== bandOf(c.to.row)) fail(`changes[${i}]`, 'a card must not be split between tabs');
  });
}

/** Validate untrusted input; returns a clean definition (unknown keys dropped). */
export function validateDefinition(input: unknown): ScreenDefinition {
  const o = obj(input, 'definition');
  const id = str(o.id, 'id', 64);
  if (!ID_PATTERN.test(id)) fail('id', 'must be lowercase letters, digits and dashes');
  const name = str(o.name, 'name', 100);
  if (name.trim() === '') fail('name', 'must not be blank');
  const m = obj(o.match, 'match');
  const text = arr(m.text ?? [], 'match.text', 20).map((x, i) => textMatch(x, `match.text[${i}]`));
  const screenIds = arr(m.screenIds ?? [], 'match.screenIds', 20).map((x, i) => {
    const sid = str(x, `match.screenIds[${i}]`, 32);
    if (!SCREEN_ID.test(sid)) fail(`match.screenIds[${i}]`, 'must be a screen id (hex digits)');
    return sid;
  });
  if (text.length === 0 && screenIds.length === 0) fail('match', 'needs a screen id or at least one text rule');
  const def: ScreenDefinition = {
    id,
    name,
    match: {
      ...(screenIds.length > 0 ? { screenIds } : {}),
      ...(m.rows !== undefined ? { rows: int(m.rows, 'match.rows', 24, 27) } : {}),
      ...(m.cols !== undefined ? { cols: int(m.cols, 'match.cols', 80, 132) } : {}),
      text,
    },
    changes: arr(o.changes ?? [], 'changes', MAX_CHANGES).map((x, i) => change(x, `changes[${i}]`)),
  };
  checkLayout(def.changes);
  if (o.title !== undefined) def.title = str(o.title, 'title', 100);
  if (o.css !== undefined && o.css !== '') def.css = str(o.css, 'css', MAX_CSS);
  const scripts: Partial<Record<ScreenEvent, string>> = {};
  // Older definitions had one `script`, run each time the screen was drawn.
  if (o.script !== undefined && o.script !== '') scripts.show = str(o.script, 'script', MAX_SCRIPT);
  if (o.scripts !== undefined) {
    for (const [event, code] of Object.entries(obj(o.scripts, 'scripts'))) {
      if (!(SCREEN_EVENTS as readonly string[]).includes(event)) fail(`scripts.${event.slice(0, 20)}`, `must be one of ${SCREEN_EVENTS.join(', ')}`);
      if (code !== '') scripts[event as ScreenEvent] = str(code, `scripts.${event}`, MAX_SCRIPT);
    }
  }
  if (Object.keys(scripts).length > 0) def.scripts = scripts;
  return def;
}

/** Validate site-wide CSS and JavaScript from the designer API. */
export function validateSite(input: unknown): SiteCustomization {
  const o = obj(input, 'site');
  const s = obj(o.scripts ?? {}, 'scripts');
  for (const event of Object.keys(s)) {
    if (!(SITE_EVENTS as readonly string[]).includes(event)) fail(`scripts.${event.slice(0, 20)}`, `must be one of ${SITE_EVENTS.join(', ')}`);
  }
  // A `style` from a designer page opened before themes is ignored: themes replaced it.
  return {
    css: str(o.css ?? '', 'css', MAX_CSS),
    scripts: { load: str(s.load ?? '', 'scripts.load', MAX_SCRIPT), screen: str(s.screen ?? '', 'scripts.screen', MAX_SCRIPT) },
  };
}

/** An old site style (global.style.json), read when upgrading to themes. Only listed values pass. */
export function validateStyle(input: unknown, path = 'style'): SiteStyle {
  const o = obj(input, path);
  for (const key of Object.keys(o)) {
    if (!['look', 'accent', 'corners', 'density', 'font'].includes(key)) fail(`${path}.${key.slice(0, 20)}`, 'is not a style option');
  }
  const style: SiteStyle = { look: oneOf(o.look ?? 'default', LOOKS, `${path}.look`) };
  if (o.accent !== undefined) {
    if (typeof o.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(o.accent)) fail(`${path}.accent`, 'must be a hex color such as #0a7f5a');
    style.accent = o.accent;
  }
  if (o.corners !== undefined) style.corners = oneOf(o.corners, CORNERS, `${path}.corners`);
  if (o.density !== undefined) style.density = oneOf(o.density, DENSITIES, `${path}.density`);
  if (o.font !== undefined) style.font = oneOf(o.font, FONTS, `${path}.font`);
  return style;
}
