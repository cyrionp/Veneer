// Auto-transform pipeline: snapshot -> rules -> view model. Rules run in
// order; each claims the cells it renders so later rules skip them. Custom
// per-screen rules can be inserted into the list later.

import { activeWindow, findWindows } from '@veneer/screens';
import type { ScreenSnapshot } from '@veneer/terminal';
import { TransformContext } from './context.ts';
import { commandLine } from './rules/commandLine.ts';
import { fields } from './rules/fields.ts';
import { functionKeys } from './rules/functionKeys.ts';
import { menu } from './rules/menu.ts';
import { messageLine } from './rules/message.ts';
import { subfile } from './rules/subfile.ts';
import { text } from './rules/text.ts';
import { title, windowTitle } from './rules/title.ts';
import type { ScreenView } from './types.ts';

export type Rule = (ctx: TransformContext) => void;

export const DEFAULT_RULES: readonly Rule[] = [
  functionKeys, messageLine, title, subfile, menu, commandLine, fields, text,
];

/**
 * Rules for the screen behind an active window: shown dimmed, not interactive.
 * The window owns the F-keys and messages, so those rows are absorbed, not drawn.
 */
export const BACKGROUND_RULES: readonly Rule[] = [functionKeys, messageLine, title, text];

export function transform(snap: ScreenSnapshot, rules: readonly Rule[] = DEFAULT_RULES): ScreenView {
  const win = activeWindow(snap, findWindows(snap));
  if (!win) return run(new TransformContext(snap), rules);

  const { outer } = win;
  const inner = { top: outer.top + 1, left: outer.left + 1, bottom: outer.bottom - 1, right: outer.right - 1 };
  // Inside the window, a border title wins; otherwise only a highlighted first row is a title.
  const fgRules = rules.flatMap((r) => (r !== title ? [r] : win.title ? [] : [windowTitle]));
  const fg = run(new TransformContext(snap, inner), fgRules);

  const bg = new TransformContext(snap);
  for (let r = outer.top; r <= outer.bottom; r++) bg.claim(r, outer.left, outer.right - outer.left + 1);
  const view = run(bg, BACKGROUND_RULES);
  const winTitle = win.title ?? fg.title;
  view.window = {
    ...inner,
    ...(winTitle ? { title: winTitle } : {}),
    items: fg.items,
    functionKeys: fg.functionKeys,
    ...(fg.message ? { message: fg.message } : {}),
  };
  return view;
}

function run(ctx: TransformContext, rules: readonly Rule[]): ScreenView {
  for (const rule of rules) rule(ctx);
  ctx.view.items.sort((a, b) => a.row - b.row || a.col - b.col);
  return ctx.view;
}

export { TransformContext, type Region } from './context.ts';
export { findWindows, activeWindow, type WindowBox } from '@veneer/screens';
export type * from './types.ts';
