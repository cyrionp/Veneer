// "F3=Exit   F5=Refresh   F12=Cancel" rows near the bottom -> a button bar.

import type { AidName } from '@veneer/terminal';
import type { TransformContext } from '../context.ts';
import { legendTokens, rowLine } from '../text.ts';

const KEY = String.raw`F(?:2[0-4]|1\d|[1-9])|Enter|Help|Print|Page ?Up|Page ?Down|Roll ?Up|Roll ?Down|PgUp|PgDn`;

export function aidForKey(key: string): AidName | undefined {
  const k = key.replace(/\s/g, '').toLowerCase();
  if (/^f\d+$/.test(k)) return `F${Number(k.slice(1))}` as AidName;
  switch (k) {
    case 'enter': return 'Enter';
    case 'help': return 'Help';
    case 'print': return 'Print';
    case 'pageup': case 'rolldown': case 'pgup': return 'PageUp';
    case 'pagedown': case 'rollup': case 'pgdn': return 'PageDown';
  }
  return undefined;
}

export function functionKeys(ctx: TransformContext): void {
  const { top, bottom } = ctx.region;
  const seen = new Set<string>();
  for (const row of ctx.rows(Math.max(top + 2, bottom - 4))) {
    if (ctx.fieldsOn(row).length > 0) continue;
    const tokens = legendTokens(rowLine(ctx, row), KEY);
    if (tokens.length === 0) continue;
    for (const t of tokens) {
      const aid = aidForKey(t.key);
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);
      ctx.view.functionKeys.push({ aid, label: t.label });
    }
    ctx.claimRow(row);
  }
}
