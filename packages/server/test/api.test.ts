import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createServer, type VeneerServer } from '../src/server.ts';
import { FakeHost } from './fakeHost.ts';

const TOKEN = 'test-designer-token';
let host: FakeHost;
let server: VeneerServer;
let base: string;
let dir: string;

const definition = {
  id: 'order-entry',
  name: 'Order Entry',
  match: { text: [{ row: 1, col: 34, text: 'Order Entry' }] },
  title: 'New order',
  changes: [{ op: 'hide', at: { row: 3, col: 2 } }],
};

before(async () => {
  host = new FakeHost();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-api-'));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"id": "broken"');
  server = createServer({
    listenHost: '127.0.0.1', listenPort: 0,
    host: { host: '127.0.0.1', port: await host.start(), tls: false },
    idleTimeoutMs: 0, resumeGraceMs: 0, maxSessions: 5, allowedOrigins: [],
    screensDir: dir, designerToken: TOKEN,
  });
  base = `127.0.0.1:${(await server.listen()).port}`;
});

after(async () => {
  await server.close();
  await host.stop();
});

/** The designer access part of /api/config. */
const access = ({ designer, tokenRequired }: { designer: boolean; tokenRequired: boolean }) => ({ designer, tokenRequired });

const put = (id: string, body: unknown, token: string | null = TOKEN) => fetch(`http://${base}/api/screens/${id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('reports whether the designer is enabled; invalid files are skipped', async () => {
  assert.deepEqual(access(await (await fetch(`http://${base}/api/config`)).json()), { designer: true, tokenRequired: true });
  const list = await (await fetch(`http://${base}/api/screens`)).json();
  assert.deepEqual(list.screens, []);
});

test('saving requires the designer token', async () => {
  assert.equal((await put('order-entry', definition, null)).status, 401);
  assert.equal((await put('order-entry', definition, 'wrong-token-value')).status, 401);
});

test('saves, lists and deletes definitions, notifying connected browsers', async () => {
  const ws = new WebSocket(`ws://${base}/ws`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello' }));
  const notified = new Promise<{ type: string; version: number }>((resolve) => {
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'screens') resolve(m); });
  });
  await new Promise((r) => setTimeout(r, 100));

  const res = await put('order-entry', definition);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).title, 'New order');
  assert.ok(fs.existsSync(path.join(dir, 'order-entry.json')), 'written to disk');
  assert.equal((await notified).version, 1);

  const list = await (await fetch(`http://${base}/api/screens`)).json();
  assert.deepEqual(list.screens.map((s: { id: string }) => s.id), ['order-entry']);

  const del = await fetch(`http://${base}/api/screens/order-entry`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(del.status, 204);
  assert.ok(!fs.existsSync(path.join(dir, 'order-entry.json')));
  ws.close();
});

test('saves site-wide CSS and JavaScript to global.css and global.js', async () => {
  const save = (body: unknown, token: string | null = TOKEN) => fetch(`http://${base}/api/site`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal((await save({ css: 'x' }, null)).status, 401);
  const scripts = { load: 'console.log(1)', screen: 'console.log(2)' };
  assert.equal((await save({ css: 'body { color: red }', scripts })).status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'global.css'), 'utf8'), 'body { color: red }\n');
  assert.equal(fs.readFileSync(path.join(dir, 'global.js'), 'utf8'), 'console.log(1)\n');
  assert.equal(fs.readFileSync(path.join(dir, 'global-screen.js'), 'utf8'), 'console.log(2)\n');
  const list = await (await fetch(`http://${base}/api/screens`)).json();
  assert.deepEqual(list.site, { css: 'body { color: red }', scripts });

  // A designer page opened before themes still sends a style: it is ignored, not saved.
  assert.equal((await save({ css: 'body { color: red }', scripts, style: { look: 'soft' } })).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'global.style.json')), 'styles are themes now');
  assert.equal((await (await fetch(`http://${base}/api/screens`)).json()).site.style, undefined);

  assert.equal((await save({ css: '', scripts: {} })).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'global.css')), 'empty file removed');
  assert.ok(!fs.existsSync(path.join(dir, 'global.js')));
  assert.ok(!fs.existsSync(path.join(dir, 'global-screen.js')));
});

test('the screen inventory is for designers only', async () => {
  assert.equal((await fetch(`http://${base}/api/inventory`)).status, 401);
  const res = await fetch(`http://${base}/api/inventory`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).screens));
  assert.equal((await fetch(`http://${base}/api/inventory`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } })).status, 204);
});

test('rejects invalid definitions with the reason', async () => {
  const bad = await put('order-entry', { ...definition, changes: [{ op: 'hide', at: { row: 0, col: 1 } }] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /changes\[0\]\.at\.row/);
  assert.equal((await put('other-id', definition)).status, 400, 'id must match the URL');
  assert.equal((await put('order-entry', 'not json')).status, 400);
  assert.equal((await put('..%2Fetc', definition)).status, 400);
});

test('definitions on disk are loaded at startup', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-api-'));
  fs.writeFileSync(path.join(dir2, 'order-entry.json'), JSON.stringify(definition));
  const other = createServer({
    listenHost: '127.0.0.1', listenPort: 0, host: { host: '127.0.0.1', port: 1, tls: false },
    idleTimeoutMs: 0, resumeGraceMs: 0, maxSessions: 1, allowedOrigins: [], screensDir: dir2,
  });
  const port = (await other.listen()).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/api/screens`)).json();
  assert.equal(list.screens[0].id, 'order-entry');
  assert.deepEqual(access(await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()), { designer: false, tokenRequired: false });
  const res = await fetch(`http://127.0.0.1:${port}/api/screens/order-entry`, { method: 'DELETE', headers: { Authorization: 'Bearer x' } });
  assert.equal(res.status, 403, 'designer disabled without a token');
  await other.close();
});

test('a style saved before themes is not read as a screen', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-api-'));
  fs.writeFileSync(path.join(d, 'global.style.json'), JSON.stringify({ look: 'green', corners: 'square' }));
  const s = createServer({
    listenHost: '127.0.0.1', listenPort: 0, host: { host: '127.0.0.1', port: 1, tls: false },
    idleTimeoutMs: 0, resumeGraceMs: 0, maxSessions: 1, allowedOrigins: [], screensDir: d,
  });
  const list = await (await fetch(`http://127.0.0.1:${(await s.listen()).port}/api/screens`)).json();
  await s.close();
  assert.deepEqual(list.screens, []);
  assert.equal(list.site.style, undefined);
  assert.equal(list.theme.name, 'site', 'it became a theme (themes.test.ts)');
});

/** A request with headers fetch() won't let us set (Host). */
function raw(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('local mode: this machine uses the designer without the token', async () => {
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-api-'));
  const local = createServer({
    listenHost: '127.0.0.1', listenPort: 0, host: { host: '127.0.0.1', port: 1, tls: false },
    idleTimeoutMs: 0, resumeGraceMs: 0, maxSessions: 1, allowedOrigins: [], screensDir: dir3,
    designerLocal: true, designerToken: TOKEN,
  });
  const port = (await local.listen()).port;
  const host = `localhost:${port}`;
  const body = JSON.stringify(definition);
  const json = { 'Content-Type': 'application/json' };

  assert.deepEqual(access(JSON.parse((await raw(port, 'GET', '/api/config', { Host: host })).body)), { designer: true, tokenRequired: false });
  assert.equal((await raw(port, 'PUT', '/api/screens/order-entry', { ...json, Host: host, Origin: `http://${host}` }, body)).status, 200);
  assert.equal((await raw(port, 'PUT', '/api/screens/order-entry', { ...json, Host: `127.0.0.1:${port}` }, body)).status, 200);

  // Not local: another site's page (DNS rebinding), a cross-origin page, or a request through a proxy.
  assert.equal((await raw(port, 'PUT', '/api/screens/order-entry', { ...json, Host: `evil.example:${port}` }, body)).status, 401);
  assert.equal((await raw(port, 'PUT', '/api/screens/order-entry', { ...json, Host: host, Origin: 'http://evil.example' }, body)).status, 401);
  assert.equal((await raw(port, 'PUT', '/api/screens/order-entry', { ...json, Host: host, 'X-Forwarded-For': '10.1.2.3' }, body)).status, 401);
  assert.deepEqual(access(JSON.parse((await raw(port, 'GET', '/api/config', { Host: host, 'X-Forwarded-For': '10.1.2.3' })).body)), { designer: true, tokenRequired: true });
  // The token still works for those.
  assert.equal((await raw(port, 'PUT', '/api/screens/order-entry', { ...json, Host: host, 'X-Forwarded-For': '10.1.2.3', Authorization: `Bearer ${TOKEN}` }, body)).status, 200);
  await local.close();
});
