// " 1. User tasks" menu lines -> links that type the number and press Enter.

import type { FieldSnapshot } from '@veneer/terminal';
import type { Chunk, TransformContext } from '../context.ts';

const ITEM = /^(\d{1,2})\.\s+(\S.*)$/;

export function menu(ctx: TransformContext): void {
  const items: Array<{ chunk: Chunk; key: string; label: string }> = [];
  for (const row of ctx.rows(ctx.region.top + 1)) {
    for (const chunk of ctx.chunks(row)) {
      const m = ITEM.exec(chunk.text);
      if (m) items.push({ chunk, key: m[1]!, label: m[2]! });
    }
  }
  if (items.length < 2) return;
  const lastRow = Math.max(...items.map((i) => i.chunk.row));
  const selection = selectionField(ctx, lastRow);
  if (!selection) return;
  for (const { chunk, key, label } of items) {
    ctx.view.items.push({
      kind: 'link', row: chunk.row, col: chunk.col, width: chunk.end - chunk.col,
      text: label, key, action: { aid: 'Enter', fields: { [selection.id]: key } },
    });
    ctx.claim(chunk.row, chunk.col, chunk.end - chunk.col);
  }
}

/** The command/selection field: after "===>", else the first input below the menu. */
function selectionField(ctx: TransformContext, below: number): FieldSnapshot | undefined {
  for (const row of ctx.rows(below)) {
    const arrow = ctx.chunks(row).find((c) => c.text.endsWith('===>'));
    if (arrow) {
      const f = ctx.fieldsOn(row).find((x) => x.col >= arrow.end);
      if (f) return f;
    }
  }
  return ctx.inputs.find((f) => f.row > below && !ctx.isFieldClaimed(f));
}
