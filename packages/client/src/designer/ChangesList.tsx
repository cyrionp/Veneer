// The designer's All changes section: every change in the customization, one
// line each. Clicking a line selects what it changes; × removes that change
// (Undo brings it back).

import type { ScreenDefinition, Target } from '@veneer/screens';
import type { ScreenSnapshot } from '@veneer/terminal';
import type { ScreenView } from '../transform/types.ts';
import { describeChange } from './changes.ts';
import { Section } from './Section.tsx';

export function ChangesList({ draft, setDraft, view, snap, onSelect }: {
  draft: ScreenDefinition;
  setDraft: (d: ScreenDefinition) => void;
  /** The screen as transformed, to name fields by their labels. */
  view: ScreenView;
  snap: ScreenSnapshot;
  onSelect: (at: Target) => void;
}) {
  const { changes } = draft;
  // Closed by default: the sections below show the same changes by kind.
  return (
    <Section title="All changes" count={changes.length} inUse={false}>
      {changes.length === 0 ? <p className="dp-hint">Nothing changed yet.</p> : (
        <ul className="dp-list dp-changes">
          {changes.map((change, i) => {
            const line = describeChange(change, view, snap);
            const at = line.at;
            return (
              <li key={i}>
                {at
                  ? <button type="button" className="dp-link dp-quote" title="Select this on the screen" onClick={() => onSelect(at)}>{line.label}</button>
                  : <span className="dp-quote">{line.label}</span>}
                <button
                  type="button" className="dp-x" aria-label={`Remove change: ${line.label}`}
                  onClick={() => setDraft({ ...draft, changes: changes.filter((_, j) => j !== i) })}
                >×</button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
