// The designer's custom components: the Page tab's list (and Add component),
// and the editor for a selected one. Designers choose installed components and
// set their options; they cannot add or change component code.

import type { ComponentOptions, ScreenDefinition, Target } from '@veneer/screens';
import type { ScreenSnapshot } from '@veneer/terminal';
import { useEffect, useState } from 'react';
import { componentAt, componentsOf, freeSpot, setComponent } from './edit.ts';
import { CodeBox } from './CodeBox.tsx';
import { Section } from './Section.tsx';

type Component = NonNullable<ReturnType<typeof componentAt>>;

const NONE_HINT = 'No components are installed. Developers add them as name.js files in the server\'s components folder (VENEER_COMPONENTS_DIR).';

export function ComponentsSection({ draft, setDraft, snap, installed, onSelect }: {
  draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; snap: ScreenSnapshot; installed: string[];
  onSelect: (at: Target) => void;
}) {
  const placed = componentsOf(draft);
  const [pick, setPick] = useState('');
  const name = installed.includes(pick) ? pick : installed[0];
  return (
    <Section title="Components" count={placed.length}>
      {placed.length > 0 && (
        <ul className="dp-list">
          {placed.map((c) => (
            <li key={`${c.at.row}:${c.at.col}`}>
              <code>{c.at.row},{c.at.col}</code>
              <button type="button" className="dp-link dp-quote" onClick={() => onSelect(c.at)} title="Edit this component">
                {c.name}{c.field ? ` (field ${c.field})` : ''}
              </button>
              <button type="button" className="dp-x" aria-label={`Remove component ${c.name}`} onClick={() => setDraft(setComponent(draft, c.at, null))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {installed.length === 0 ? <p className="dp-hint">{NONE_HINT}</p> : (
        <div className="dp-button">
          <select aria-label="Component to add" value={name} onChange={(e) => setPick(e.target.value)}>
            {installed.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const at = freeSpot(snap, draft, 4);
              setDraft(setComponent(draft, at, { name: name!, at, width: Math.min(40, snap.cols - 1), height: 4 }));
              onSelect(at);
            }}
          >
            Add component
          </button>
        </div>
      )}
      <p className="dp-hint">To draw an input field with a component, select the field and choose Show as: Component.</p>
    </Section>
  );
}

/** A new component in place of an input field, the field's size to start with. */
export function componentForFieldChange(name: string, field: { id: string; row: number; col: number; length: number }): Omit<Component, 'op'> {
  return { name, at: { row: field.row, col: field.col }, width: Math.max(field.length, 2), height: 1, field: field.id };
}

/** Options as the designer edits them: JSON text, saved only when it is a valid object. */
function parseOptions(text: string): { options?: ComponentOptions; error?: string } {
  if (text.trim() === '') return { options: {} };
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'Options must be a JSON object, like { "column": "CPU %" }' };
    return { options: v as ComponentOptions };
  } catch (err) {
    return { error: `Not valid JSON: ${(err as Error).message}` };
  }
}

export function ComponentEditor({ draft, setDraft, component, installed, cols, onSelect }: {
  draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; component: Component; installed: string[]; cols: number;
  onSelect: (at: Target) => void;
}) {
  const update = (next: Partial<Component>) => {
    const { op: _op, ...current } = component;
    const merged = { ...current, ...next };
    if (merged.options && Object.keys(merged.options).length === 0) delete merged.options;
    setDraft(setComponent(draft, component.at, merged));
    if (next.at) onSelect(next.at);
  };
  const saved = JSON.stringify(component.options ?? {}, null, 2);
  const [text, setText] = useState(saved === '{}' ? '' : saved);
  // Keep the text when it is what is saved (or being typed); replace it when the change came from elsewhere.
  useEffect(() => {
    const parsed = parseOptions(text);
    if (parsed.options && JSON.stringify(parsed.options) !== JSON.stringify(component.options ?? {})) setText(saved === '{}' ? '' : saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const error = parseOptions(text).error;
  const names = installed.includes(component.name) ? installed : [component.name, ...installed];
  const num = (value: string, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(Number(value)) || min));
  return (
    <>
      <p className="dp-desc">
        Component at <code>{component.at.row},{component.at.col}</code>
        {component.field ? <>, in place of field <code>{component.field}</code></> : null}
      </p>
      <label className="dp-row">Component
        <select value={component.name} onChange={(e) => update({ name: e.target.value })}>
          {names.map((n) => <option key={n} value={n}>{installed.includes(n) ? n : `${n} (not installed)`}</option>)}
        </select>
      </label>
      <label className="dp-row">Options (JSON)
        <CodeBox
          rows={5}
          label="Component options (JSON)"
          value={text}
          aria-invalid={error ? true : undefined}
          placeholder={'{ "column": "CPU %" }'}
          onChange={(code) => {
            setText(code);
            const parsed = parseOptions(code);
            if (parsed.options) update({ options: parsed.options });
          }}
        />
      </label>
      {error && <p className="dp-warn" role="status">{error}</p>}
      <div className="dp-pair">
        <label className="dp-row">Row<input type="number" min={1} max={27} value={component.at.row}
          onChange={(e) => update({ at: { ...component.at, row: num(e.target.value, 1, 27) } })} /></label>
        <label className="dp-row">Column<input type="number" min={1} max={cols} value={component.at.col}
          onChange={(e) => update({ at: { ...component.at, col: num(e.target.value, 1, cols) } })} /></label>
      </div>
      <div className="dp-pair">
        <label className="dp-row">Width (columns)<input type="number" min={1} max={cols} value={component.width}
          onChange={(e) => update({ width: num(e.target.value, 1, cols) })} /></label>
        <label className="dp-row">Height (rows)<input type="number" min={1} max={27} value={component.height}
          onChange={(e) => update({ height: num(e.target.value, 1, 27) })} /></label>
      </div>
      <p className="dp-hint">Drag the component to move it, or its corner to resize it.</p>
      <button type="button" className="ghost danger" onClick={() => setDraft(setComponent(draft, component.at, null))}>Remove component</button>
    </>
  );
}
