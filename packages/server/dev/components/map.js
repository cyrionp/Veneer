// Veneer component: a map of an address shown on the screen.
//
// Place it in a box near the address (Page tab ▸ Components ▸ Map). Options:
//   address   required: where the address is on the screen, as a list of parts.
//             "6:22" is the field starting at row 6, column 22 (what the user
//             has typed included), or else the screen text there up to the
//             next double space. "6:22:30" takes exactly 30 characters. A part
//             can also mix positions and text: "{8:22} {8:45}, USA".
//   title     a caption above the map, e.g. "Ship to"
//   provider  "openstreetmap" (default) or "google"
//   apiKey    Google Maps Embed API key (provider "google"); without one, the
//             keyless Google Maps embed is used
//   zoom      1 (the world) to 19 (a building); default 15 (streets)
//   geocoder  OpenStreetMap only: a Nominatim-compatible search URL; default
//             https://nominatim.openstreetmap.org/search
//   link      false hides the "Open in maps" link
//
// The address leaves the site: it goes to the map provider (and, for
// OpenStreetMap, to the geocoder that finds it). In the designer the map is
// not loaded until the designer clicks "Show map".
//
// The map redraws when the address changes (another record, or an edited
// address), a moment after the change so typing doesn't reload it on every key.

export const label = 'Map';

export const DEFAULTS = Object.freeze({
  provider: 'openstreetmap',
  zoom: 15,
  geocoder: 'https://nominatim.openstreetmap.org/search',
});

/** How long the address must stay the same before the map is redrawn, in ms. */
export const SETTLE_MS = 400;

const POSITION = /^(\d{1,3}):(\d{1,3})(?::(\d{1,3}))?$/;
const PLACEHOLDER = /\{(\d{1,3}):(\d{1,3})(?::(\d{1,3}))?\}/g;

/**
 * The text at a screen position: the input field starting there (its current
 * value, including typing not yet sent), or else the screen text up to the
 * next double space. With a length, exactly that many characters. Trimmed.
 */
export function readPosition(ctx, row, col, length) {
  const field = ctx.screen.fields.find((f) => f.row === row && f.col === col);
  if (field) {
    const value = ctx.getField?.(field.id) ?? field.value;
    return (length ? value.slice(0, length) : value).trim();
  }
  const rest = (ctx.screen.lines[row - 1] ?? '').slice(col - 1);
  return (length ? rest.slice(0, length) : rest.split('  ')[0]).trim();
}

/**
 * The address the options point at, as one line ("1 Main St, Springfield, IL").
 * Blank when every position in it is blank, so fixed text such as a country
 * never makes a map on its own.
 */
export function readAddress(ctx) {
  const option = ctx.options?.address;
  const parts = typeof option === 'string' ? [option] : Array.isArray(option) ? option : [];
  let found = false;
  const read = (row, col, length) => {
    const value = readPosition(ctx, Number(row), Number(col), length ? Number(length) : undefined);
    if (value) found = true;
    return value;
  };
  const out = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const p = part.trim();
    const m = POSITION.exec(p);
    const text = m ? read(m[1], m[2], m[3]) : p.replace(PLACEHOLDER, (_all, r, c, l) => read(r, c, l));
    const clean = text.replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
    if (clean) out.push(clean);
  }
  return found ? out.join(', ') : '';
}

/** True for an https URL, or http on this machine (a geocoder run locally). */
function allowedUrl(text) {
  try {
    const url = new URL(text);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The options, checked, with defaults filled in. `error` explains a bad option. */
export function settings(options = {}) {
  const raw = String(options.provider ?? DEFAULTS.provider).trim().toLowerCase();
  const provider = raw === 'osm' ? 'openstreetmap' : raw;
  const zoomNumber = Math.round(Number(options.zoom ?? DEFAULTS.zoom));
  const s = {
    provider,
    zoom: Number.isFinite(zoomNumber) ? Math.min(19, Math.max(1, zoomNumber)) : DEFAULTS.zoom,
    apiKey: typeof options.apiKey === 'string' ? options.apiKey.trim() : '',
    geocoder: typeof options.geocoder === 'string' && options.geocoder.trim() ? options.geocoder.trim() : DEFAULTS.geocoder,
    title: typeof options.title === 'string' ? options.title.trim() : '',
    link: options.link !== false,
    error: '',
  };
  if (provider !== 'openstreetmap' && provider !== 'google') {
    s.error = `Unknown map provider "${options.provider}": use "openstreetmap" or "google"`;
  } else if (provider === 'openstreetmap' && !allowedUrl(s.geocoder)) {
    s.error = `The geocoder must be an https:// address (got "${s.geocoder}")`;
  }
  return s;
}

/** Google Maps: the embed and the full-map link for an address. No lookup needed. */
export function googleUrls(address, s) {
  const q = encodeURIComponent(address);
  const embed = s.apiKey
    ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(s.apiKey)}&q=${q}&zoom=${s.zoom}`
    : `https://maps.google.com/maps?q=${q}&z=${s.zoom}&output=embed`;
  return { embed, link: `https://www.google.com/maps/search/?api=1&query=${q}` };
}

const fixed = (n) => Number(n.toFixed(6));

/**
 * OpenStreetMap: the embed (a box around the place, with a marker) and the
 * full-map link. At zoom z a 256-pixel tile spans 360/2^z degrees of
 * longitude; the box is about two tiles wide, and as tall as that is on the
 * ground at this latitude.
 */
export function osmUrls(place, s) {
  const lat = fixed(place.lat);
  const lon = fixed(place.lon);
  const halfWidth = 360 / 2 ** s.zoom;
  const halfHeight = halfWidth * Math.max(0.05, Math.cos((lat * Math.PI) / 180)) * 0.6;
  const bbox = [
    fixed(Math.max(-180, lon - halfWidth)), fixed(Math.max(-85, lat - halfHeight)),
    fixed(Math.min(180, lon + halfWidth)), fixed(Math.min(85, lat + halfHeight)),
  ].join(',');
  return {
    embed: `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`,
    link: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${s.zoom}/${lat}/${lon}`,
  };
}

/** OpenStreetMap search for an address the geocoder couldn't place. */
export function osmSearchUrl(address) {
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`;
}

/** Lookups by geocoder and address: shared by every map on the page, newest last. */
const lookups = new Map();
const MAX_LOOKUPS = 200;

/** For tests: forget earlier lookups. */
export function clearLookups() {
  lookups.clear();
}

/**
 * Find an address's coordinates with a Nominatim-compatible geocoder:
 * { lat, lon } or null when it isn't found. Each address is looked up once per
 * page (Nominatim's usage policy asks for no repeated queries); a failed
 * request is forgotten so the next attempt tries again.
 */
export function geocode(address, s, fetchImpl = globalThis.fetch) {
  const key = `${s.geocoder}\n${address}`;
  const known = lookups.get(key);
  if (known) return known;
  const url = new URL(s.geocoder);
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  // The page's own policy sends no Referer; Nominatim asks to know the site.
  const lookup = Promise.resolve()
    .then(() => fetchImpl(url.href, { headers: { Accept: 'application/json' }, referrerPolicy: 'strict-origin' }))
    .then((res) => {
      if (!res.ok) throw new Error(`the geocoder answered ${res.status}`);
      return res.json();
    })
    .then((list) => {
      const hit = Array.isArray(list) ? list[0] : undefined;
      const lat = Number.parseFloat(hit?.lat);
      const lon = Number.parseFloat(hit?.lon);
      return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
    });
  lookups.set(key, lookup);
  if (lookups.size > MAX_LOOKUPS) lookups.delete(lookups.keys().next().value);
  lookup.catch(() => {
    if (lookups.get(key) === lookup) lookups.delete(key);
  });
  return lookup;
}

const CSS = `
  .vc-map { margin: 0; height: 100%; display: flex; flex-direction: column; gap: 4px; font-size: 12px; min-height: 0; }
  .vc-map .vc-map-title { font-weight: 650; }
  .vc-map iframe { flex: 1; width: 100%; min-height: 0; border: 1px solid var(--border, #ccc); border-radius: 4px; background: var(--surface-muted, #f3f4f6); }
  .vc-map .vc-map-note { margin: auto; padding: 0 8px; text-align: center; color: var(--text-muted, #666); }
  .vc-map .vc-map-note button { margin-top: 6px; }
  .vc-map a { align-self: flex-end; color: var(--accent, #2563eb); }
`;

export function mount(element, ctx) {
  const doc = element.ownerDocument;
  let current = ctx;
  /** What is drawn now (address, settings, design state), to skip redrawing the same map. */
  let drawn = null;
  /** Bumped by every draw and by unmount: a lookup answers only the draw that asked. */
  let run = 0;
  let timer = null;
  /** In the designer: the designer asked to see the map. */
  let preview = false;

  const root = doc.createElement('figure');
  root.className = 'vc-map';
  element.append(root);

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const stateOf = (c) => {
    const s = settings(c.options);
    const address = readAddress(c);
    const hidden = Boolean(c.design) && !preview;
    return { s, address, hidden, key: JSON.stringify([address, s, hidden]) };
  };

  /** Start again: the style, the title, then `body`. */
  const reset = (s, ...body) => {
    const style = el('style');
    style.textContent = CSS;
    root.replaceChildren(style, ...(s.title ? [el('div', 'vc-map-title', s.title)] : []), ...body);
  };
  const note = (s, text, ...more) => {
    const p = el('p', 'vc-map-note', text);
    p.setAttribute('role', 'status');
    for (const m of more) p.append(m);
    reset(s, p);
  };
  const link = (href, text) => {
    const a = el('a', 'vc-map-link', text);
    a.href = href;
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return a;
  };
  const showMap = (s, address, { embed, link: href }) => {
    const frame = el('iframe');
    // The sandbox is set before the address, so the map never loads without it.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('loading', 'lazy');
    frame.title = `Map of ${address}`;
    frame.src = embed;
    reset(s, frame, ...(s.link ? [link(href, 'Open in maps')] : []));
  };

  const draw = () => {
    timer = null;
    const { s, address, hidden, key } = stateOf(current);
    if (key === drawn) return;
    drawn = key;
    const mine = ++run;
    if (s.error) return note(s, s.error);
    if (!address) {
      const set = current.options?.address !== undefined;
      return note(s, set ? 'No address on this screen' : 'Set the "address" option to where the address is, e.g. ["6:22", "7:22"]');
    }
    if (hidden) {
      const button = el('button', '', 'Show map');
      button.type = 'button';
      button.addEventListener('click', () => {
        preview = true;
        draw();
      });
      return note(s, `${address}. The map isn't loaded while designing, so the address isn't sent to the map provider until you ask.`, el('br'), button);
    }
    if (s.provider === 'google') return showMap(s, address, googleUrls(address, s));
    note(s, 'Finding the address…');
    geocode(address, s).then(
      (place) => {
        if (mine !== run) return;
        if (place) return showMap(s, address, osmUrls(place, s));
        note(s, `Couldn't find ${address} on the map. `, ...(s.link ? [link(osmSearchUrl(address), 'Search for it')] : []));
      },
      (err) => {
        if (mine !== run) return;
        // Let the next update try again.
        drawn = null;
        note(s, `The map couldn't be loaded: ${err?.message ?? err}`);
      },
    );
  };

  draw();
  return {
    update(next) {
      current = next;
      if (stateOf(next).key === drawn) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(draw, SETTLE_MS);
    },
    unmount() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      run++;
      root.remove();
    },
  };
}
