// /api: screen definitions and the theme for the client, editing for the
// designer (definitions, site code, themes), and /api/admin for the admin page.

import { createHash, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import { DefinitionError, ID_PATTERN, MAX_THEME_FILE } from '@veneer/screens';
import { log, recentProblems } from './log.ts';
import { listComponents } from './components.ts';
import type { ScreenInventory } from './inventory.ts';
import type { SessionManager } from './sessions.ts';
import type { ScreenStore } from './store.ts';
import { ThemeError, type ThemeStore } from './themes.ts';
import { brandInfo, type Brand } from './brand.ts';

const MAX_BODY = 1024 * 1024;

export interface ApiOptions {
  store: ScreenStore;
  themes?: ThemeStore | undefined;
  inventory?: ScreenInventory | undefined;
  /** Bearer token required to change definitions. */
  designerToken?: string | undefined;
  /** Requests from this machine may change definitions without the token. */
  designerLocal?: boolean | undefined;
  sessions?: SessionManager | undefined;
  /** Bearer token for /api/admin. */
  adminToken?: string | undefined;
  /** Requests from this machine may use /api/admin without the token. */
  adminLocal?: boolean | undefined;
  /** Directory of custom components. */
  componentsDir?: string | undefined;
  /** Server facts for the admin page. */
  info?: (() => Record<string, unknown>) | undefined;
  brand?: Brand | undefined;
}

/** How a request may use the designer or admin page: freely, with the token, or not at all. */
type Access = 'open' | 'token' | 'off';

interface Role {
  local: boolean | undefined;
  token: string | undefined;
  /** Why the role is off, and what a missing token is called. */
  off: string;
  tokenName: string;
}

const designerRole = (opts: ApiOptions): Role => ({
  local: opts.designerLocal, token: opts.designerToken,
  off: 'The designer is disabled (set VENEER_DESIGNER=local or VENEER_DESIGNER_TOKEN)', tokenName: 'Designer token',
});

const adminRole = (opts: ApiOptions): Role => ({
  local: opts.adminLocal, token: opts.adminToken,
  off: 'The admin page is disabled (set VENEER_ADMIN=local or VENEER_ADMIN_TOKEN)', tokenName: 'Admin token',
});

/** Handle an /api request. Returns false if the path is not an API route. */
export function handleApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, opts: ApiOptions): boolean {
  if (!pathname.startsWith('/api/')) return false;
  void route(req, res, pathname, opts).catch((err: Error) => {
    log.error('api error', { path: pathname, error: err.message });
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
  });
  return true;
}

async function route(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, opts: ApiOptions): Promise<void> {
  const { store } = opts;
  res.setHeader('Cache-Control', 'no-store');

  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) return admin(req, res, pathname, opts);

  if (pathname === '/api/config' && req.method === 'GET') {
    const access = accessFor(req, designerRole(opts));
    return json(res, 200, { designer: access !== 'off', tokenRequired: access === 'token', brand: brandInfo(opts.brand ?? {}) });
  }
  if (pathname === '/api/screens' && req.method === 'GET') {
    const theme = opts.themes ? await opts.themes.activeTheme() : undefined;
    return json(res, 200, { version: store.version, screens: store.list(), site: store.site, ...(theme ? { theme } : {}) });
  }

  if ((pathname === '/api/theme' || pathname === '/api/themes' || pathname.startsWith('/api/themes/')) && opts.themes) {
    return themes(req, res, pathname, opts.themes, opts);
  }

  if (pathname === '/api/components' && req.method === 'GET') {
    return json(res, 200, { components: listComponents(opts.componentsDir) });
  }

  if (pathname === '/api/inventory') {
    if (req.method !== 'GET' && req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
    // Designers only: it lists every screen the business uses.
    if (!allowed(req, res, designerRole(opts))) return;
    if (req.method === 'DELETE') {
      opts.inventory?.clear();
      log.info('screen inventory cleared');
      return void res.writeHead(204).end();
    }
    return json(res, 200, { screens: opts.inventory?.list() ?? [] });
  }

  if (pathname === '/api/site') {
    if (req.method !== 'PUT') return json(res, 405, { error: 'Method not allowed' });
    if (!allowed(req, res, designerRole(opts))) return;
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { error: (err as Error).message.startsWith('Body') ? (err as Error).message : 'Body is not valid JSON' });
    }
    try {
      const site = await store.saveSite(body);
      log.info('site customization saved', { css: site.css.length, load: site.scripts.load.length, screen: site.scripts.screen.length });
      return json(res, 200, site);
    } catch (err) {
      if (err instanceof DefinitionError) return json(res, 400, { error: err.message });
      throw err;
    }
  }

  const m = /^\/api\/screens\/([^/]+)$/.exec(pathname);
  if (!m) return json(res, 404, { error: 'Not found' });
  const id = decodeURIComponent(m[1]!);
  if (!ID_PATTERN.test(id)) return json(res, 400, { error: 'Invalid screen id' });
  if (req.method !== 'PUT' && req.method !== 'DELETE') return json(res, 405, { error: 'Method not allowed' });
  if (!allowed(req, res, designerRole(opts))) return;

  if (req.method === 'DELETE') {
    const removed = await store.remove(id);
    if (removed) log.info('screen definition deleted', { id });
    return removed ? void res.writeHead(204).end() : json(res, 404, { error: 'No such screen' });
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, 400, { error: (err as Error).message.startsWith('Body') ? (err as Error).message : 'Body is not valid JSON' });
  }
  if ((body as { id?: unknown } | null)?.id !== id) return json(res, 400, { error: 'id in the body must match the URL' });
  try {
    const saved = await store.save(body);
    log.info('screen definition saved', { id, changes: saved.changes.length });
    return json(res, 200, saved);
  } catch (err) {
    if (err instanceof DefinitionError) return json(res, 400, { error: err.message });
    throw err;
  }
}

/**
 * The designer's theme editing:
 *   GET    /api/themes                       every theme, and the one in use
 *   POST   /api/themes                       {name, from}: a new theme, copied from another
 *   GET    /api/themes/<name>                a theme with its style sheet and images
 *   PUT    /api/themes/<name>                {css}: save its style sheet
 *   DELETE /api/themes/<name>                delete it (not the one in use)
 *   POST   /api/themes/<name>/rename         {to}
 *   PUT    /api/themes/<name>/files/<file>   the image, as the body
 *   DELETE /api/themes/<name>/files/<file>
 *   PUT    /api/theme                        {name}: use it for everyone
 */
async function themes(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, store: ThemeStore, opts: ApiOptions): Promise<void> {
  if (!allowed(req, res, designerRole(opts))) return;
  const parts = pathname.split('/').slice(3).map((p) => {
    try { return decodeURIComponent(p); } catch { return '\u0000'; }
  });
  const [name, sub, file] = parts;
  const method = req.method ?? 'GET';
  const refuse = () => json(res, 405, { error: 'Method not allowed' });
  try {
    if (pathname === '/api/theme') {
      if (method !== 'PUT') return refuse();
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      await store.setActive((body as { name?: unknown } | null)?.name as string);
      log.info('theme set for everyone', { theme: store.active });
      return json(res, 200, { active: store.active });
    }
    if (name === undefined) {
      if (method === 'GET') return json(res, 200, { active: store.active, themes: await store.list() });
      if (method !== 'POST') return refuse();
      const body = (await jsonBody(req, res)) as { name?: unknown; from?: unknown } | null | undefined;
      if (body === undefined) return;
      const theme = await store.create(body?.name as string, typeof body?.from === 'string' ? body.from : 'default');
      log.info('theme created', { theme: theme.name, from: body?.from });
      return json(res, 201, theme);
    }
    if (sub === undefined) {
      if (method === 'GET') {
        const theme = await store.get(name);
        return theme ? json(res, 200, theme) : json(res, 404, { error: `No theme named "${name.slice(0, 40)}"` });
      }
      if (method === 'PUT') {
        const body = await jsonBody(req, res);
        if (body === undefined) return;
        const theme = await store.saveCss(name, (body as { css?: unknown } | null)?.css);
        log.info('theme saved', { theme: name, css: theme.css.length });
        return json(res, 200, theme);
      }
      if (method === 'DELETE') {
        await store.remove(name);
        log.info('theme deleted', { theme: name });
        return void res.writeHead(204).end();
      }
      return refuse();
    }
    if (sub === 'rename' && file === undefined) {
      if (method !== 'POST') return refuse();
      const body = await jsonBody(req, res);
      if (body === undefined) return;
      const theme = await store.rename(name, (body as { to?: unknown } | null)?.to as string);
      log.info('theme renamed', { from: name, to: theme.name });
      return json(res, 200, theme);
    }
    if (sub === 'files' && file !== undefined && parts.length === 3) {
      if (method === 'PUT') {
        let data: Buffer;
        try {
          data = await readRaw(req, MAX_THEME_FILE);
        } catch (err) {
          return json(res, 413, { error: (err as Error).message });
        }
        const files = await store.putFile(name, file, data);
        log.info('theme image saved', { theme: name, file, bytes: data.length });
        return json(res, 200, { files });
      }
      if (method === 'DELETE') {
        const files = await store.removeFile(name, file);
        log.info('theme image deleted', { theme: name, file });
        return json(res, 200, { files });
      }
      return refuse();
    }
    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof ThemeError) return json(res, err.status, { error: err.message });
    throw err;
  }
}

/** The request's JSON body; on bad JSON, sends 400 and returns undefined. */
async function jsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req)) as unknown;
  } catch (err) {
    json(res, 400, { error: (err as Error).message.startsWith('Body') ? (err as Error).message : 'Body is not valid JSON' });
    return undefined;
  }
}

async function admin(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, opts: ApiOptions): Promise<void> {
  if (!allowed(req, res, adminRole(opts))) return;

  if (pathname === '/api/admin/status') {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    return json(res, 200, {
      server: opts.info?.() ?? {},
      sessions: opts.sessions?.list() ?? [],
      problems: recentProblems(),
    });
  }

  const m = /^\/api\/admin\/sessions\/([^/]+)\/end$/.exec(pathname);
  if (!m) return json(res, 404, { error: 'Not found' });
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const ended = opts.sessions?.end(decodeURIComponent(m[1]!), req.socket.remoteAddress ?? 'unknown') ?? false;
  return ended ? void res.writeHead(204).end() : json(res, 404, { error: 'No such session' });
}

/** Check access for a role; on refusal, send the error and return false. */
function allowed(req: http.IncomingMessage, res: http.ServerResponse, role: Role): boolean {
  const access = accessFor(req, role);
  if (access === 'off') json(res, 403, { error: role.off });
  else if (access === 'token' && !authorized(req, role.token!)) json(res, 401, { error: `${role.tokenName} required` });
  else return true;
  return false;
}

function accessFor(req: http.IncomingMessage, role: Role): Access {
  if (role.local && isLocal(req)) return 'open';
  return role.token ? 'token' : 'off';
}

/**
 * True for a browser on this machine talking to Veneer directly. A request
 * forwarded by a proxy is not local, whatever its source address. The Host and
 * Origin checks stop other web pages reaching the API through DNS rebinding.
 */
function isLocal(req: http.IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress ?? '')) return false;
  if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined) return false;
  const host = req.headers.host ?? '';
  if (!isLoopbackHost(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

function isLoopbackAddress(addr: string): boolean {
  return addr === '::1' || /^(::ffff:)?127\./.test(addr);
}

function isLoopbackHost(host: string): boolean {
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return name === 'localhost' || name === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(name);
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return given !== '' && timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return (await readRaw(req, MAX_BODY)).toString('utf8');
}

/** The request body as bytes, refused past `max` bytes. */
function readRaw(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > max) {
        done = true;
        reject(new Error(`Body larger than ${max} bytes`));
        req.resume(); // drain the rest, so the answer can still be sent
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
