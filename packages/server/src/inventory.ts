// The screen inventory: every screen any session has shown, by screen ID, with
// how often it was opened. It tells designers which screens are worth
// customizing first. Only the screen's shape is kept (ID, title, size, field
// count), never what was on it. Saved to <data dir>/inventory.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { activeWindow, findWindows, fingerprint } from '@veneer/screens';
import type { ScreenSnapshot } from '@veneer/terminal';
import { log } from './log.ts';

export interface InventoryEntry {
  /** Structural screen ID (see @veneer/screens fingerprint). */
  id: string;
  title: string | null;
  /** A pop-up window rather than a full screen. */
  window: boolean;
  rows: number;
  cols: number;
  /** Input fields in the layout (a subfile's option column counts once). */
  fields: number;
  /** Times a session arrived at this screen (paging and redraws don't count). */
  visits: number;
  firstSeen: string;
  lastSeen: string;
}

/** Keep at most this many screens; the least recently seen go first. */
const MAX_ENTRIES = 5000;
const SAVE_DELAY_MS = 5000;

export class ScreenInventory {
  private readonly entries = new Map<string, InventoryEntry>();
  /** The screen each session showed last, so redraws aren't counted as visits. */
  private readonly current = new Map<string, string>();
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly file: string | undefined;

  /** With no file, the inventory lives in memory only. */
  constructor(file?: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as { screens?: InventoryEntry[] };
      for (const e of data.screens ?? []) if (typeof e?.id === 'string') this.entries.set(e.id, e);
      log.info('screen inventory loaded', { file: this.file, screens: this.entries.size });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('could not read the screen inventory; starting a new one', { file: this.file, error: (err as Error).message });
      }
    }
  }

  /** A session is showing this screen (call with unlocked screens only). */
  record(session: string, snap: ScreenSnapshot): void {
    const print = fingerprint(snap);
    if (this.current.get(session) === print.id) return;
    this.current.set(session, print.id);
    const now = new Date().toISOString();
    const entry = this.entries.get(print.id);
    if (entry) {
      entry.visits++;
      entry.lastSeen = now;
      entry.title ??= print.title;
    } else {
      this.entries.set(print.id, {
        id: print.id,
        title: print.title,
        window: activeWindow(snap, findWindows(snap)) !== undefined,
        rows: snap.rows,
        cols: snap.cols,
        fields: print.fields,
        visits: 1,
        firstSeen: now,
        lastSeen: now,
      });
      this.trim();
    }
    this.scheduleSave();
  }

  /** The session ended. */
  forget(session: string): void {
    this.current.delete(session);
  }

  list(): InventoryEntry[] {
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
    this.current.clear();
    this.scheduleSave();
  }

  /** Write any pending changes now (on shutdown). */
  async flush(): Promise<void> {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
  }

  private trim(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    for (const e of oldest.slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(e.id);
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ screens: this.list() }, null, 1) + '\n');
      await fs.rename(tmp, this.file);
    } catch (err) {
      log.warn('could not save the screen inventory', { file: this.file, error: (err as Error).message });
    }
  }
}
