// Themes: the store (themes on disk, the one in use, images, upgrading an old
// saved style), the designer's /api/themes, and serving theme files to pages.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';
import { BUILTIN_THEMES, MAX_THEME_CSS, MAX_THEME_FILE, MAX_THEME_FILES } from '@veneer/screens';
import { createServer, type VeneerServer } from '../src/server.ts';
import { BUILTIN_DIR, ThemeError, ThemeStore, isImage, styleCss } from '../src/themes.ts';
import { FakeHost } from './fakeHost.ts';

// ---- small valid images

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-themes-'));
/** A copy of the built-in themes, so a test (or a bug) can never change the real ones. */
function builtins(): string {
  const copy = path.join(tmp(), 'builtin');
  fs.cpSync(BUILTIN_DIR, copy, { recursive: true });
  return copy;
}

/** `p` fails with a ThemeError of `status`; `message` is a pattern its message matches, or a note. */
async function rejects(p: Promise<unknown>, status: number, message?: RegExp | string): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof ThemeError, `a ThemeError, got ${String(err)}`);
    assert.equal(err.status, status, `${err.message}${typeof message === 'string' ? ` (${message})` : ''}`);
    if (message instanceof RegExp) assert.match(err.message, message);
    return true;
  });
}

// ---- the built-in themes

describe('built-in themes', () => {
  test('every built-in theme has a style sheet that came from the old looks', () => {
    for (const name of BUILTIN_THEMES) {
      const css = fs.readFileSync(path.join(BUILTIN_DIR, name, 'theme.css'), 'utf8');
      assert.ok(css.length > 0, name);
      assert.doesNotMatch(css, /data-(look|corners|density|font)/, `${name} is a plain style sheet`);
      const open = (css.match(/\{/g) ?? []).length;
      assert.equal(open, (css.match(/\}/g) ?? []).length, `${name}: braces balance`);
    }
  });

  test('the looks keep their rules', () => {
    const read = (n: string) => fs.readFileSync(path.join(BUILTIN_DIR, n, 'theme.css'), 'utf8');
    assert.match(read('compact'), /--rh: 1\.55em/);
    assert.match(read('flat'), /--header-bg: var\(--accent\)/);
    assert.match(read('green'), /color-scheme: dark/);
    assert.match(read('soft'), /border-radius: 999px/);
    assert.match(read('high-contrast'), /prefers-color-scheme: dark/);
    assert.doesNotMatch(read('default').replace(/\/\*[\s\S]*?\*\//g, ''), /\S/, 'Default is Veneer as it is: only a comment');
  });
});

// ---- the store

describe('ThemeStore', () => {
  let dir: string;
  let store: ThemeStore;
  let changes: number;
  beforeEach(async () => {
    dir = tmp();
    store = new ThemeStore(dir, builtins());
    changes = 0;
    store.on('changed', () => { changes++; });
    await store.load();
  });

  test('lists the built-in themes in order, then the site\'s by name; Default is in use', async () => {
    await store.create('zeta', 'default');
    await store.create('acme', 'default');
    const list = await store.list();
    assert.deepEqual(list.map((t) => t.name), [...BUILTIN_THEMES, 'acme', 'zeta']);
    assert.deepEqual(list.map((t) => t.builtin), [...BUILTIN_THEMES.map(() => true), false, false]);
    assert.equal(store.active, 'default');
  });

  test('a folder without a style sheet, or with a bad name, is not a theme', async () => {
    fs.mkdirSync(path.join(dir, 'themes', 'empty'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'themes', 'bad name'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'themes', 'bad name', 'theme.css'), '');
    assert.deepEqual((await store.list()).filter((t) => !t.builtin), []);
    assert.equal(await store.get('empty'), undefined);
  });

  test('a new theme copies another\'s style sheet and images', async () => {
    const flat = await store.create('acme', 'flat');
    assert.equal(flat.css, fs.readFileSync(path.join(BUILTIN_DIR, 'flat', 'theme.css'), 'utf8'));
    assert.equal(flat.builtin, false);
    await store.putFile('acme', 'logo.png', PNG);
    const copy = await store.create('acme-2', 'acme');
    assert.deepEqual(copy.files, [{ name: 'logo.png', size: PNG.length }]);
    assert.ok(fs.existsSync(path.join(dir, 'themes', 'acme-2', 'theme.css')), 'kept in the screens folder');
    assert.equal(changes, 3);
  });

  test('new theme names: valid, not built-in, not taken, and the source must exist', async () => {
    await rejects(store.create('my theme', 'default'), 400, /letters, digits/);
    await rejects(store.create('../up', 'default'), 400);
    await rejects(store.create('', 'default'), 400);
    await rejects(store.create('x'.repeat(41), 'default'), 400);
    await rejects(store.create(undefined as never, 'default'), 400);
    await rejects(store.create('flat', 'default'), 409, /built-in/);
    await store.create('acme', 'default');
    await rejects(store.create('acme', 'default'), 409, /already/);
    await rejects(store.create('other', 'nope'), 404);
  });

  test('saving a style sheet: only the site\'s own themes, as text, not too long', async () => {
    await store.create('acme', 'default');
    const saved = await store.saveCss('acme', ':root { --brand-accent: #c8102e; }');
    assert.equal(saved.css, ':root { --brand-accent: #c8102e; }');
    assert.equal(fs.readFileSync(path.join(dir, 'themes', 'acme', 'theme.css'), 'utf8'), ':root { --brand-accent: #c8102e; }');
    await rejects(store.saveCss('flat', ''), 403, /copy it/);
    await rejects(store.saveCss('nope', ''), 404);
    await rejects(store.saveCss('acme', 42), 400);
    await rejects(store.saveCss('acme', 'x'.repeat(MAX_THEME_CSS + 1)), 400);
    assert.equal((await store.saveCss('acme', '')).css, '', 'an empty theme is allowed');
  });

  test('renaming moves the theme, and the theme in use stays in use', async () => {
    await store.create('acme', 'soft');
    await store.putFile('acme', 'logo.svg', SVG);
    await store.setActive('acme');
    const renamed = await store.rename('acme', 'acme-corp');
    assert.equal(renamed.name, 'acme-corp');
    assert.deepEqual(renamed.files.map((f) => f.name), ['logo.svg']);
    assert.equal(store.active, 'acme-corp');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'themes', 'active.json'), 'utf8')), { theme: 'acme-corp' });
    assert.equal(await store.get('acme'), undefined);
    await store.create('other', 'default');
    await rejects(store.rename('acme-corp', 'other'), 409);
    await rejects(store.rename('acme-corp', 'green'), 409);
    await rejects(store.rename('acme-corp', 'no good'), 400);
    await rejects(store.rename('green', 'mine'), 403);
    assert.equal((await store.rename('other', 'other')).name, 'other', 'the same name changes nothing');
  });

  test('deleting: not the theme in use, not a built-in one', async () => {
    await store.create('acme', 'default');
    await store.create('spare', 'default');
    await store.setActive('acme');
    await rejects(store.remove('acme'), 409, /in use/);
    await rejects(store.remove('default'), 403);
    await rejects(store.remove('nope'), 404);
    await store.remove('spare');
    assert.ok(!fs.existsSync(path.join(dir, 'themes', 'spare')));
  });

  test('images of every allowed type are kept', async () => {
    await store.create('acme', 'default');
    for (const [name, data] of [['logo.png', PNG], ['photo.jpg', JPEG], ['photo2.JPEG', JPEG], ['spin.gif', GIF], ['bg.webp', WEBP], ['mark.svg', SVG]] as const) {
      await store.putFile('acme', name, data);
    }
    const files = (await store.get('acme'))!.files.map((f) => f.name);
    assert.deepEqual(files, ['bg.webp', 'logo.png', 'mark.svg', 'photo.jpg', 'photo2.JPEG', 'spin.gif']);
  });

  test('an image must be what its name says, by its content', async () => {
    await store.create('acme', 'default');
    await rejects(store.putFile('acme', 'logo.svg', PNG), 400, /not a SVG/);
    await rejects(store.putFile('acme', 'logo.png', SVG), 400, /not a PNG/);
    await rejects(store.putFile('acme', 'logo.png', Buffer.from('<html><script>alert(1)</script>')), 400);
    await rejects(store.putFile('acme', 'logo.svg', Buffer.from('<html><svg></svg></html>')), 400, 'an SVG must start with <svg>');
    await rejects(store.putFile('acme', 'logo.gif', JPEG), 400);
    await rejects(store.putFile('acme', 'logo.webp', Buffer.from('RIFF\0\0\0\0WAVEfmt ')), 400);
    await rejects(store.putFile('acme', 'logo.png', Buffer.alloc(0)), 400, /empty/);
    await rejects(store.putFile('acme', 'logo.png', Buffer.concat([PNG, Buffer.alloc(MAX_THEME_FILE)])), 413);
  });

  test('image names: no folders, no hidden files, only image types', async () => {
    await store.create('acme', 'default');
    for (const bad of ['../logo.png', 'a/b.png', '.logo.png', 'logo.exe', 'logo.html', 'logo', 'logo.png.js', 'my logo.png', `${'x'.repeat(61)}.png`, 'theme.css']) {
      await rejects(store.putFile('acme', bad, PNG), 400, undefined);
    }
    await rejects(store.putFile('flat', 'logo.png', PNG), 403);
    await rejects(store.putFile('nope', 'logo.png', PNG), 404);
  });

  test('a theme holds a limited number of images; replacing one is always allowed', async () => {
    await store.create('acme', 'default');
    for (let i = 0; i < MAX_THEME_FILES; i++) await store.putFile('acme', `i${i}.gif`, GIF);
    await rejects(store.putFile('acme', 'one-more.gif', GIF), 400, /at most/);
    await store.putFile('acme', 'i0.gif', GIF);
  });

  test('another spelling of a file name replaces the file', async () => {
    await store.create('acme', 'default');
    await store.putFile('acme', 'logo.png', PNG);
    await store.putFile('acme', 'Logo.PNG', PNG);
    assert.deepEqual((await store.get('acme'))!.files.map((f) => f.name), ['Logo.PNG']);
  });

  test('deleting an image', async () => {
    await store.create('acme', 'default');
    await store.putFile('acme', 'logo.png', PNG);
    assert.deepEqual(await store.removeFile('acme', 'logo.png'), []);
    await rejects(store.removeFile('acme', 'logo.png'), 404);
    await rejects(store.removeFile('acme', 'theme.css'), 404, 'not the style sheet');
  });

  test('the theme in use is recorded in the screens folder and read back at startup', async () => {
    await store.create('acme', 'default');
    await store.setActive('acme');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'themes', 'active.json'), 'utf8')), { theme: 'acme' });
    const again = new ThemeStore(dir, builtins());
    await again.load();
    assert.equal(again.active, 'acme');
    await rejects(store.setActive('nope'), 404);
    await store.setActive('green');
    assert.equal(store.active, 'green', 'a built-in theme can be used too');
  });

  test('a missing or unreadable theme in use falls back to Default', async () => {
    fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
    for (const text of ['{"theme": "gone"}', 'not json', '{"theme": 5}', '{"theme": "../../etc"}']) {
      fs.writeFileSync(path.join(dir, 'themes', 'active.json'), text);
      const s = new ThemeStore(dir, builtins());
      await s.load();
      assert.equal(s.active, 'default', text);
      assert.equal((await s.activeTheme()).name, 'default');
    }
  });

  test('the theme in use, as pages get it: its style sheet and logo', async () => {
    assert.deepEqual(await store.activeTheme(), {
      name: 'default', builtin: true, css: fs.readFileSync(path.join(BUILTIN_DIR, 'default', 'theme.css'), 'utf8'), logo: null,
    });
    await store.create('acme', 'default');
    await store.saveCss('acme', 'body { color: red }');
    await store.setActive('acme');
    assert.deepEqual(await store.activeTheme(), { name: 'acme', builtin: false, css: 'body { color: red }', logo: null });
    await store.putFile('acme', 'logo.svg', SVG);
    const theme = await store.activeTheme();
    assert.match(theme.logo!, /^\/themes\/acme\/logo\.svg\?v=\d+-\d+$/);
    await store.saveCss('acme', 'body { color: blue }');
    assert.equal((await store.activeTheme()).css, 'body { color: blue }', 'changes show at once');
  });

  test('the files pages can fetch: a theme\'s style sheet and images, nothing else', async () => {
    await store.create('acme', 'default');
    await store.putFile('acme', 'logo.png', PNG);
    fs.writeFileSync(path.join(dir, 'themes', 'acme', 'notes.txt'), 'secret');
    assert.deepEqual(await store.filePath('acme', 'logo.png'), { path: path.join(dir, 'themes', 'acme', 'logo.png'), type: 'image/png' });
    assert.equal((await store.filePath('acme', 'theme.css'))?.type, 'text/css; charset=utf-8');
    assert.match((await store.filePath('flat', 'theme.css'))!.path, /builtin[/\\]flat[/\\]theme\.css$/);
    assert.equal(await store.filePath('acme', 'notes.txt'), undefined);
    assert.equal(await store.filePath('acme', 'missing.png'), undefined);
    assert.equal(await store.filePath('..', 'theme.css'), undefined);
    assert.equal(await store.filePath('acme', '../active.json'), undefined);
    assert.equal(await store.filePath('nope', 'theme.css'), undefined);
  });
});

// ---- upgrading a style saved before themes

describe('upgrading a saved style', () => {
  const upgrade = async (style: unknown, before?: (dir: string) => void) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'global.style.json'), typeof style === 'string' ? style : JSON.stringify(style));
    before?.(dir);
    const store = new ThemeStore(dir, builtins());
    await store.load();
    return { dir, store };
  };

  test('becomes the theme "site", in use, from its look with its options; the old file stays', async () => {
    const { dir, store } = await upgrade({ look: 'soft', accent: '#0a7f5a', corners: 'square', density: 'compact', font: 'mono' });
    assert.equal(store.active, 'site');
    const css = (await store.get('site'))!.css;
    assert.ok(css.includes(fs.readFileSync(path.join(BUILTIN_DIR, 'soft', 'theme.css'), 'utf8')), 'starts from the look');
    assert.match(css, /--brand-accent: #0a7f5a/);
    assert.match(css, /border-radius: 0 !important/);
    assert.match(css, /--rh: 1\.55em/);
    assert.match(css, /--font: var\(--mono\)/);
    assert.ok(fs.existsSync(path.join(dir, 'global.style.json')), 'left in place');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'themes', 'active.json'), 'utf8')), { theme: 'site' });
  });

  test('happens once: after that, the theme in use is what active.json says', async () => {
    const { dir, store } = await upgrade({ look: 'green' });
    await store.setActive('default');
    const again = new ThemeStore(dir, builtins());
    await again.load();
    assert.equal(again.active, 'default');
    assert.deepEqual((await again.list()).filter((t) => !t.builtin).map((t) => t.name), ['site'], 'no second copy');
  });

  test('the default style, an invalid file or an empty one makes no theme', async () => {
    for (const style of [{ look: 'default' }, { look: 'neon' }, 'not json', '']) {
      const { store } = await upgrade(style);
      assert.equal(store.active, 'default', JSON.stringify(style));
      assert.deepEqual((await store.list()).filter((t) => !t.builtin), []);
    }
  });

  test('a site that already has a theme named "site" gets "site-2"', async () => {
    const { store } = await upgrade({ look: 'flat' }, (dir) => {
      fs.mkdirSync(path.join(dir, 'themes', 'site'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'themes', 'site', 'theme.css'), '/* mine */');
    });
    assert.equal(store.active, 'site-2');
    assert.equal((await store.get('site'))!.css, '/* mine */');
  });

  test('each option\'s CSS', () => {
    assert.equal(styleCss({ look: 'default' }), '');
    assert.match(styleCss({ look: 'default', corners: 'round' }), /border-radius: 999px !important/);
    assert.match(styleCss({ look: 'default', density: 'roomy' }), /--rh: 2\.2em/);
    assert.match(styleCss({ look: 'default', density: 'normal' }), /--rh: 1\.9em/);
    assert.match(styleCss({ look: 'default', font: 'sans' }), /--font: ui-sans-serif/);
  });
});

describe('isImage', () => {
  test('recognises each type by its first bytes', () => {
    assert.ok(isImage(PNG, 'image/png'));
    assert.ok(isImage(JPEG, 'image/jpeg'));
    assert.ok(isImage(GIF, 'image/gif'));
    assert.ok(isImage(Buffer.from('GIF87a...'), 'image/gif'));
    assert.ok(isImage(WEBP, 'image/webp'));
    assert.ok(isImage(SVG, 'image/svg+xml'));
    assert.ok(isImage(Buffer.from('﻿  <svg viewBox="0 0 1 1"></svg>'), 'image/svg+xml'), 'with a byte order mark');
    assert.ok(isImage(Buffer.from('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg>'), 'image/svg+xml'));
    assert.ok(!isImage(Buffer.from('<svgfoo>'), 'image/svg+xml'));
    assert.ok(!isImage(Buffer.from('<script>alert(1)</script><svg>'), 'image/svg+xml'));
    assert.ok(!isImage(PNG, 'image/bmp'));
  });
});

// ---- the API and serving

describe('/api/themes and /themes', () => {
  const TOKEN = 'theme-designer-token';
  let host: FakeHost;
  let server: VeneerServer;
  let base: string;
  let dir: string;

  before(async () => {
    host = new FakeHost();
    dir = tmp();
    server = createServer({
      listenHost: '127.0.0.1', listenPort: 0,
      host: { host: '127.0.0.1', port: await host.start(), tls: false },
      idleTimeoutMs: 0, resumeGraceMs: 0, maxSessions: 5, allowedOrigins: [],
      screensDir: dir, designerToken: TOKEN, builtinThemesDir: builtins(),
    });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
  });
  after(async () => {
    await server.close();
    await host.stop();
  });

  const call = (method: string, url: string, body?: unknown, token: string | null = TOKEN) => fetch(base + url, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const screens = async () => (await fetch(`${base}/api/screens`)).json() as Promise<{ version: number; theme: { name: string; css: string; logo: string | null } }>;

  test('editing themes needs the designer token; every page gets the theme in use', async () => {
    for (const [method, url] of [['GET', '/api/themes'], ['POST', '/api/themes'], ['GET', '/api/themes/flat'], ['PUT', '/api/themes/x'],
      ['DELETE', '/api/themes/x'], ['POST', '/api/themes/x/rename'], ['PUT', '/api/themes/x/files/a.png'], ['PUT', '/api/theme']]) {
      assert.equal((await call(method!, url!, undefined, null)).status, 401, `${method} ${url}`);
      assert.equal((await call(method!, url!, undefined, 'wrong-token')).status, 401, `${method} ${url} with a wrong token`);
    }
    const theme = (await screens()).theme;
    assert.equal(theme.name, 'default');
    assert.equal(theme.logo, null);
  });

  test('a theme from start to everyone: copy, edit, add a logo, use it', async () => {
    const list = await (await call('GET', '/api/themes')).json();
    assert.equal(list.active, 'default');
    assert.deepEqual(list.themes.map((t: { name: string }) => t.name), [...BUILTIN_THEMES]);

    const created = await call('POST', '/api/themes', { name: 'acme', from: 'flat' });
    assert.equal(created.status, 201);
    assert.match((await created.json()).css, /--header-bg/);

    const saved = await call('PUT', '/api/themes/acme', { css: ':root { --brand-accent: #c8102e; } .x { background: url(logo.svg); }' });
    assert.equal(saved.status, 200);
    const upload = await call('PUT', '/api/themes/acme/files/logo.svg', SVG);
    assert.equal(upload.status, 200);
    assert.deepEqual((await upload.json()).files, [{ name: 'logo.svg', size: SVG.length }]);
    assert.equal((await screens()).theme.name, 'default', 'not in use until chosen');

    // Every open page hears about it, so it shows from their next screen.
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { Origin: base } });
    const heard = new Promise<{ type: string; version: number }>((resolve) => {
      ws.on('message', (m) => {
        const msg = JSON.parse(String(m));
        if (msg.type === 'screens') resolve(msg);
      });
    });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'hello' }));
    await new Promise((r) => setTimeout(r, 100));
    const before = (await screens()).version;
    const use = await call('PUT', '/api/theme', { name: 'acme' });
    assert.equal(use.status, 200);
    assert.deepEqual(await use.json(), { active: 'acme' });
    assert.ok((await heard).version > before);
    ws.close();

    const theme = (await screens()).theme;
    assert.equal(theme.name, 'acme');
    assert.match(theme.css, /#c8102e/);
    assert.match(theme.logo!, /^\/themes\/acme\/logo\.svg\?v=/);
    assert.equal((await (await call('GET', '/api/themes')).json()).active, 'acme');
    assert.ok(fs.existsSync(path.join(dir, 'themes', 'acme', 'logo.svg')));
  });

  test('theme files are served to everyone; images can\'t run script', async () => {
    const logo = await fetch(`${base}/themes/acme/logo.svg`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
    assert.match(logo.headers.get('content-security-policy')!, /script-src 'none'/);
    assert.match(logo.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(logo.headers.get('cache-control'), 'no-cache');
    assert.deepEqual(Buffer.from(await logo.arrayBuffer()), SVG);
    const css = await fetch(`${base}/themes/green/theme.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type')!, /text\/css/);
    assert.equal((await fetch(`${base}/themes/acme/logo.svg`, { method: 'HEAD' })).status, 200);
    for (const bad of ['/themes/acme/missing.png', '/themes/nope/theme.css', '/themes/acme/%2E%2E%2Factive.json', '/themes/..%2Factive.json/x', '/themes/acme', '/themes/acme/a/b.png', '/themes/%E0%A4%A/x.png']) {
      assert.equal((await fetch(base + bad)).status, 404, bad);
    }
  });

  test('renaming the theme in use keeps it in use; it can\'t be deleted', async () => {
    const renamed = await call('POST', '/api/themes/acme/rename', { to: 'acme-corp' });
    assert.equal(renamed.status, 200);
    assert.equal((await screens()).theme.name, 'acme-corp');
    const del = await call('DELETE', '/api/themes/acme-corp');
    assert.equal(del.status, 409);
    assert.match((await del.json()).error, /in use/);
    assert.equal((await call('POST', '/api/themes', { name: 'spare' })).status, 201, 'copies Default when "from" is left out');
    assert.equal((await call('DELETE', '/api/themes/spare')).status, 204);
    assert.equal((await call('GET', '/api/themes/spare')).status, 404);
  });

  test('built-in themes can be read and used, not changed', async () => {
    const flat = await call('GET', '/api/themes/flat');
    assert.equal(flat.status, 200);
    assert.equal((await flat.json()).builtin, true);
    assert.equal((await call('PUT', '/api/themes/flat', { css: '' })).status, 403);
    assert.equal((await call('DELETE', '/api/themes/flat')).status, 403);
    assert.equal((await call('PUT', '/api/themes/flat/files/logo.png', PNG)).status, 403);
    assert.equal((await call('POST', '/api/themes/flat/rename', { to: 'x' })).status, 403);
  });

  test('bad requests get the reason', async () => {
    const expect = async (res: Response, status: number, error?: RegExp) => {
      assert.equal(res.status, status);
      if (error) assert.match((await res.json()).error, error);
    };
    await expect(await call('POST', '/api/themes', 'not json'), 400, /not valid JSON/);
    await expect(await call('POST', '/api/themes', { name: 'bad name' }), 400, /letters, digits/);
    await expect(await call('POST', '/api/themes', { name: 'acme-corp' }), 409);
    await expect(await call('PUT', '/api/themes/acme-corp', { css: 7 }), 400, /css/);
    await expect(await call('PUT', '/api/themes/acme-corp/files/logo.png', SVG), 400, /not a PNG/);
    await expect(await call('PUT', '/api/themes/acme-corp/files/..%2Fx.png', PNG), 400);
    await expect(await call('PUT', '/api/themes/acme-corp/files/big.png', Buffer.concat([PNG, Buffer.alloc(MAX_THEME_FILE)])), 413);
    await expect(await call('PUT', '/api/theme', { name: 'nope' }), 404);
    await expect(await call('PUT', '/api/theme', {}), 404);
    await expect(await call('GET', '/api/theme'), 405);
    await expect(await call('PATCH', '/api/themes/acme-corp'), 405);
    await expect(await call('GET', '/api/themes/acme-corp/other'), 404);
    await expect(await call('DELETE', '/api/themes/acme-corp/files/missing.png'), 404);
  });

  test('using a built-in theme again', async () => {
    assert.equal((await call('PUT', '/api/theme', { name: 'default' })).status, 200);
    const theme = (await screens()).theme;
    assert.equal(theme.name, 'default');
    assert.equal(theme.logo, null);
  });
});

test('the README documents every CSS variable the designer offers', async () => {
  const { THEME_VARIABLES } = await import('@veneer/screens');
  const readme = fs.readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
  for (const v of THEME_VARIABLES) assert.ok(readme.includes(`| \`${v.name}\` |`), v.name);
});

test('the release ships the built-in themes beside the server', () => {
  const script = fs.readFileSync(new URL('../../../scripts/package.mjs', import.meta.url), 'utf8');
  assert.match(script, /copy\('packages\/server\/themes'\)/);
});
