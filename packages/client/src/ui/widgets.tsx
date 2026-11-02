// The radio button, spinner and text area widgets (see fieldInput.tsx for the
// others). Each draws one or more 5250 fields differently; the host sees the
// same fields and values as on a terminal.

import type { Widget } from '@veneer/screens';
import type { FieldSnapshot } from '@veneer/tn5250';
import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { FieldBinding } from './fieldInput.tsx';
import { filterValue, isNumeric, withSign } from './fieldRules.ts';
import { stepValue } from './spinner.ts';
import { fitText, roomLeft, textOf } from './textArea.ts';

interface Common {
  field: FieldSnapshot;
  binding: FieldBinding;
  style?: CSSProperties | undefined;
  className: string;
  label?: string | undefined;
  readOnly: boolean;
  dataAt?: string | undefined;
}

export function RadioField({ field, binding, style, label, readOnly, dataAt, widget }: Common & { widget: Extract<Widget, { type: 'radio' }> }) {
  const value = binding.value(field).trim();
  const choices = widget.allowClear ? [...widget.options, { value: '', label: 'None' }] : widget.options;
  // A value no choice matches shows none chosen, and stays as it is until one is picked.
  const chosen = choices.some((o) => o.value === value) ? value : undefined;
  // Tab stops on the chosen button, or the first when none is: as a native group does.
  const stop = chosen ?? choices[0]?.value;
  return (
    <span className={`radio-field ${widget.layout === 'column' ? 'column' : 'row'}`} style={style} role="radiogroup" aria-label={label} data-at={dataAt}>
      {choices.map((o) => (
        <label key={o.value} className="radio-choice">
          <input
            type="radio"
            name={`field-${field.id}`}
            value={o.value}
            checked={o.value === chosen}
            disabled={readOnly}
            tabIndex={o.value === stop ? 0 : -1}
            {...(o.value === stop ? { 'data-field': field.id } : { 'data-field-of': field.id })}
            onChange={() => binding.onChange(field, o.value)}
          />
          {o.label}
        </label>
      ))}
    </span>
  );
}

export function SpinnerField({ field, binding, style, className, label, readOnly, dataAt, widget }: Common & { widget: Extract<Widget, { type: 'spinner' }> }) {
  const value = binding.value(field);
  const step = (up: boolean) => {
    if (readOnly) return;
    const next = stepValue(value, field, widget, up);
    if (next !== null) binding.onChange(field, next);
  };
  return (
    <span className="spinner-field" style={style} data-at={dataAt}>
      <input
        className={`${className} numeric`}
        data-field={field.id}
        aria-label={label}
        role="spinbutton"
        aria-valuemin={widget.min}
        aria-valuemax={widget.max}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        maxLength={field.length}
        readOnly={readOnly}
        value={value}
        onChange={(e) => binding.onChange(field, filterValue(field, e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            step(e.key === 'ArrowUp');
          } else if (isNumeric(field) && (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract')) {
            e.preventDefault();
            binding.onChange(field, withSign(value, e.code === 'NumpadSubtract'));
          }
        }}
      />
      <span className="spinner-buttons">
        <button type="button" tabIndex={-1} aria-label="Up" disabled={readOnly} onClick={() => step(true)}>▴</button>
        <button type="button" tabIndex={-1} aria-label="Down" disabled={readOnly} onClick={() => step(false)}>▾</button>
      </span>
    </span>
  );
}

export function TextAreaField({ binding, style, className, label, readOnly, dataAt, parts }: Common & { parts: FieldSnapshot[] }) {
  const values = parts.map((f) => binding.value(f));
  const text = textOf(values);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once the fitted text is drawn.
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caret.current !== null && document.activeElement === el) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  const room = roomLeft(values, parts);
  const first = parts[0]!;
  return (
    <span className={`textarea-field${readOnly ? ' designing' : ''}`} style={style} data-at={dataAt}>
      <textarea
        ref={ref}
        className={`${className} textarea`}
        data-field={first.id}
        data-fields={parts.map((f) => f.id).join(' ')}
        aria-label={label}
        aria-description={`${parts.length} lines, ${room} characters left`}
        rows={readOnly ? 1 : parts.length}
        style={{ '--lines': parts.length } as CSSProperties}
        wrap="off"
        spellCheck={false}
        autoComplete="off"
        readOnly={readOnly}
        value={text}
        onChange={(e) => {
          const el = e.target;
          const fitted = fitText(el.value, el.selectionStart, parts);
          if (!fitted) {
            // No room: refuse the edit, leaving the caret where it was.
            const back = Math.max(0, el.selectionStart - (el.value.length - text.length));
            queueMicrotask(() => el.setSelectionRange(back, back));
            el.classList.remove('full');
            void el.offsetWidth;
            el.classList.add('full');
            return;
          }
          caret.current = fitted.caret;
          parts.forEach((f, i) => {
            if (fitted.values[i] !== binding.value(f)) binding.onChange(f, fitted.values[i]!);
          });
          // The text fitted as typed: React leaves the box alone, so put the caret back now.
          if (textOf(fitted.values) === el.value) caret.current = null;
        }}
      />
      {!readOnly && <span className={`textarea-room${room === 0 ? ' none' : ''}`} aria-hidden>{room} left</span>}
    </span>
  );
}
