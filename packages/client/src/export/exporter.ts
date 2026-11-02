// Exporting a whole 5250 list: page forward to the bottom collecting rows, then
// page back so the user is where they started. The exporter only decides the
// next key; the app sends it and reports each new screen.

import type { AidName } from '@veneer/terminal';
import type { Item, ScreenView, TableItem } from '../transform/types.ts';
import { exportColumns, headerOf, pageRows, type Sheet } from './sheet.ts';

/** Stop after this many pages, whatever the host says. */
export const MAX_PAGES = 500;

export type Step =
  | { send: AidName }
  /** Finished: `sheet` unless cancelled or failed. */
  | { done: true; sheet?: Sheet; error?: string };

export interface Progress {
  phase: 'rewinding' | 'paging' | 'returning';
  pages: number;
  rows: number;
}

/** The list to export: the first table, in the pop-up window if one is open. */
export function listOf(view: ScreenView): TableItem | undefined {
  const items: Item[] = view.window ? view.window.items : view.items;
  return items.find((i): i is TableItem => i.kind === 'table');
}

/**
 * Pages up to the top of the list, then down to the bottom collecting every
 * page, then back to the page the user was on. The top and bottom are where a
 * page key no longer changes the rows (or the host answers with an error, such
 * as "roll past the first record"); "Bottom" also ends it.
 */
export class ListExporter {
  private readonly at: { row: number; col: number };
  private readonly columns: number[];
  private readonly sheet: Sheet;
  private readonly screenId: string;
  private readonly maxPages: number;
  private phase: Progress['phase'] = 'rewinding';
  /** Pages from the user's page: negative above it, positive below. */
  private pos = 0;
  /** The page key last sent, to undo `pos` if the page didn't move. */
  private moved = 0;
  private pages = 0;
  private lastPage: string;
  private cancelled = false;
  private error: string | undefined;

  constructor(table: TableItem, screenId: string, maxPages = MAX_PAGES) {
    this.at = { row: table.row, col: table.col };
    this.columns = exportColumns(table);
    this.sheet = { header: headerOf(table, this.columns), rows: [] };
    this.screenId = screenId;
    this.maxPages = maxPages;
    this.lastPage = this.signature(table);
  }

  get progress(): Progress {
    return { phase: this.phase, pages: this.pages, rows: this.sheet.rows.length };
  }

  /** The first step, from the page showing when the export started. */
  start(): Step {
    return this.page('PageUp');
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * A new screen arrived. `refused` means the host answered the page key with
   * an error (the page did not move).
   */
  onScreen(view: ScreenView, screenId: string, refused = false): Step {
    const table = listOf(view);
    const same = screenId === this.screenId && table !== undefined && table.row === this.at.row && table.col === this.at.col;
    const stayed = refused || (same && this.signature(table!) === this.lastPage);
    if (stayed) this.pos -= this.moved;
    // Returning: stop if the page won't move rather than press the key forever.
    if (this.phase === 'returning') return same && !stayed ? this.back() : this.finish();
    if (!same) {
      this.error = 'The list changed while exporting, so the export stopped.';
      return this.back();
    }
    if (this.cancelled) return this.back();
    this.lastPage = this.signature(table!);

    if (this.phase === 'rewinding') {
      if (!stayed && -this.pos < this.maxPages) return this.page('PageUp');
      // At the top: collect from here down.
      this.phase = 'paging';
      return this.collect(table!);
    }
    if (stayed) return this.back();
    return this.collect(table!);
  }

  private collect(table: TableItem): Step {
    this.sheet.rows.push(...pageRows(table, this.columns));
    this.pages++;
    return table.more && this.pages < this.maxPages ? this.page('PageDown') : this.back();
  }

  private signature(table: TableItem): string {
    return JSON.stringify(pageRows(table, this.columns));
  }

  private page(aid: 'PageUp' | 'PageDown'): Step {
    this.moved = aid === 'PageDown' ? 1 : -1;
    this.pos += this.moved;
    return { send: aid };
  }

  /** Head back to the user's page, or finish when there. */
  private back(): Step {
    this.phase = 'returning';
    if (this.pos === 0) return this.finish();
    return this.page(this.pos > 0 ? 'PageUp' : 'PageDown');
  }

  private finish(): Step {
    if (this.error) return { done: true, error: this.error };
    return this.cancelled ? { done: true } : { done: true, sheet: this.sheet };
  }
}
