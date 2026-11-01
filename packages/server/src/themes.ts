// Themes on disk: a style sheet and images per theme, in the screens folder so
// they are versioned in git with the screen definitions:
//
//   <screens>/themes/<name>/theme.css    the style sheet
//   <screens>/themes/<name>/logo.svg     images (logo.* replaces the header logo)
//   <screens>/themes/active.json         {"theme": "<name>"}: the theme in use
//
// Built-in themes (packages/server/themes/<name>/theme.css) come with Veneer:
// they can be used and copied, not changed. A site that saved a style in the
// designer before themes (global.style.json) gets it as a theme on first start.

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_THEMES, DEFAULT_THEME, MAX_THEME_CSS, MAX_THEME_FILE, MAX_THEME_FILES, THEME_NAME, isBuiltinTheme, themeBase, themeImageType, themeLogo,
  validateStyle, type ActiveTheme, type SiteStyle, type ThemeSummary,
} from '@veneer/screens';
import { log } from './log.ts';

/** Where the built-in themes are, from src/ (development) and dist/ (installed) alike. */
export const BUILTIN_DIR = fileURLToPath(new URL('../themes/', import.meta.url));
const CSS_FILE = 'theme.css';
const ACTIVE_FILE = 'active.json';
const OLD_STYLE_FILE = 'global.style.json';

/** A request the store refuses, with the HTTP status that says why. */
export class ThemeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ThemeError';
    this.status = status;
  }
}

/** A theme with its style sheet. */
export interface Theme extends ThemeSummary {
  css: string;
}

export class ThemeStore extends EventEmitter<{ changed: [] }> {
  /** The folder of the site's own themes: <screens>/themes. */
  readonly dir: string;
  private readonly screensDir: string;
  private readonly builtinDir: string;
  private activeName: string = DEFAULT_THEME;
  /** The theme in use, as pages get it; rebuilt after a change. */
  private activeCache: ActiveTheme | null = null;

  constructor(screensDir: string, builtinDir = BUILTIN_DIR) {
    super();
    this.screensDir = screensDir;
    this.dir = path.join(screensDir, 'themes');
    this.builtinDir = builtinDir;
  }

  /** Read which theme is in use, turning an old saved style into a theme the first time. */
  async load(): Promise<void> {
    this.activeCache = null;
    const text = await readText(path.join(this.dir, ACTIVE_FILE));
    if (text === undefined) {
      this.activeName = (await this.upgradeStyle()) ?? DEFAULT_THEME;
      return;
    }
    let name: unknown;
    try {
      name = (JSON.parse(text) as { theme?: unknown }).theme;
    } catch {
      name = undefined;
    }
    if (typeof name !== 'string' || !(await this.exists(name))) {
      log.warn('theme in use not found; using the default theme', { file: path.join(this.dir, ACTIVE_FILE), theme: String(name).slice(0, 40) });
      this.activeName = DEFAULT_THEME;
      return;
    }
    this.activeName = name;
    log.info('theme in use', { theme: name });
  }

  get active(): string {
    return this.activeName;
  }

  /** Every theme: the built-in ones in their order, then the site's by name. */
  async list(): Promise<ThemeSummary[]> {
    const own = (await readDirNames(this.dir)).filter((n) => THEME_NAME.test(n) && !isBuiltinTheme(n)).sort();
    const out: ThemeSummary[] = [];
    for (const name of [...BUILTIN_THEMES, ...own]) {
      if (await this.exists(name)) out.push({ name, builtin: isBuiltinTheme(name), files: await this.files(name) });
    }
    return out;
  }

  async get(name: string): Promise<Theme | undefined> {
    if (!(await this.exists(name))) return undefined;
    return { name, builtin: isBuiltinTheme(name), css: (await readText(this.cssFile(name))) ?? '', files: await this.files(name) };
  }

  /** The theme in use, with its style sheet and logo, for every page. */
  async activeTheme(): Promise<ActiveTheme> {
    if (this.activeCache) return this.activeCache;
    const theme = (await this.get(this.activeName)) ?? (await this.get(DEFAULT_THEME));
    if (!theme) return { name: DEFAULT_THEME, builtin: true, css: '', logo: null };
    const logo = themeLogo(theme.files.map((f) => f.name));
    let logoUrl: string | null = null;
    if (logo) {
      // The file's time and size in the URL, so a new logo shows without waiting for a cache.
      const stat = await fs.stat(path.join(this.folder(theme.name), logo));
      logoUrl = `${themeBase(theme.name)}${encodeURIComponent(logo)}?v=${Math.round(stat.mtimeMs)}-${stat.size}`;
    }
    this.activeCache = { name: theme.name, builtin: theme.builtin, css: theme.css, logo: logoUrl };
    return this.activeCache;
  }

  /** A new theme, copied from another (built-in or the site's): its style sheet and images. */
  async create(name: string, from: string): Promise<Theme> {
    this.checkName(name);
    if (isBuiltinTheme(name)) throw new ThemeError(409, `"${name}" is a built-in theme; choose another name`);
    if (await this.exists(name)) throw new ThemeError(409, `There is already a theme named "${name}"`);
    const source = await this.get(from);
    if (!source) throw new ThemeError(404, `No theme named "${from}" to copy`);
    const folder = this.folder(name);
    await fs.mkdir(folder, { recursive: true });
    for (const f of source.files) await fs.copyFile(path.join(this.folder(from), f.name), path.join(folder, f.name));
    await writeAtomic(path.join(folder, CSS_FILE), source.css);
    this.changed();
    return (await this.get(name))!;
  }

  async saveCss(name: string, css: unknown): Promise<Theme> {
    await this.ownTheme(name);
    if (typeof css !== 'string') throw new ThemeError(400, 'css: must be text');
    if (css.length > MAX_THEME_CSS) throw new ThemeError(400, `css: must be at most ${MAX_THEME_CSS} characters`);
    await writeAtomic(this.cssFile(name), css);
    this.changed();
    return (await this.get(name))!;
  }

  /** Rename one of the site's themes; if it is in use, it stays in use under the new name. */
  async rename(from: string, to: string): Promise<Theme> {
    await this.ownTheme(from);
    this.checkName(to);
    if (isBuiltinTheme(to)) throw new ThemeError(409, `"${to}" is a built-in theme; choose another name`);
    if (from === to) return (await this.get(from))!;
    if (await this.exists(to)) throw new ThemeError(409, `There is already a theme named "${to}"`);
    await fs.rename(this.folder(from), this.folder(to));
    if (this.activeName === from) await this.writeActive(to);
    this.changed();
    return (await this.get(to))!;
  }

  /** Delete one of the site's themes. The theme in use can't be deleted. */
  async remove(name: string): Promise<void> {
    await this.ownTheme(name);
    if (this.activeName === name) throw new ThemeError(409, `"${name}" is in use; use another theme for everyone first`);
    await fs.rm(this.folder(name), { recursive: true, force: true });
    this.changed();
  }

  /** Add or replace an image. Its content must be the type its name says. */
  async putFile(name: string, file: string, data: Buffer): Promise<ThemeSummary['files']> {
    await this.ownTheme(name);
    const type = themeImageType(file);
    if (!type) throw new ThemeError(400, 'File names are letters, digits, "-" and "_", ending in .png, .svg, .jpg, .jpeg, .webp or .gif');
    if (data.length === 0) throw new ThemeError(400, 'The file is empty');
    if (data.length > MAX_THEME_FILE) throw new ThemeError(413, `Images must be at most ${MAX_THEME_FILE / 1024 / 1024} MB`);
    if (!isImage(data, type)) throw new ThemeError(400, `The file is not a ${type.replace('image/', '').replace('+xml', '').toUpperCase()} image`);
    const files = await this.files(name);
    if (!files.some((f) => f.name === file) && files.length >= MAX_THEME_FILES) {
      throw new ThemeError(400, `A theme can hold at most ${MAX_THEME_FILES} images`);
    }
    // Another spelling of the same name (Logo.PNG for logo.png) replaces it, so one file is served.
    for (const f of files) {
      if (f.name !== file && f.name.toLowerCase() === file.toLowerCase()) await fs.rm(path.join(this.folder(name), f.name), { force: true });
    }
    await writeAtomic(path.join(this.folder(name), file), data);
    this.changed();
    return this.files(name);
  }

  async removeFile(name: string, file: string): Promise<ThemeSummary['files']> {
    await this.ownTheme(name);
    const files = await this.files(name);
    if (!themeImageType(file) || !files.some((f) => f.name === file)) throw new ThemeError(404, `No image "${file.slice(0, 64)}" in "${name}"`);
    await fs.rm(path.join(this.folder(name), file), { force: true });
    this.changed();
    return this.files(name);
  }

  /** Use a theme for everyone: pages show it from their next screen. */
  async setActive(name: string): Promise<void> {
    if (typeof name !== 'string' || !(await this.exists(name))) throw new ThemeError(404, `No theme named "${String(name).slice(0, 40)}"`);
    await this.writeActive(name);
    log.info('theme in use', { theme: name });
    this.changed();
  }

  /** The path of a theme's style sheet or image, for serving; undefined if there is none. */
  async filePath(name: string, file: string): Promise<{ path: string; type: string } | undefined> {
    if (!THEME_NAME.test(name)) return undefined;
    const type = file === CSS_FILE ? 'text/css; charset=utf-8' : themeImageType(file);
    if (!type || !(await this.exists(name))) return undefined;
    const p = path.join(this.folder(name), file);
    return (await isFile(p)) ? { path: p, type } : undefined;
  }

  // ---- inside

  private folder(name: string): string {
    return isBuiltinTheme(name) ? path.join(this.builtinDir, name) : path.join(this.dir, name);
  }

  private cssFile(name: string): string {
    return path.join(this.folder(name), CSS_FILE);
  }

  private async exists(name: string): Promise<boolean> {
    return THEME_NAME.test(name) && isFile(this.cssFile(name));
  }

  private async files(name: string): Promise<ThemeSummary['files']> {
    const folder = this.folder(name);
    const out: ThemeSummary['files'] = [];
    for (const f of (await readDirNames(folder)).sort()) {
      if (!themeImageType(f)) continue;
      const stat = await fs.stat(path.join(folder, f)).catch(() => undefined);
      if (stat?.isFile()) out.push({ name: f, size: stat.size });
    }
    return out;
  }

  private checkName(name: unknown): asserts name is string {
    if (typeof name !== 'string' || !THEME_NAME.test(name)) {
      throw new ThemeError(400, 'Theme names are 1 to 40 letters, digits, "-" and "_"');
    }
  }

  /** The site's own theme `name`, which can be changed. */
  private async ownTheme(name: string): Promise<void> {
    if (isBuiltinTheme(name)) throw new ThemeError(403, `"${name}" is a built-in theme; copy it to change it`);
    if (!(await this.exists(name))) throw new ThemeError(404, `No theme named "${String(name).slice(0, 40)}"`);
  }

  private async writeActive(name: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeAtomic(path.join(this.dir, ACTIVE_FILE), JSON.stringify({ theme: name }, null, 2) + '\n');
    this.activeName = name;
  }

  private changed(): void {
    this.activeCache = null;
    this.emit('changed');
  }

  /**
   * A site that chose a style before themes (global.style.json) gets it as a
   * theme, "site", made the theme in use, so nothing changes for its users.
   * The old file is left in place. Returns the theme's name, if one was made.
   */
  private async upgradeStyle(): Promise<string | undefined> {
    const text = await readText(path.join(this.screensDir, OLD_STYLE_FILE));
    if (!text) return undefined;
    let style: SiteStyle;
    try {
      style = validateStyle(JSON.parse(text));
    } catch (err) {
      log.warn('ignoring invalid style', { file: OLD_STYLE_FILE, error: (err as Error).message });
      return undefined;
    }
    if (style.look === 'default' && Object.keys(style).length === 1) return undefined;
    let name = 'site';
    for (let n = 2; await this.exists(name); n++) name = `site-${n}`;
    const look = (await readText(path.join(this.builtinDir, style.look, CSS_FILE))) ?? '';
    const css = `/* Made from the style chosen in the designer before themes (${OLD_STYLE_FILE}):\n   ${JSON.stringify(style)} */\n\n${look}${styleCss(style)}`;
    await fs.mkdir(this.folder(name), { recursive: true });
    await writeAtomic(this.cssFile(name), css);
    await this.writeActive(name);
    log.info('turned the saved style into a theme', { file: OLD_STYLE_FILE, theme: name, style });
    return name;
  }
}

/** The old style's options (accent, corners, density, font) as CSS, after its look's style sheet. */
export function styleCss(style: SiteStyle): string {
  const parts: string[] = [];
  if (style.accent) parts.push(`:root { --brand-accent: ${style.accent}; }`);
  if (style.corners === 'square') parts.push(':root * { border-radius: 0 !important; }');
  if (style.corners === 'round') {
    parts.push(
      ':root :is(.sheet, .dialog, .help-popover) { border-radius: 22px !important; }',
      ':root :is(.field, .banner, .card, .table, .toast) { border-radius: 12px !important; }',
      ':root :is(button, .menu-key, .custom-badge) { border-radius: 999px !important; }',
      ':root .tab-strip button { border-radius: 12px 12px 0 0 !important; }',
    );
  }
  if (style.density === 'compact') parts.push(':root { --rh: 1.55em; }', ':root .keybar { padding: 6px 10px; }', ':root .keybar button { padding: 4px 9px; }');
  if (style.density === 'normal') parts.push(':root { --rh: 1.9em; }');
  if (style.density === 'roomy') parts.push(':root { --rh: 2.2em; }', ':root .keybar button { padding: 9px 14px; }');
  if (style.font === 'mono') parts.push(':root { --font: var(--mono); }', ':root body { font-family: var(--mono); }');
  if (style.font === 'sans') {
    parts.push(
      ':root { --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }',
      ':root body { font-family: var(--font); }',
    );
  }
  return parts.length ? `\n/* The style's options */\n${parts.join('\n')}\n` : '';
}

/**
 * Whether `data` is an image of `type`, by its first bytes (the name alone
 * could lie). An SVG must be UTF-8 text whose first element is <svg>.
 */
export function isImage(data: Buffer, type: string): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  switch (type) {
    case 'image/png': return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg': return starts(0xff, 0xd8, 0xff);
    case 'image/gif': return data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a';
    case 'image/webp': return data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'image/svg+xml': {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, 4096)).replace(/^﻿/, '');
      return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text);
    }
    default: return false;
  }
}

/**
 * GET /themes/<name>/<file>: a theme's style sheet or image, for every page.
 * Images are sandboxed, so an SVG opened directly can't run script.
 */
export async function serveThemeFile(themes: ThemeStore, req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const m = /^\/themes\/([^/]+)\/([^/]+)$/.exec(pathname);
  let found: { path: string; type: string } | undefined;
  if (m) {
    try {
      found = await themes.filePath(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
    } catch {
      found = undefined; // a malformed escape
    }
  }
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const data = await fs.readFile(found.path);
  res.writeHead(200, {
    'Content-Type': found.type,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'none'; sandbox",
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw err;
  }
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}
