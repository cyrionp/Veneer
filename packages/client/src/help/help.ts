// The Help button: press the 5250 Help key (not F1, which applications may use
// for their own purposes), read the help panel the host shows, and show it in
// a popover over the screen the user was on. Closing the popover closes the
// help on the host. Like the list exporter, the reader only decides the next
// key; the app sends it and reports each new screen.

import type { AidName } from '@veneer/terminal';
import type { ScreenView } from '../transform/types.ts';

export interface HelpPage {
  title: string;
  /** Paragraphs of help text: the panel's lines, re-joined where they were wrapped. */
  paragraphs: string[];
  /** The host has more help (PageDown shows it). */
  more: boolean;
}

export type HelpStep =
  /** Press a key. `reset` first: the host answered with an error. */
  | { send: AidName; reset?: boolean }
  /** Show (or replace) the popover's page. */
  | { show: HelpPage; reset?: boolean }
  /** Finished, back on the user's screen unless `message` says otherwise. */
  | { done: true; message?: string; reset?: boolean; back: boolean };

/** Keys that close help: Cancel, then Exit if Cancel did not. */
const CLOSE_KEYS: AidName[] = ['F12', 'F3', 'F12'];

const MARKER = /\s*(More\.\.\.|More…|Bottom|\+)\s*$/;
const KEY_LINE = /^\s*F\d{1,2}=/;

/** The help text on a screen: the pop-up window's, else the whole screen's below the title. */
export function helpPage(view: ScreenView): HelpPage {
  const snap = view.snapshot;
  const w = view.window;
  const box = w
    ? { top: w.top, bottom: w.bottom, left: w.left, right: w.right }
    : { top: 2, bottom: snap.rows - 1, left: 1, right: snap.cols };
  let lines = snap.lines.slice(box.top - 1, box.bottom).map((l) => l.slice(box.left - 1, box.right).trimEnd())
    .filter((l) => !KEY_LINE.test(l));
  // The last line with text may end with the paging marker.
  let more = false;
  const last = lines.findLastIndex((l) => l.trim() !== '');
  if (last >= 0) {
    const m = MARKER.exec(lines[last]!);
    if (m && (m[1] !== '+' || lines[last]!.trim() === '+' || lines[last]!.length >= box.right - box.left)) {
      more = m[1] !== 'Bottom';
      lines[last] = lines[last]!.slice(0, m.index);
    }
  }
  lines = trimBlank(lines);
  // A window's own first line is often its heading ("Customer - Help"): the
  // title, unless the window has one (which may be that same line).
  let title = w?.title ?? view.title ?? 'Help';
  if (w && !w.title && lines.length > 1 && lines[1]!.trim() === '') title = lines[0]!.trim();
  if (lines[0]?.trim() === title) lines = trimBlank(lines.slice(1));
  return { title, paragraphs: paragraphs(lines), more };
}

function trimBlank(lines: string[]): string[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return [];
  return lines.slice(first, lines.findLastIndex((l) => l.trim() !== '') + 1);
}

/**
 * Re-join lines the host wrapped. A blank line ends a paragraph; so does a
 * line indented more than the one before (a list or a definition), which
 * starts a new one.
 */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let indent = -1;
  const flush = () => {
    if (current.length) out.push(current.join(' '));
    current = [];
    indent = -1;
  };
  for (const line of lines) {
    if (line.trim() === '') { flush(); continue; }
    const lead = line.length - line.trimStart().length;
    if (indent >= 0 && lead > indent) flush();
    if (indent < 0) indent = lead;
    current.push(line.trim());
  }
  flush();
  return out;
}

export class HelpReader {
  private phase: 'asking' | 'showing' | 'paging' | 'closing' | 'done' = 'asking';
  private closes = 0;
  private page: HelpPage | null = null;
  /** Closed while waiting for the host: close as soon as the help shows. */
  private closeWhenShown = false;

  /** The screen id the user pressed Help on. */
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  get closing(): boolean {
    return this.phase === 'closing';
  }

  start(): HelpStep {
    return { send: 'Help' };
  }

  /** A new screen arrived; `error` when the host answered with an error message. */
  onScreen(view: ScreenView, screenId: string, error = false): HelpStep {
    switch (this.phase) {
      case 'asking':
        // An error ("help is not available"): left showing, as on a terminal, until Reset.
        if (error) return this.finish({ back: true });
        // Nothing changed: the application does not offer help here.
        if (screenId === this.origin) return this.finish({ message: 'There is no help for this screen.', back: true });
        return this.show(view);
      case 'paging':
        // An error is the host refusing to page (already at the end).
        if (error) {
          this.phase = 'showing';
          if (this.closeWhenShown) return { ...this.close()!, reset: true };
          return { show: { ...this.page!, more: false }, reset: true };
        }
        return this.show(view);
      case 'showing':
        // The host changed the help by itself; show what it shows now.
        return error ? { show: this.page!, reset: true } : this.show(view);
      case 'closing':
        if (!error && screenId === this.origin) return this.finish({ back: true });
        if (this.closes >= CLOSE_KEYS.length) {
          return this.finish({ message: 'Help did not close. Press F12 or F3 to leave it.', reset: error, back: false });
        }
        return { send: CLOSE_KEYS[this.closes++]!, ...(error ? { reset: true } : {}) };
      case 'done':
        return { done: true, back: true };
    }
  }

  /** The next page of help. */
  more(): HelpStep {
    this.phase = 'paging';
    return { send: 'PageDown' };
  }

  /** Close the help; null while waiting for the host, which is then answered by closing. */
  close(): HelpStep | null {
    if (this.phase === 'closing' || this.phase === 'done') return null;
    if (this.phase === 'asking' || this.phase === 'paging') {
      this.closeWhenShown = true;
      return null;
    }
    this.phase = 'closing';
    return { send: CLOSE_KEYS[this.closes++]! };
  }

  private show(view: ScreenView): HelpStep {
    this.phase = 'showing';
    this.page = helpPage(view);
    return this.closeWhenShown ? this.close()! : { show: this.page };
  }

  private finish(result: { message?: string | undefined; reset?: boolean; back: boolean }): HelpStep {
    this.phase = 'done';
    return {
      done: true, back: result.back,
      ...(result.message ? { message: result.message } : {}),
      ...(result.reset ? { reset: true } : {}),
    };
  }
}
