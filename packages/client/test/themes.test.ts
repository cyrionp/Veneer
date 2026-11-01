// The client's side of themes: putting the theme in the page (ui/themes.ts),
// and the designer's theme calls and naming rules (designer/themes.ts).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { copyName, cssUrl, logoUrl, sizeLabel, themeApi, themeLabel, uploadName, validThemeName } from '../src/designer/themes.ts';
import { applyTheme, shownLogo, themeStyleText } from '../src/ui/themes.ts';

// ---- a document: <html> with a dataset, <head> holding <style> elements

class FakeStyle {
  dataset: Record<string, string> = {};
  textContent = '';
  head: FakeHead | null = null;
  remove(): void { if (this.head) this.head.children = this.head.children.filter((c) => c !== this); this.head = null; }
}
class FakeHead {
  children: FakeStyle[] = [];
  append(el: FakeStyle): void { el.head = this; this.children.push(el); }
  prepend(el: FakeStyle): void { el.head = this; this.children.unshift(el); }
  querySelector(sel: string): FakeStyle | null {
    const key = /data-([a-z-]+)/.exec(sel)![1]!.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    return this.children.find((c) => key in c.dataset) ?? null;
  }
}
function fakeDocument() {
  const head = new FakeHead();
  return {
    head,
    documentElement: { dataset: {} as Record<string, string> },
    createElement: () => new FakeStyle(),
  };
}
const asDoc = (d: ReturnType<typeof fakeDocument>) => d as unknown as Document;

describe('applyTheme', () => {
  test('puts the theme\'s style sheet last in <head> and names it on <html>', () => {
    const doc = fakeDocument();
    const brand = new FakeStyle();
    brand.dataset.veneerBrand = '';
    doc.head.append(brand);
    applyTheme({ name: 'acme', css: '.topbar { background: url(bg.png) }', logo: null }, asDoc(doc));
    assert.equal(doc.documentElement.dataset.theme, 'acme');
    assert.equal(doc.head.children.length, 2);
    assert.equal(doc.head.children[1]!.textContent, '.topbar { background: url(/themes/acme/bg.png) }', 'after the brand colors, images found in its folder');
    assert.ok('veneerTheme' in doc.head.children[1]!.dataset);
  });

  test('another theme replaces it, in the same element', () => {
    const doc = fakeDocument();
    applyTheme({ name: 'acme', css: 'a{}', logo: null }, asDoc(doc));
    const el = doc.head.children[0];
    applyTheme({ name: 'green', css: 'b{}', logo: null }, asDoc(doc));
    assert.equal(doc.head.children.length, 1);
    assert.equal(doc.head.children[0], el);
    assert.equal(el!.textContent, 'b{}');
    assert.equal(doc.documentElement.dataset.theme, 'green');
  });

  test('no theme takes it away', () => {
    const doc = fakeDocument();
    applyTheme({ name: 'acme', css: 'a{}', logo: '/themes/acme/logo.svg' }, asDoc(doc));
    applyTheme(null, asDoc(doc));
    assert.equal(doc.head.children.length, 0);
    assert.equal(doc.documentElement.dataset.theme, undefined);
    assert.equal(shownLogo(), null);
  });

  test('the theme\'s logo is what the header shows', () => {
    const doc = fakeDocument();
    applyTheme({ name: 'acme', css: '', logo: '/themes/acme/logo.svg?v=1' }, asDoc(doc));
    assert.equal(shownLogo(), '/themes/acme/logo.svg?v=1');
    applyTheme({ name: 'flat', css: '', logo: null }, asDoc(doc));
    assert.equal(shownLogo(), null, 'none: the brand logo comes back');
  });

  test('the style sheet text, with theme names that need escaping in a URL', () => {
    assert.equal(themeStyleText({ name: 'my_theme', css: 'a { background: url(x.png) }', logo: null }), 'a { background: url(/themes/my_theme/x.png) }');
  });
});

// ---- the designer's calls

interface Seen { url: string; init: RequestInit }

function fakeFetch(reply: (seen: Seen) => { status?: number; body?: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    seen.push({ url, init });
    const { status = 200, body } = reply({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  };
  return { seen, fetchImpl };
}

describe('themeApi', () => {
  const auth = () => ({ Authorization: 'Bearer t' });

  test('each call: its method, URL, body and the token', async () => {
    const { seen, fetchImpl } = fakeFetch(({ url, init }) => ({ status: init.method === 'DELETE' && !url.includes('/files/') ? 204 : 200, body: { ok: 1 } }));
    const api = themeApi(auth, fetchImpl);
    await api.list();
    await api.get('my theme');
    await api.create('acme', 'flat');
    await api.save('acme', 'a{}');
    await api.rename('acme', 'acme2');
    await api.remove('acme2');
    await api.removeFile('acme', 'logo.svg');
    await api.use('acme');
    assert.deepEqual(seen.map((s) => `${s.init.method} ${s.url}`), [
      'GET /api/themes', 'GET /api/themes/my%20theme', 'POST /api/themes', 'PUT /api/themes/acme', 'POST /api/themes/acme/rename',
      'DELETE /api/themes/acme2', 'DELETE /api/themes/acme/files/logo.svg', 'PUT /api/theme',
    ]);
    assert.deepEqual(JSON.parse(String(seen[2]!.init.body)), { name: 'acme', from: 'flat' });
    assert.deepEqual(JSON.parse(String(seen[3]!.init.body)), { css: 'a{}' });
    assert.deepEqual(JSON.parse(String(seen[4]!.init.body)), { to: 'acme2' });
    assert.deepEqual(JSON.parse(String(seen[7]!.init.body)), { name: 'acme' });
    assert.ok(seen.every((s) => (s.init.headers as Record<string, string>).Authorization === 'Bearer t'));
    assert.equal((seen[3]!.init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.equal((seen[0]!.init.headers as Record<string, string>)['Content-Type'], undefined, 'no body, no type');
  });

  test('an upload sends the image itself, with its type', async () => {
    const { seen, fetchImpl } = fakeFetch(() => ({ body: { files: [{ name: 'logo.svg', size: 3 }] } }));
    const blob = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    const out = await themeApi(auth, fetchImpl).upload('acme', 'logo.svg', blob, 'image/svg+xml');
    assert.deepEqual(out.files, [{ name: 'logo.svg', size: 3 }]);
    assert.equal(seen[0]!.url, '/api/themes/acme/files/logo.svg');
    assert.equal(seen[0]!.init.body, blob);
    assert.equal((seen[0]!.init.headers as Record<string, string>)['Content-Type'], 'image/svg+xml');
  });

  test('a refusal throws the server\'s reason; 401 asks for the token', async () => {
    const api = themeApi(auth, fakeFetch(() => ({ status: 409, body: { error: '"acme" is in use' } })).fetchImpl);
    await assert.rejects(api.remove('acme'), /"acme" is in use/);
    const noToken = themeApi(() => ({}), fakeFetch(() => ({ status: 401, body: { error: 'Designer token required' } })).fetchImpl);
    await assert.rejects(noToken.list(), /Enter a valid designer token/);
    const bare = themeApi(auth, fakeFetch(() => ({ status: 500, body: 'oops' })).fetchImpl);
    await assert.rejects(bare.list(), /HTTP 500/);
  });
});

describe('naming', () => {
  test('uploaded files get a name a theme can hold', () => {
    assert.equal(uploadName('logo.svg'), 'logo.svg');
    assert.equal(uploadName('Company Logo (2).PNG'), 'Company-Logo-2.png');
    assert.equal(uploadName('__hidden.gif'), 'hidden.gif');
    assert.equal(uploadName('été.jpg'), 't.jpg');
    assert.equal(uploadName('???.webp'), 'image.webp');
    assert.equal(uploadName(`${'x'.repeat(80)}.png`), `${'x'.repeat(60)}.png`);
    assert.equal(uploadName('notes.txt'), undefined);
    assert.equal(uploadName('logo'), undefined);
    assert.equal(uploadName('evil.svg.html'), undefined);
  });

  test('a copy gets a free name', () => {
    assert.equal(copyName('flat', []), 'flat-copy');
    assert.equal(copyName('flat', ['flat-copy', 'flat-copy-2']), 'flat-copy-3');
    assert.ok(copyName('x'.repeat(40), []).length <= 40);
    assert.ok(validThemeName(copyName('high-contrast', [])));
  });

  test('valid names for a new theme; built-in names are taken', () => {
    assert.ok(validThemeName('acme'));
    assert.ok(!validThemeName('flat'));
    assert.ok(!validThemeName('acme corp'));
    assert.ok(!validThemeName(''));
  });

  test('labels, logo, CSS and sizes', () => {
    assert.equal(themeLabel('green'), 'Green screen');
    assert.equal(themeLabel('acme'), 'acme');
    assert.equal(logoUrl('acme', [{ name: 'bg.png', size: 1 }, { name: 'logo.svg', size: 1 }], '7'), '/themes/acme/logo.svg?v=7');
    assert.equal(logoUrl('acme', [{ name: 'bg.png', size: 1 }]), null);
    assert.equal(cssUrl('bg.png'), 'url(bg.png)');
    assert.equal(sizeLabel(512), '512 B');
    assert.equal(sizeLabel(12_800), '13 KB');
    assert.equal(sizeLabel(1_572_864), '1.5 MB');
  });
});
