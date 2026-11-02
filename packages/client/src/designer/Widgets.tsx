// The designer's field widgets: the "Show as" choices for an input field, and
// the settings of each widget (choices, date format, limits, text area lines).

import { DATE_FORMATS, type DateFormat, type ScreenDefinition, type Widget } from '@veneer/screens';
import type { FieldSnapshot, ScreenSnapshot } from '@veneer/tn5250';
import { useState } from 'react';
import { isNumeric } from '../ui/fieldRules.ts';
import { fieldsBelow, formatOptions, parseOptions, toggleTextAreaField, widgetOf } from './edit.ts';

/** Fields a spinner suits: numbers only. */
export const takesNumbers = (f: FieldSnapshot) => isNumeric(f) || f.shift === 'digitsOnly';

/** The "Show as" choices for a field, besides Component. */
export function showAsChoices(f: FieldSnapshot, current: Widget | undefined): Array<{ value: string; label: string }> {
  return [
    { value: 'text', label: 'Text box' },
    { value: 'select', label: 'Dropdown' },
    { value: 'radio', label: 'Radio buttons' },
    { value: 'checkbox', label: 'Checkbox' },
    { value: 'date', label: 'Date picker' },
    ...(takesNumbers(f) || current?.type === 'spinner' ? [{ value: 'spinner', label: 'Spinner' }] : []),
    { value: 'textarea', label: 'Text area' },
  ];
}

/** A new widget of a type, started from the field's value where that helps. */
export function defaultWidget(type: string, f: Pick<FieldSnapshot, 'id' | 'value'>): Widget | null {
  const choices = f.value ? [{ value: f.value, label: f.value }] : [];
  switch (type) {
    case 'select': return { type: 'select', options: choices };
    case 'radio': return { type: 'radio', options: choices, layout: 'row' };
    case 'checkbox': return { type: 'checkbox', on: 'Y', off: 'N' };
    case 'date': return { type: 'date', format: 'YYYYMMDD' };
    case 'spinner': return { type: 'spinner' };
    case 'textarea': return { type: 'textarea', fields: [f.id] };
    default: return null;
  }
}

/** A number box's value: blank for none. */
const numberOf = (text: string): number | undefined => {
  const n = Number(text);
  return text.trim() === '' || !Number.isFinite(n) ? undefined : n;
};

export function WidgetEditor({ widget, field, onChange, text }: {
  widget: Widget;
  field: FieldSnapshot;
  onChange: (w: Widget) => void;
  /** Text area settings, which edit the definition (and the screen) directly. */
  text: { draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; snap: ScreenSnapshot; joining: boolean; onJoining: (on: boolean) => void };
}) {
  // Keep the options text as typed; parse it on every change.
  const [optionsText, setOptionsText] = useState(widget.type === 'select' || widget.type === 'radio' ? formatOptions(widget.options) : '');
  const choices = (make: (options: ReturnType<typeof parseOptions>) => Widget) => (
    <label className="dp-row">Choices, one per line as value=Label
      <textarea
        rows={5}
        value={optionsText}
        onChange={(e) => {
          setOptionsText(e.target.value);
          onChange(make(parseOptions(e.target.value)));
        }}
      />
    </label>
  );
  switch (widget.type) {
    case 'select':
      return choices((options) => ({ type: 'select', options }));
    case 'radio':
      return (
        <>
          {choices((options) => ({ ...widget, options }))}
          <label className="dp-row">Layout
            <select value={widget.layout ?? 'row'} onChange={(e) => onChange({ ...widget, layout: e.target.value as 'row' | 'column' })}>
              <option value="row">Side by side</option>
              <option value="column">One under another</option>
            </select>
          </label>
          <label className="dp-check">
            <input type="checkbox" checked={widget.allowClear === true} onChange={(e) => {
              const { allowClear: _omit, ...rest } = widget;
              onChange(e.target.checked ? { ...rest, allowClear: true } : rest);
            }} /> Add a “None” choice, which clears the field
          </label>
          {widget.layout === 'column' && <p className="dp-hint">The choices take a row each: leave room below, or move what is there.</p>}
        </>
      );
    case 'checkbox':
      return (
        <div className="dp-pair">
          <label className="dp-row">Checked value<input value={widget.on} onChange={(e) => onChange({ ...widget, on: e.target.value })} /></label>
          <label className="dp-row">Unchecked value<input value={widget.off} onChange={(e) => onChange({ ...widget, off: e.target.value })} /></label>
        </div>
      );
    case 'date':
      return (
        <label className="dp-row">Host date format
          <select value={widget.format} onChange={(e) => onChange({ type: 'date', format: e.target.value as DateFormat })}>
            {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      );
    case 'spinner':
      return <SpinnerEditor widget={widget} field={field} onChange={onChange} />;
    case 'textarea':
      return <TextAreaEditor first={field} {...text} />;
  }
}

function SpinnerEditor({ widget, field, onChange }: {
  widget: Extract<Widget, { type: 'spinner' }>; field: FieldSnapshot; onChange: (w: Widget) => void;
}) {
  // As typed, so "-" or "1." can be on the way to a number.
  const [typed, setTyped] = useState({ min: String(widget.min ?? ''), max: String(widget.max ?? ''), step: String(widget.step ?? '') });
  const set = (key: 'min' | 'max' | 'step', text: string) => {
    setTyped((t) => ({ ...t, [key]: text }));
    const { [key]: _omit, ...rest } = widget;
    const n = numberOf(text);
    onChange(n === undefined || (key === 'step' && n <= 0) ? rest : { ...rest, [key]: n });
  };
  const box = (key: 'min' | 'max' | 'step', label: string, placeholder: string) => (
    <label className="dp-row">{label}<input inputMode="decimal" value={typed[key]} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} /></label>
  );
  const bad = widget.min !== undefined && widget.max !== undefined && widget.min > widget.max;
  return (
    <>
      <div className="dp-pair">
        {box('min', 'Lowest', 'none')}
        {box('max', 'Highest', 'none')}
      </div>
      {box('step', 'Step', '1')}
      {bad && <p className="dp-warn">The lowest value is more than the highest.</p>}
      {field.shift === 'signedNumeric' && (
        <p className="dp-hint">This field's decimals are implied: count in the units typed (1250 for 12.50, so a step of 100 is one whole).</p>
      )}
    </>
  );
}

function TextAreaEditor({ first, draft, setDraft, snap, joining, onJoining }: {
  first: FieldSnapshot; draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; snap: ScreenSnapshot;
  joining: boolean; onJoining: (on: boolean) => void;
}) {
  const widget = widgetOf(draft, first.id);
  if (widget?.type !== 'textarea') return null;
  const below = fieldsBelow(draft, snap, first.id);
  const fieldOf = (id: string) => snap.fields.find((f) => f.id === id);
  const room = widget.fields.reduce((n, id) => n + (fieldOf(id)?.length ?? 0), 0);
  return (
    <>
      <p className="dp-hint">The fields are edited as one box, a line each, in this order. Text wraps from one line to the next.</p>
      <ul className="dp-list" aria-label="Text area lines">
        {widget.fields.map((id, i) => (
          <li key={id}>
            <span>Line {i + 1}</span>
            <code>{id}</code>
            <span className="dp-quote">{fieldOf(id)?.length ?? '?'} characters{fieldOf(id) ? '' : ', not on this screen'}</span>
            {i > 0 && (
              <button type="button" className="dp-x" aria-label={`Take out ${id}`} onClick={() => setDraft(toggleTextAreaField(draft, first.id, id))}>×</button>
            )}
          </li>
        ))}
      </ul>
      <p className="dp-hint">Room for {room} characters.</p>
      <div className="dp-actions">
        <button type="button" className="ghost" disabled={below.length === 0}
          title="The input fields in the same column, of the same length, on the rows below"
          onClick={() => setDraft(below.reduce((d, id) => toggleTextAreaField(d, first.id, id), draft))}>
          Add the fields below{below.length > 0 ? ` (${below.length})` : ''}
        </button>
        <button type="button" className={joining ? 'primary' : 'ghost'} aria-pressed={joining} onClick={() => onJoining(!joining)}>
          {joining ? 'Done picking' : 'Pick fields on the screen'}
        </button>
      </div>
      {joining && <p className="dp-hint" role="status">Click fields on the screen to add them, or click a line again to take it out.</p>}
    </>
  );
}

/** For a field that is a line of a text area, other than its first. */
export function TextAreaPart({ first, field, draft, setDraft, onSelect }: {
  first: string; field: string; draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; onSelect: (id: string) => void;
}) {
  return (
    <>
      <p className="dp-hint">A line of the text area at <code>{first}</code>, drawn as part of that box.</p>
      <div className="dp-actions">
        <button type="button" className="ghost" onClick={() => onSelect(first)}>Select the text area</button>
        <button type="button" className="ghost" onClick={() => setDraft(toggleTextAreaField(draft, first, field))}>Take it out</button>
      </div>
    </>
  );
}
