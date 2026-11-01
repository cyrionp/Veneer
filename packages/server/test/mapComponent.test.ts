// The map component (dev/components/map.js): reading the address from the
// screen, the provider URLs, geocoding, and what it draws, with a small fake
// DOM (components only use createElement, append, attributes and events).

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import * as map from '../dev/components/map.js';

// ---- a screen and a component context

interface Field { id: string; row: number; col: number; length: number; value: string }

/** Screen lines from row → text at column, 80 columns wide. */
function lines(rows: Record<number, Array<[number, string]>>): string[] {
  return Array.from({ length: 24 }, (_, i) => {
    const line = Array(80).fill(' ');
    for (const [col, text] of rows[i + 1] ?? []) [...text].forEach((ch, j) => { line[col - 1 + j] = ch; });
    return line.join('');
  });
}

const ADDRESS_LINES = lines({
  1: [[2, 'CUS200'], [30, 'Customer Addresses']],
  7: [[4, 'Street . . . .'], [22, '1600 Pennsylvania Ave NW'], [52, 'Old value  more text']],
  8: [[4, 'City . . . . .'], [22, 'Washington'], [46, 'DC'], [50, '20500']],
  9: [[4, 'Country  . . .'], [22, '']],
});

function context(options: Record<string, unknown>, extra: { fields?: Field[]; typed?: Record<string, string>; design?: boolean; lines?: string[] } = {}) {
  const typed = extra.typed ?? {};
  return {
    options,
    screen: { id: 'abc', rows: 24, cols: 80, lines: extra.lines ?? ADDRESS_LINES, fields: extra.fields ?? [] },
    tables: [],
    getField: (id: string) => typed[id] ?? extra.fields?.find((f) => f.id === id)?.value,
    setField: () => {},
    press: () => {},
    design: extra.design ?? false,
  };
}

// ---- a fake DOM: enough for the component, and for finding what it drew

class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  className = '';
  type = '';
  title = '';
  src = '';
  href = '';
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
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn({ preventDefault() {} }); }
  /** Every node below this one, depth first. */
  all(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  find(tag: string): FakeNode | undefined { return this.all().find((n) => n.tagName === tag); }
  /** The visible text, without style sheets. */
  get shown(): string {
    return this.tagName === 'style' ? '' : this.text + this.children.map((c) => c.shown).join('');
  }
}

class FakeDocument {
  createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
}

function host(): FakeNode {
  return new FakeDocument().createElement('div');
}

// ---- fetch, answered by the test

interface Call { url: URL; init: RequestInit; resolve(body: unknown, status?: number): void; reject(err: Error): void }

let calls: Call[] = [];
const realFetch = globalThis.fetch;

function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    calls.push({
      url: new URL(url), init,
      resolve: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
      reject,
    });
  });
}

/** Let promise callbacks run (a fetch answer takes a few turns to reach the component). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

const WHITE_HOUSE = [{ lat: '38.8976633', lon: '-77.0365739', display_name: 'White House' }];

beforeEach(() => {
  calls = [];
  map.clearLookups();
  globalThis.fetch = fakeFetch as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---- reading the address

describe('readAddress', () => {
  test('joins screen text at each position, up to the next double space', () => {
    assert.equal(map.readAddress(context({ address: ['7:22', '8:22', '8:46', '8:50'] })),
      '1600 Pennsylvania Ave NW, Washington, DC, 20500');
  });

  test('a length takes exactly that many characters', () => {
    assert.equal(map.readAddress(context({ address: ['7:52:9'] })), 'Old value');
    assert.equal(map.readAddress(context({ address: ['7:52'] })), 'Old value', 'without a length, stops at a double space');
  });

  test('a field gives its value, and what the user has typed wins', () => {
    const fields = [{ id: '9:22', row: 9, col: 22, length: 20, value: 'USA                 ' }];
    assert.equal(map.readAddress(context({ address: ['8:22', '9:22'] }, { fields })), 'Washington, USA');
    assert.equal(map.readAddress(context({ address: ['8:22', '9:22'] }, { fields, typed: { '9:22': 'Canada' } })), 'Washington, Canada');
    assert.equal(map.readAddress(context({ address: ['9:22:2'] }, { fields })), 'US');
  });

  test('parts can mix positions and fixed text', () => {
    assert.equal(map.readAddress(context({ address: ['{7:22}', '{8:22} {8:46} {8:50}', 'USA'] })),
      '1600 Pennsylvania Ave NW, Washington DC 20500, USA');
  });

  test('a single string works like a one-part list', () => {
    assert.equal(map.readAddress(context({ address: '{8:22}, {8:46}' })), 'Washington, DC');
  });

  test('blank parts and stray commas and spaces are dropped', () => {
    assert.equal(map.readAddress(context({ address: ['7:22', '9:22', '  ', '{9:22}, {8:46}'] })), '1600 Pennsylvania Ave NW, DC');
  });

  test('blank when every position is blank, even with fixed text', () => {
    assert.equal(map.readAddress(context({ address: ['9:22', 'USA'] })), '');
    assert.equal(map.readAddress(context({ address: ['{9:22}, USA'] })), '');
  });

  test('blank when the option is missing or not text', () => {
    assert.equal(map.readAddress(context({})), '');
    assert.equal(map.readAddress(context({ address: 42 })), '');
    assert.equal(map.readAddress(context({ address: [7, null, { row: 7 }] })), '');
  });

  test('positions off the screen read as blank', () => {
    assert.equal(map.readAddress(context({ address: ['30:1', '1:200'] })), '');
  });
});

// ---- options

describe('settings', () => {
  test('defaults', () => {
    assert.deepEqual(map.settings({}), {
      provider: 'openstreetmap', zoom: 15, apiKey: '', geocoder: 'https://nominatim.openstreetmap.org/search',
      title: '', link: true, error: '',
    });
    assert.equal(map.settings(undefined).provider, 'openstreetmap');
  });

  test('provider names ignore case, and "osm" means OpenStreetMap', () => {
    assert.equal(map.settings({ provider: 'Google' }).provider, 'google');
    assert.equal(map.settings({ provider: 'OSM' }).provider, 'openstreetmap');
    assert.match(map.settings({ provider: 'bing' }).error, /Unknown map provider "bing"/);
  });

  test('zoom is a whole number from 1 to 19', () => {
    assert.equal(map.settings({ zoom: 0 }).zoom, 1);
    assert.equal(map.settings({ zoom: 25 }).zoom, 19);
    assert.equal(map.settings({ zoom: '12' }).zoom, 12);
    assert.equal(map.settings({ zoom: 12.6 }).zoom, 13);
    assert.equal(map.settings({ zoom: 'near' }).zoom, 15);
  });

  test('the geocoder must be https, or http on this machine', () => {
    assert.equal(map.settings({ geocoder: 'https://geo.example.com/search' }).error, '');
    assert.equal(map.settings({ geocoder: 'http://localhost:8088/search' }).error, '');
    assert.equal(map.settings({ geocoder: 'http://127.0.0.1/search' }).error, '');
    for (const bad of ['http://geo.example.com/search', 'javascript:alert(1)', 'not a url', 'ftp://x/']) {
      assert.match(map.settings({ geocoder: bad }).error, /must be an https:\/\//, bad);
    }
    assert.equal(map.settings({ provider: 'google', geocoder: 'nonsense' }).error, '', 'Google does not use it');
  });

  test('link: false hides the link; title is trimmed', () => {
    assert.equal(map.settings({ link: false }).link, false);
    assert.equal(map.settings({ link: 'no' }).link, true);
    assert.equal(map.settings({ title: '  Ship to ' }).title, 'Ship to');
  });
});

// ---- provider URLs

describe('googleUrls', () => {
  const address = '1600 Pennsylvania Ave NW, Washington, DC & more';

  test('keyless embed, with the address encoded', () => {
    const { embed, link } = map.googleUrls(address, map.settings({ provider: 'google', zoom: 14 }));
    const url = new URL(embed);
    assert.equal(url.origin, 'https://maps.google.com');
    assert.equal(url.searchParams.get('q'), address);
    assert.equal(url.searchParams.get('z'), '14');
    assert.equal(url.searchParams.get('output'), 'embed');
    assert.equal(new URL(link).searchParams.get('query'), address);
    assert.match(link, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&/);
  });

  test('with a key, the Maps Embed API', () => {
    const { embed } = map.googleUrls(address, map.settings({ provider: 'google', apiKey: 'k&y' }));
    const url = new URL(embed);
    assert.equal(url.origin + url.pathname, 'https://www.google.com/maps/embed/v1/place');
    assert.equal(url.searchParams.get('key'), 'k&y');
    assert.equal(url.searchParams.get('q'), address);
    assert.equal(url.searchParams.get('zoom'), '15');
  });
});

describe('osmUrls', () => {
  test('a box around the place with a marker on it, and a link at the zoom', () => {
    const { embed, link } = map.osmUrls({ lat: 38.8976633, lon: -77.0365739 }, map.settings({ zoom: 15 }));
    const url = new URL(embed);
    assert.equal(url.origin + url.pathname, 'https://www.openstreetmap.org/export/embed.html');
    assert.equal(url.searchParams.get('marker'), '38.897663,-77.036574');
    assert.equal(url.searchParams.get('layer'), 'mapnik');
    const [west, south, east, north] = url.searchParams.get('bbox')!.split(',').map(Number);
    assert.ok(west! < -77.0365739 && -77.0365739 < east!, 'longitude inside');
    assert.ok(south! < 38.8976633 && 38.8976633 < north!, 'latitude inside');
    assert.ok(east! - west! > 0.01 && east! - west! < 0.03, `about two tiles wide at zoom 15: ${east! - west!}`);
    assert.equal(link, 'https://www.openstreetmap.org/?mlat=38.897663&mlon=-77.036574#map=15/38.897663/-77.036574');
  });

  test('a lower zoom shows more', () => {
    const width = (zoom: number) => {
      const [w, , e] = new URL(map.osmUrls({ lat: 0, lon: 0 }, map.settings({ zoom })).embed).searchParams.get('bbox')!.split(',').map(Number);
      return e! - w!;
    };
    assert.ok(width(10) > width(15));
  });

  test('the box stays on the map near the poles and the date line', () => {
    const [w, s, e, n] = new URL(map.osmUrls({ lat: 89, lon: 179.9 }, map.settings({ zoom: 1 })).embed)
      .searchParams.get('bbox')!.split(',').map(Number);
    assert.ok(w! >= -180 && e! <= 180 && s! >= -85 && n! <= 85, `${w},${s},${e},${n}`);
  });

  test('search link for an address that was not found', () => {
    assert.equal(map.osmSearchUrl('1 Main St, Nowhere'), 'https://www.openstreetmap.org/search?query=1%20Main%20St%2C%20Nowhere');
  });
});

// ---- geocoding

describe('geocode', () => {
  const s = map.settings({});

  test('asks the geocoder for one result, sending the site as referrer', async () => {
    const found = map.geocode('1600 Pennsylvania Ave NW, Washington', s);
    await settle();
    assert.equal(calls.length, 1);
    const { url, init } = calls[0]!;
    assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/search');
    assert.equal(url.searchParams.get('q'), '1600 Pennsylvania Ave NW, Washington');
    assert.equal(url.searchParams.get('format'), 'jsonv2');
    assert.equal(url.searchParams.get('limit'), '1');
    assert.equal(init.referrerPolicy, 'strict-origin');
    calls[0]!.resolve(WHITE_HOUSE);
    assert.deepEqual(await found, { lat: 38.8976633, lon: -77.0365739 });
  });

  test('a custom geocoder keeps its own query parameters', async () => {
    void map.geocode('Paris', map.settings({ geocoder: 'https://geo.example.com/search?countrycodes=fr' }));
    await settle();
    assert.equal(calls[0]!.url.searchParams.get('countrycodes'), 'fr');
    assert.equal(calls[0]!.url.searchParams.get('q'), 'Paris');
  });

  test('each address is looked up once, found or not', async () => {
    const a = map.geocode('Somewhere', s);
    const b = map.geocode('Somewhere', s);
    await settle();
    assert.equal(calls.length, 1, 'the second ask shares the first lookup');
    calls[0]!.resolve([]);
    assert.equal(await a, null);
    assert.equal(await b, null);
    assert.equal(await map.geocode('Somewhere', s), null);
    assert.equal(calls.length, 1, 'not found is remembered too');
  });

  test('a failed lookup is forgotten, so the next ask tries again', async () => {
    const first = map.geocode('Springfield', s);
    await settle();
    calls[0]!.resolve({ error: 'busy' }, 503);
    await assert.rejects(first, /answered 503/);
    await settle();
    const second = map.geocode('Springfield', s);
    await settle();
    assert.equal(calls.length, 2);
    calls[1]!.resolve(WHITE_HOUSE);
    assert.ok(await second);
  });

  test('a network error is forgotten too', async () => {
    const first = map.geocode('Springfield', s);
    await settle();
    calls[0]!.reject(new TypeError('Failed to fetch'));
    await assert.rejects(first, /Failed to fetch/);
    await settle();
    void map.geocode('Springfield', s);
    await settle();
    assert.equal(calls.length, 2);
  });

  test('answers without usable coordinates are "not found"', async () => {
    for (const body of [{}, [{}], [{ lat: 'x', lon: '1' }], [{ lat: '91', lon: '0' }], [{ lat: '0', lon: '181' }], 'nope']) {
      map.clearLookups();
      calls = [];
      const found = map.geocode('Anywhere', s);
      await settle();
      calls[0]!.resolve(body);
      assert.equal(await found, null, JSON.stringify(body));
    }
  });

  test('different geocoders are looked up separately', async () => {
    void map.geocode('Paris', s);
    void map.geocode('Paris', map.settings({ geocoder: 'https://geo.example.com/search' }));
    await settle();
    assert.equal(calls.length, 2);
  });
});

// ---- drawing

describe('mount', () => {
  const OPTIONS = { address: ['7:22', '8:22', '8:46'], title: 'Ship to' };
  const ADDRESS = '1600 Pennsylvania Ave NW, Washington, DC';

  test('OpenStreetMap: finds the address, then shows the map and a link', async () => {
    const element = host();
    map.mount(element, context(OPTIONS));
    assert.match(element.shown, /Ship to/);
    assert.match(element.shown, /Finding the address/);
    assert.equal(element.find('iframe'), undefined);
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url.searchParams.get('q'), ADDRESS);
    calls[0]!.resolve(WHITE_HOUSE);
    await settle();

    const frame = element.find('iframe')!;
    assert.ok(frame, 'the map is shown');
    assert.match(frame.src, /^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=/);
    assert.match(frame.src, /marker=38\.897663,-77\.036574/);
    assert.equal(frame.title, `Map of ${ADDRESS}`);
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    assert.equal(frame.getAttribute('loading'), 'lazy');
    const a = element.find('a')!;
    assert.equal(a.textContent, 'Open in maps');
    assert.match(a.href, /^https:\/\/www\.openstreetmap\.org\/\?mlat=38\.897663/);
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.match(element.shown, /Ship to/, 'the title stays');
    assert.ok(element.find('style'), 'brings its own styles');
  });

  test('Google: shows the map at once, without a lookup', async () => {
    const element = host();
    map.mount(element, context({ ...OPTIONS, provider: 'google' }));
    const frame = element.find('iframe')!;
    assert.equal(new URL(frame.src).searchParams.get('q'), ADDRESS);
    await settle();
    assert.equal(calls.length, 0);
  });

  test('link: false leaves out the link', () => {
    const element = host();
    map.mount(element, context({ ...OPTIONS, provider: 'google', link: false }));
    assert.ok(element.find('iframe'));
    assert.equal(element.find('a'), undefined);
  });

  test('a blank address shows a note and looks nothing up', async () => {
    const element = host();
    map.mount(element, context({ address: ['9:22'] }));
    assert.match(element.shown, /No address on this screen/);
    await settle();
    assert.equal(calls.length, 0);
  });

  test('without the address option, says how to set it', () => {
    const element = host();
    map.mount(element, context({}));
    assert.match(element.shown, /Set the "address" option/);
  });

  test('a bad option is explained instead of a map', async () => {
    const element = host();
    map.mount(element, context({ ...OPTIONS, provider: 'bing' }));
    assert.match(element.shown, /Unknown map provider "bing"/);
    assert.equal(element.find('iframe'), undefined);
    await settle();
    assert.equal(calls.length, 0);
  });

  test('an address that is not found says so, with a search link', async () => {
    const element = host();
    map.mount(element, context(OPTIONS));
    await settle();
    calls[0]!.resolve([]);
    await settle();
    assert.match(element.shown, new RegExp(`Couldn't find ${ADDRESS} on the map`));
    assert.equal(element.find('iframe'), undefined);
    assert.match(element.find('a')!.href, /openstreetmap\.org\/search\?query=1600%20Pennsylvania/);
  });

  test('a failed lookup says so', async () => {
    const element = host();
    map.mount(element, context(OPTIONS));
    await settle();
    calls[0]!.resolve({}, 429);
    await settle();
    assert.match(element.shown, /The map couldn't be loaded: the geocoder answered 429/);
  });

  test('in the designer, nothing is sent until the designer asks', async () => {
    const element = host();
    map.mount(element, context({ ...OPTIONS, provider: 'google' }, { design: true }));
    assert.equal(element.find('iframe'), undefined);
    assert.match(element.shown, new RegExp(`${ADDRESS}\\. The map isn't loaded while designing`));
    await settle();
    assert.equal(calls.length, 0);
    const button = element.find('button')!;
    assert.equal(button.textContent, 'Show map');
    assert.equal(button.type, 'button');
    button.click();
    assert.ok(element.find('iframe'), 'shown after the click');
  });

  test('in the designer, OpenStreetMap looks the address up only after the click', async () => {
    const element = host();
    map.mount(element, context(OPTIONS, { design: true }));
    await settle();
    assert.equal(calls.length, 0);
    element.find('button')!.click();
    await settle();
    assert.equal(calls.length, 1);
  });

  test('two maps on one screen are independent', async () => {
    const bill = host();
    const ship = host();
    map.mount(bill, context({ address: ['7:22'], provider: 'google' }));
    map.mount(ship, context({ address: ['8:22'], provider: 'google' }));
    assert.equal(new URL(bill.find('iframe')!.src).searchParams.get('q'), '1600 Pennsylvania Ave NW');
    assert.equal(new URL(ship.find('iframe')!.src).searchParams.get('q'), 'Washington');
  });

  describe('updates', () => {
    beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
    afterEach(() => mock.timers.reset());

    const other = lines({ 7: [[22, '350 Fifth Avenue']], 8: [[22, 'New York'], [46, 'NY']] });

    test('the same address keeps the same map', () => {
      const element = host();
      const instance = map.mount(element, context({ ...OPTIONS, provider: 'google' }));
      const frame = element.find('iframe');
      instance.update(context({ ...OPTIONS, provider: 'google' }));
      mock.timers.tick(map.SETTLE_MS * 2);
      assert.equal(element.find('iframe'), frame, 'not reloaded');
    });

    test('a new address redraws once it has settled', () => {
      const element = host();
      const instance = map.mount(element, context({ ...OPTIONS, provider: 'google' }));
      instance.update(context({ ...OPTIONS, provider: 'google' }, { lines: other }));
      mock.timers.tick(map.SETTLE_MS - 1);
      assert.match(element.find('iframe')!.src, /Pennsylvania/, 'not yet');
      mock.timers.tick(1);
      assert.match(element.find('iframe')!.src, /350%20Fifth%20Avenue/);
    });

    test('typing into an address field waits for the typing to stop', () => {
      const fields = [{ id: '9:22', row: 9, col: 22, length: 20, value: '' }];
      const ctx = (typed: string) => context({ address: ['8:22', '9:22'], provider: 'google' }, { fields, typed: { '9:22': typed } });
      const element = host();
      const instance = map.mount(element, ctx(''));
      for (const typed of ['U', 'US', 'USA']) {
        instance.update(ctx(typed));
        mock.timers.tick(map.SETTLE_MS / 2);
      }
      assert.equal(new URL(element.find('iframe')!.src).searchParams.get('q'), 'Washington');
      mock.timers.tick(map.SETTLE_MS);
      assert.equal(new URL(element.find('iframe')!.src).searchParams.get('q'), 'Washington, USA');
    });

    test('changing back before it settles keeps the map', () => {
      const element = host();
      const instance = map.mount(element, context({ ...OPTIONS, provider: 'google' }));
      const frame = element.find('iframe');
      instance.update(context({ ...OPTIONS, provider: 'google' }, { lines: other }));
      instance.update(context({ ...OPTIONS, provider: 'google' }));
      mock.timers.tick(map.SETTLE_MS * 2);
      assert.equal(element.find('iframe'), frame);
    });

    test('changed options redraw too (e.g. in the designer)', () => {
      const element = host();
      const instance = map.mount(element, context({ ...OPTIONS, provider: 'google' }));
      instance.update(context({ ...OPTIONS, provider: 'google', zoom: 10 }));
      mock.timers.tick(map.SETTLE_MS);
      assert.equal(new URL(element.find('iframe')!.src).searchParams.get('z'), '10');
    });

    test('an earlier lookup that answers late does not replace the newer map', async () => {
      const element = host();
      const instance = map.mount(element, context(OPTIONS));
      await settle();
      instance.update(context(OPTIONS, { lines: other }));
      mock.timers.tick(map.SETTLE_MS);
      await settle();
      assert.equal(calls.length, 2);
      calls[1]!.resolve([{ lat: '40.7484', lon: '-73.9857' }]);
      await settle();
      calls[0]!.resolve(WHITE_HOUSE);
      await settle();
      assert.match(element.find('iframe')!.src, /marker=40\.7484,-73\.9857/);
    });

    test('after a failed lookup, the next update tries again', async () => {
      const element = host();
      const instance = map.mount(element, context(OPTIONS));
      await settle();
      calls[0]!.reject(new TypeError('Failed to fetch'));
      await settle();
      instance.update(context(OPTIONS));
      mock.timers.tick(map.SETTLE_MS);
      await settle();
      assert.equal(calls.length, 2);
      calls[1]!.resolve(WHITE_HOUSE);
      await settle();
      assert.ok(element.find('iframe'));
    });

    test('unmount removes the map and ignores a lookup still running', async () => {
      const element = host();
      const instance = map.mount(element, context(OPTIONS));
      await settle();
      instance.update(context(OPTIONS, { lines: other }));
      instance.unmount();
      assert.equal(element.children.length, 0);
      mock.timers.tick(map.SETTLE_MS * 2);
      calls[0]!.resolve(WHITE_HOUSE);
      await settle();
      assert.equal(calls.length, 1, 'the pending redraw was cancelled');
      assert.equal(element.children.length, 0);
    });
  });
});
