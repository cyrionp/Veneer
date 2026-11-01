// Veneer component: a list on the screen shown as cards, one per row.
//
// Place it over the list (Page tab ▸ Components ▸ Cards) and hide the list,
// its option legend and its More.../Bottom marker. Options (columns are found
// by their heading, ignoring case):
//   title     the column for each card's title; default the first column
//             after the option column
//   subtitle  a column shown under the title
//   fields    columns shown on each card as "heading: value", e.g.
//             ["Phone", "Status"]; default every other column
//   actions   which of the list's options to offer as buttons, in order, by
//             their value, e.g. ["5", "2"]; default all of the legend's
//             options; [] for none
//   default   the option a click on the card (or Enter on it) runs, e.g. "5"
//   pager     false hides the Previous / Next buttons
//   width     the narrowest a card gets, in pixels; default 220
//   empty     what to say when the list has no rows; default "Nothing to show"
//
// An action types the option into the row's option field and presses Enter,
// as a user would. Cards take a style rule's role (a "danger" row becomes a
// danger card). Arrow keys move between cards.

export const label = 'Cards';

export const DEFAULTS = Object.freeze({ width: 220, empty: 'Nothing to show' });

/**
 * After a press the buttons wait for the next screen, so a double click sends
 * one key. If no screen comes (the key was not sent), they come back after this, in ms.
 */
export const BUSY_MS = 5000;

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const ROLES = new Set(['emphasis', 'muted', 'danger', 'warning', 'accent', 'accent2']);

/** The options, checked; `error` says what is wrong. */
export function settings(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const s = {
    title: text(o.title),
    subtitle: text(o.subtitle),
    fields: null,
    actions: null,
    default: o.default === undefined || o.default === null ? '' : String(o.default).trim(),
    pager: o.pager !== false,
    width: DEFAULTS.width,
    empty: text(o.empty) || DEFAULTS.empty,
    error: '',
  };
  if (o.fields !== undefined) {
    if (!Array.isArray(o.fields) || o.fields.some((f) => typeof f !== 'string')) s.error = '"fields" must be a list of column headings';
    else s.fields = o.fields.map((f) => f.trim()).filter(Boolean);
  }
  if (o.actions !== undefined) {
    if (!Array.isArray(o.actions) || o.actions.some((a) => typeof a !== 'string' && typeof a !== 'number')) {
      s.error = '"actions" must be a list of option values, such as ["5", "2"]';
    } else s.actions = o.actions.map((a) => String(a).trim()).filter(Boolean);
  }
  if (o.width !== undefined) {
    const n = Number(o.width);
    if (Number.isFinite(n) && n > 0) s.width = Math.round(Math.min(Math.max(n, 120), 600));
    else s.error = '"width" must be a number of pixels';
  }
  return s;
}

/** The list to show: the first one with every heading the options name, else the first list. */
export function pickTable(tables, s) {
  const named = [s.title, s.subtitle, ...(s.fields ?? [])].filter(Boolean);
  const has = (t) => named.every((h) => t.columns.some((c) => same(c, h)));
  return (tables ?? []).find(has) ?? (named.length === 0 ? tables?.[0] : undefined);
}

/** The option column's index, or -1: where the rows' option fields are. */
function optionColumn(table) {
  for (const r of table.records ?? []) {
    if (r.option) {
      const k = r.fields.indexOf(r.option);
      if (k >= 0) return k;
    }
  }
  return -1;
}

/** What goes on the cards: which column is the title, subtitle, and each fact. */
export function layout(table, s) {
  const find = (h) => (h ? table.columns.findIndex((c) => same(c, h)) : -1);
  const opt = optionColumn(table);
  const others = table.columns.map((_, k) => k).filter((k) => k !== opt);
  const title = s.title ? find(s.title) : (others[0] ?? -1);
  const subtitle = find(s.subtitle);
  const facts = s.fields
    ? s.fields.map(find).filter((k) => k >= 0)
    : others.filter((k) => k !== title && k !== subtitle);
  return { title, subtitle, facts };
}

/** One card per row of the list. */
export function cardsOf(table, s) {
  const { title, subtitle, facts } = layout(table, s);
  const records = table.records ?? table.rows.map((cells, i) => ({ row: i, cells, fields: [], option: null, role: null, roles: [] }));
  return records.map((r) => ({
    record: r,
    title: r.cells[title] ?? '',
    subtitle: subtitle >= 0 ? (r.cells[subtitle] ?? '') : '',
    facts: facts.map((k) => ({ label: table.columns[k] ?? '', value: r.cells[k] ?? '', role: ROLES.has(r.roles?.[k]) ? r.roles[k] : '' })),
    role: ROLES.has(r.role) ? r.role : '',
  }));
}

/** The options offered as buttons: the legend's, or those `actions` names, in its order. */
export function actionsOf(table, s) {
  const legend = table.options ?? [];
  if (!s.actions) return legend.map((o) => ({ value: o.value, label: o.label }));
  return s.actions.map((v) => legend.find((o) => o.value === v) ?? { value: v, label: `Option ${v}` });
}

/** The default option's label, for the card's tooltip and screen readers. */
export function defaultAction(table, s) {
  if (!s.default) return null;
  return (table.options ?? []).find((o) => o.value === s.default) ?? { value: s.default, label: `Option ${s.default}` };
}

/** Type the option into the row's option field and press Enter. False when the row has none. */
export function run(ctx, record, value) {
  if (!record.option || !value) return false;
  ctx.press('Enter', { [record.option]: value });
  return true;
}

const CSS = `
.vc-cards { height: 100%; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.vc-cards .vc-cards-grid { flex: 1; min-height: 0; overflow: auto; display: grid; gap: 8px; align-content: start;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--vc-card-width), 100%), 1fr)); padding: 2px; margin: 0; list-style: none; }
.vc-cards .vc-card { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border, #ccc);
  border-left: 4px solid var(--border, #ccc); border-radius: 8px; background: var(--surface, #fff); min-width: 0; }
.vc-cards .vc-card.vc-card-clickable { cursor: pointer; }
.vc-cards .vc-card.vc-card-clickable:hover { border-color: var(--accent, #2563eb); }
.vc-cards .vc-card:focus-visible { outline: 2px solid var(--focus, var(--accent, #2563eb)); outline-offset: 1px; }
.vc-cards .vc-card h3 { margin: 0; font-size: 1.05em; font-weight: 650; color: var(--text-strong, inherit); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-cards .vc-card .vc-card-sub { margin: 0; color: var(--text-muted, #666); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-cards .vc-card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0 8px; }
.vc-cards .vc-card dt { color: var(--text-muted, #666); }
.vc-cards .vc-card dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vc-cards .vc-card-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: auto; padding-top: 4px; }
.vc-cards button { font: inherit; font-size: 0.9em; padding: 2px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border, #ccc); background: var(--surface-2, #f4f4f5); color: var(--text, inherit); }
.vc-cards button:hover:not(:disabled) { border-color: var(--accent, #2563eb); }
.vc-cards button:disabled { opacity: 0.5; cursor: default; }
.vc-cards .vc-cards-pager { display: flex; justify-content: flex-end; gap: 6px; }
.vc-cards .vc-cards-message { margin: auto; color: var(--text-muted, #666); text-align: center; }
.vc-cards .vc-role-danger { border-left-color: var(--danger, #dc2626); }
.vc-cards .vc-role-warning { border-left-color: var(--warning, #d97706); }
.vc-cards .vc-role-accent, .vc-cards .vc-role-emphasis { border-left-color: var(--accent, #2563eb); }
.vc-cards .vc-role-accent2 { border-left-color: var(--accent-2, #7c3aed); }
.vc-cards .vc-card.vc-role-muted :is(h3, .vc-card-sub, dl) { opacity: 0.6; }
.vc-cards dd.vc-role-danger { color: var(--danger, #dc2626); }
.vc-cards dd.vc-role-warning { color: var(--warning, #d97706); }
.vc-cards dd.vc-role-accent, .vc-cards dd.vc-role-emphasis { color: var(--accent, #2563eb); }
.vc-cards dd.vc-role-accent2 { color: var(--accent-2, #7c3aed); }
`;

export function mount(element, ctx) {
  const doc = element.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'vc-cards';
  element.append(root);
  let current = ctx;
  /** What draw made: the cards in order, and every button. */
  let cardEls = [];
  let buttons = [];
  /** Set after a key is pressed, until the next screen comes: one press per screen. */
  let busy = false;
  let busyTimer;

  const make = (tag, className, content) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  };
  const button = (className, label, onClick) => {
    const b = make('button', className, label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation(); // not also the card's click
      onClick();
    });
    buttons.push(b);
    return b;
  };

  const setBusy = (on) => {
    clearTimeout(busyTimer);
    busy = on;
    if (on) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    for (const b of buttons) b.disabled = on;
  };
  const press = (fn) => {
    if (busy || current.design) return;
    setBusy(true);
    busyTimer = setTimeout(() => setBusy(false), BUSY_MS);
    fn();
  };

  function focusCard(i) {
    cardEls.forEach((el, k) => el.setAttribute('tabindex', k === i ? '0' : '-1'));
    cardEls[i]?.focus();
  }

  const draw = () => {
    const s = settings(current.options);
    const style = make('style');
    style.textContent = CSS;
    root.style.setProperty('--vc-card-width', `${s.width}px`);
    // Keep the keyboard on the same card (or the last one) after paging.
    const active = doc.activeElement;
    const focused = active && root.contains(active) ? Math.max(0, cardEls.findIndex((el) => el.contains(active))) : -1;
    cardEls = [];
    buttons = [];

    const message = (t) => root.replaceChildren(style, make('p', 'vc-cards-message', t));
    if (s.error) return message(`Cards: ${s.error}`);
    const table = pickTable(current.tables, s);
    if (!table) {
      const named = [s.title, s.subtitle, ...(s.fields ?? [])].filter(Boolean);
      return message(named.length ? `No list on this screen has the columns ${named.map((h) => `“${h}”`).join(', ')}` : 'No list on this screen');
    }
    const cards = cardsOf(table, s);
    const actions = actionsOf(table, s);
    const fallback = defaultAction(table, s);

    const grid = make('ul', 'vc-cards-grid');
    grid.setAttribute('role', 'list');
    cards.forEach((c, i) => {
      const canRun = !!(fallback && c.record.option);
      const card = make('li', ['vc-card', c.role && `vc-role-${c.role}`, canRun && 'vc-card-clickable'].filter(Boolean).join(' '));
      card.setAttribute('tabindex', i === Math.max(focused, 0) ? '0' : '-1');
      card.setAttribute('aria-label', [c.title, c.subtitle].filter(Boolean).join(', '));
      if (canRun) {
        card.title = fallback.label;
        card.addEventListener('click', () => press(() => run(current, c.record, fallback.value)));
      }
      card.addEventListener('keydown', (e) => {
        if (e.target !== card) return; // a key on one of its buttons
        const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
        if (move !== undefined) {
          e.preventDefault();
          focusCard(Math.min(Math.max(i + move, 0), cards.length - 1));
        } else if (e.key === 'Enter' && canRun) {
          e.preventDefault();
          e.stopPropagation(); // not also Enter for the screen
          press(() => run(current, c.record, fallback.value));
        }
      });
      card.append(make('h3', '', c.title || '—'));
      if (c.subtitle) card.append(make('p', 'vc-card-sub', c.subtitle));
      if (c.facts.length) {
        const dl = make('dl');
        for (const f of c.facts) dl.append(make('dt', '', f.label), make('dd', f.role ? `vc-role-${f.role}` : '', f.value));
        card.append(dl);
      }
      if (c.record.option && actions.length) {
        const bar = make('div', 'vc-card-actions');
        for (const a of actions) {
          const b = button('', a.label, () => press(() => run(current, c.record, a.value)));
          b.setAttribute('data-option', a.value);
          b.setAttribute('aria-label', `${a.label} ${c.title}`.trim());
          bar.append(b);
        }
        card.append(bar);
      }
      cardEls.push(card);
      grid.append(card);
    });

    const parts = [style, cards.length ? grid : make('p', 'vc-cards-message', s.empty)];
    if (s.pager) {
      const pager = make('nav', 'vc-cards-pager');
      pager.setAttribute('aria-label', 'Pages');
      pager.append(button('vc-cards-previous', 'Previous', () => press(() => current.press('PageUp'))));
      if (table.more) pager.append(button('vc-cards-next', 'Next', () => press(() => current.press('PageDown'))));
      parts.push(pager);
    }
    root.replaceChildren(...parts);
    if (focused >= 0 && cards.length) focusCard(Math.min(focused, cards.length - 1));
  };

  draw();
  return {
    update(next) {
      current = next;
      setBusy(false);
      draw();
    },
    unmount() {
      clearTimeout(busyTimer);
      root.remove();
    },
  };
}
