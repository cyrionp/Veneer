// The untransformed 5250 screen, for comparison and as a fallback.

import type { ScreenSnapshot } from '@veneer/terminal';
import type { CSSProperties } from 'react';
import { FieldInput, type FieldBinding } from './fieldInput.tsx';

export function ClassicScreen({ snap, binding }: { snap: ScreenSnapshot; binding: FieldBinding }) {
  return (
    <div className="classic" style={{ '--cols': snap.cols, height: `calc(${snap.rows} * var(--rh))` } as CSSProperties}>
      {snap.segments.map((segs, r) => (
        <div key={r} className="classic-row">
          {segs.map((s) => (
            <span
              key={s.col}
              className={`c-${s.attr.color}${s.attr.reverse ? ' reverse' : ''}${s.attr.underline ? ' underline' : ''}`}
            >
              {s.attr.nonDisplay ? ' '.repeat(s.text.length) : s.text}
            </span>
          ))}
        </div>
      ))}
      {snap.fields.filter((f) => !f.bypass).map((f) => (
        <FieldInput
          key={f.id}
          field={f}
          binding={binding}
          className={`classic-field c-${f.attr.color}`}
          style={{
            top: `calc(${f.row - 1} * var(--rh))`,
            left: `calc(${f.col - 1} * 1ch)`,
            width: `calc(${Math.min(f.length, snap.cols - f.col + 1)} * 1ch)`,
          }}
        />
      ))}
    </div>
  );
}
