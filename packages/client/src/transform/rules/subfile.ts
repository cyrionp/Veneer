// Subfiles -> tables. A subfile is recognised by its "More..." / "Bottom"
// marker; the rows above it run up to highlighted column headings. An options
// legend ("2=Change  4=Delete") above the headings becomes a dropdown in the
// option column.

import type { FieldSnapshot } from '@veneer/terminal';
import { roleOf, type Chunk, type TransformContext } from '../context.ts';
import { legendTokens, rowLine } from '../text.ts';
import type { Option, TableCell, TableColumn, TableRow } from '../types.ts';

const MARKER = /^(More\.\.\.|More…|Bottom|\+)$/;
/** How far above the marker to look for column headings. */
const MAX_PAGE_ROWS = 22;

export function subfile(ctx: TransformContext): void {
  const { top, left, right } = ctx.region;
  for (const row of ctx.rows(top + 3)) {
    const marker = ctx.chunks(row).find((c) =>
      MARKER.test(c.text) && c.col > (left + right) / 2 && (c.text !== '+' || c.end >= right));
    if (marker) buildTable(ctx, row, marker);
  }
}

function isHeaderRow(ctx: TransformContext, row: number): boolean {
  if (row <= ctx.region.top || ctx.fieldsOn(row).length > 0) return false;
  const chunks = ctx.chunks(row);
  return chunks.length > 0 && chunks.every((c) => c.attr.color === 'white');
}

function buildTable(ctx: TransformContext, markerRow: number, marker: Chunk): void {
  const right = ctx.region.right;
  const markerAlone = ctx.chunks(markerRow).length === 1 && ctx.fieldsOn(markerRow).length === 0;
  const lastData = markerAlone ? markerRow - 1 : markerRow;

  let header = -1;
  for (let r = lastData; r >= Math.max(ctx.region.top + 1, lastData - MAX_PAGE_ROWS); r--) {
    if (isHeaderRow(ctx, r)) { header = r; break; }
  }
  if (header < 0 || header >= lastData) return;
  const top = isHeaderRow(ctx, header - 1) ? header - 1 : header;
  const dataRows = range(header + 1, lastData);

  // Column starts come from the bottom heading row.
  const headerChunks = ctx.chunks(header).filter((c) => c !== marker);
  const starts = headerChunks.map((c) => c.col);
  const headers = headerChunks.map((c) => c.text);
  if (top < header) {
    for (const c of ctx.chunks(top)) {
      const k = Math.max(0, starts.findLastIndex((s) => s <= c.col));
      headers[k] = `${c.text} ${headers[k] ?? ''}`.trim();
    }
  }

  const lines = new Map(dataRows.map((r) => [r, rowLine(ctx, r)]));
  const dataFields = dataRows.flatMap((r) => ctx.fieldsOn(r));
  const dataChunkCols = dataRows.flatMap((r) => ctx.chunks(r).filter((c) => c !== marker).map((c) => c.col));
  const firstCol = Math.min(starts[0] ?? right, ...dataFields.map((f) => f.col), ...dataChunkCols);

  // Move each boundary left past any value that straddles it (right-aligned numbers).
  const bounds = [firstCol, ...starts.slice(1)];
  for (let k = 1; k < bounds.length; k++) {
    let b = bounds[k]!;
    const straddles = (col: number) => [...lines.values()].some((l) => l[col - 2] !== ' ' && l[col - 1] !== ' ');
    while (b - 1 > bounds[k - 1]! && straddles(b)) b--;
    bounds[k] = b;
  }

  const options = optionsLegend(ctx, top);
  const optionCol = options.length > 0 ? optionColumn(bounds, dataFields) : -1;

  const columns: TableColumn[] = bounds.map((col, k) => ({
    col, width: (bounds[k + 1] ?? right + 1) - col, header: headers[k] ?? '',
  }));

  const tableRows: TableRow[] = [];
  for (const r of dataRows) {
    const line = lines.get(r)!;
    const rowFields = ctx.fieldsOn(r);
    const cells: TableCell[] = columns.map((c, k) => {
      const end = c.col + c.width;
      const field = rowFields.find((f) => f.col >= c.col && f.col < end);
      const chunk = ctx.chunks(r).find((x) => x !== marker && x.col < end && x.end > c.col);
      return {
        col: c.col, width: c.width,
        text: line.slice(c.col - 1, end - 1).trim(),
        role: chunk ? roleOf(chunk.attr) : 'normal',
        ...(field ? { field } : {}),
        ...(field && k === optionCol ? { options } : {}),
      };
    });
    if (cells.some((c) => c.text || c.field)) tableRows.push({ row: r, cells });
  }

  ctx.view.items.push({
    kind: 'table', row: top, col: firstCol, width: right - firstCol + 1,
    height: lastData - top + 1, headerRows: header - top + 1,
    columns, rows: tableRows, more: marker.text !== 'Bottom',
  });
  for (const r of range(top, lastData)) ctx.claimRow(r, firstCol);

  const width = marker.end - marker.col;
  if (marker.text === 'Bottom') {
    ctx.view.items.push({ kind: 'text', row: markerRow, col: marker.col, width, text: 'Bottom', role: 'muted', reverse: false, underline: false });
  } else {
    ctx.view.items.push({ kind: 'link', row: markerRow, col: marker.col, width, text: 'More', key: '', action: { aid: 'PageDown' } });
  }
  ctx.claim(markerRow, marker.col, width);
}

/** "2=Change  4=Delete  5=Display" rows above the table. */
function optionsLegend(ctx: TransformContext, top: number): Option[] {
  const options: Option[] = [];
  for (const r of ctx.rows(ctx.region.top + 1, top - 1)) {
    for (const t of legendTokens(rowLine(ctx, r), String.raw`\d{1,2}`)) {
      if (!options.some((o) => o.value === t.key)) options.push({ value: t.key, label: t.label });
    }
  }
  return options;
}

/** Index of the first column holding short input fields (the "Opt" column). */
function optionColumn(bounds: number[], fields: FieldSnapshot[]): number {
  for (let k = 0; k < bounds.length; k++) {
    const end = bounds[k + 1] ?? Infinity;
    if (fields.some((f) => f.col >= bounds[k]! && f.col < end && f.length <= 3)) return k;
  }
  return -1;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}
