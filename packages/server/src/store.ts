// Screen definitions on disk: one <id>.json per screen, so they can be
// versioned in git. Invalid files are skipped with a warning. Site-wide CSS and
// JavaScript live beside them: global.css, global.js (page load) and
// global-screen.js (every screen). Themes are in themes/ (themes.ts);
// global.style.json, the style saved before themes, is not a screen.

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DefinitionError, ID_PATTERN, validateDefinition, validateSite, type ScreenDefinition, type SiteCustomization } from '@veneer/screens';
import { log } from './log.ts';

const STYLE_FILE = 'global.style.json';

export class ScreenStore extends EventEmitter<{ changed: [number] }> {
  readonly dir: string;
  private readonly screens = new Map<string, ScreenDefinition>();
  site: SiteCustomization = { css: '', scripts: { load: '', screen: '' } };
  /** Increases on every change, so clients can tell they are stale. */
  version = 0;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  async load(): Promise<void> {
    this.screens.clear();
    this.site = {
      css: await this.readSite('global.css'),
      scripts: { load: await this.readSite('global.js'), screen: await this.readSite('global-screen.js') },
    };
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of names.filter((n) => n.endsWith('.json') && n !== STYLE_FILE).sort()) {
      try {
        const def = validateDefinition(JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')));
        if (`${def.id}.json` !== name) throw new DefinitionError(`id "${def.id}" does not match the file name`);
        this.screens.set(def.id, def);
      } catch (err) {
        log.warn('skipping invalid screen definition', { file: name, error: (err as Error).message });
      }
    }
    log.info('screen definitions loaded', { dir: this.dir, count: this.screens.size });
  }

  list(): ScreenDefinition[] {
    return [...this.screens.values()];
  }

  /** Validate and write a definition. Throws DefinitionError on bad input. */
  async save(input: unknown): Promise<ScreenDefinition> {
    const def = validateDefinition(input);
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.file(def.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(def, null, 2) + '\n');
    await fs.rename(tmp, file);
    this.screens.set(def.id, def);
    this.bump();
    return def;
  }

  /** Write the site files; an empty one is deleted. */
  async saveSite(input: unknown): Promise<SiteCustomization> {
    const site = validateSite(input);
    await fs.mkdir(this.dir, { recursive: true });
    await this.writeSite('global.css', site.css);
    await this.writeSite('global.js', site.scripts.load);
    await this.writeSite('global-screen.js', site.scripts.screen);
    this.site = site;
    this.bump();
    return site;
  }

  private async readSite(name: string): Promise<string> {
    try {
      return await fs.readFile(path.join(this.dir, name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  private async writeSite(name: string, text: string): Promise<void> {
    const file = path.join(this.dir, name);
    if (text === '') return fs.rm(file, { force: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text.endsWith('\n') ? text : text + '\n');
    await fs.rename(tmp, file);
  }

  async remove(id: string): Promise<boolean> {
    if (!this.screens.has(id)) return false;
    await fs.rm(this.file(id), { force: true });
    this.screens.delete(id);
    this.bump();
    return true;
  }

  private file(id: string): string {
    if (!ID_PATTERN.test(id)) throw new DefinitionError('id: must be lowercase letters, digits and dashes');
    return path.join(this.dir, `${id}.json`);
  }

  /** Something pages show besides the definitions changed (the theme): tell clients to reload. */
  touch(): void {
    this.bump();
  }

  private bump(): void {
    this.version++;
    this.emit('changed', this.version);
  }
}
