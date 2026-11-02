// The designer side panel: edits a draft screen definition that the screen
// previews live, and saves it through /api/screens.

import {
  ID_PATTERN, ROLES, fillUrl, fingerprint, matches, type ButtonAction, type Role, type ScreenDefinition, type ScreenEvent,
  type ActiveTheme, type SiteCustomization, type SiteEvent,
  type Target,
} from '@veneer/screens';
import type { AidName, ScreenSnapshot } from '@veneer/tn5250';
import { useEffect, useMemo, useRef, useState } from 'react';
import { runScript } from '../custom/runtime.ts';
import { ThemesTab } from './ThemesTab.tsx';
import { themeApi } from './themes.ts';
import { InventoryDialog } from './InventoryDialog.tsx';
import { StyleRules } from './StyleRules.tsx';
import { CardsAndTabs } from './CardsAndTabs.tsx';
import { CodeBox } from './CodeBox.tsx';
import { ChangesList } from './ChangesList.tsx';
import { labelAt } from './names.ts';
import { Section, SectionContext, SectionGroup, useSectionState } from './Section.tsx';
import { ComponentEditor, ComponentsSection, componentForFieldChange } from './Components.tsx';
import { TextAreaPart, WidgetEditor, defaultWidget, showAsChoices } from './Widgets.tsx';
import type { ScreenView } from '../transform/types.ts';
import {
  addScreenId, buttonsOf, cardAround, cardsOf, componentAt, componentForField, formatOptions, freeSpot, htmlAt, htmlOf, isHidden, originalText, parseOptions, removeScreenId, roleOf, setButtons,
  ROLE_LABELS, moveOf, setCard, setComponent, setCss, setHidden, setHtml, setMove, setScript, setRole, setText, setWidget, textAreaOf, textOf, widgetOf, type Selection,
} from './edit.ts';

const TOKEN_KEY = 'veneer.designerToken';
/** The button-action choice for opening a web page instead of pressing a key. */
const URL_ACTION = 'url';

/** Switch a button between pressing a key and opening a URL, keeping what still applies. */
function actionFor(current: ButtonAction, choice: string): ButtonAction {
  if (choice === URL_ACTION) return 'url' in current ? current : { url: 'https://' };
  return 'url' in current ? { aid: choice as AidName } : { ...current, aid: choice as AidName };
}

/** The URL template of a link button, with a preview filled from the current screen. */
function UrlEditor({ url, snap, at, onChange }: { url: string; snap: ScreenSnapshot; at: Target | undefined; onChange: (url: string) => void }) {
  const preview = fillUrl(url, snap);
  return (
    <div className="dp-url">
      <div className="dp-url-row">
        <input value={url} aria-label="URL" spellCheck={false} placeholder="https://example.com/orders?id={6:22}" onChange={(e) => onChange(e.target.value)} />
        <button
          type="button" className="ghost" disabled={!at} onClick={() => at && onChange(`${url}{${at.row}:${at.col}}`)}
          title="Add the selected field or text to the URL"
        >Insert selected</button>
      </div>
      <p className="dp-preview">
        {preview
          ? <>Opens <a href={preview} target="_blank" rel="noopener noreferrer">{preview}</a> (with fields as the host sent them; what users type is used when they click)</>
          : 'Needs http:// or https:// and a host name. {row:col} adds the field or text there; {row:col:length} a fixed width.'}
      </p>
    </div>
  );
}

const AIDS: AidName[] = [
  'Enter', 'PageUp', 'PageDown', 'Help', 'Print',
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}` as AidName),
];

interface Props {
  snap: ScreenSnapshot;
  view: ScreenView;
  draft: ScreenDefinition;
  setDraft: (def: ScreenDefinition) => void;
  /** Undo history of the draft (Page and Selected tabs; not the site). */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Showing the screen as users see it (no ghosts or outlines). */
  previewing: boolean;
  onPreview: (on: boolean) => void;
  /** The saved version of this definition, if it exists on the server. */
  saved: ScreenDefinition | undefined;
  /** True while editing a definition that already existed when design mode began. */
  existing: boolean;
  selection: Selection | null;
  /** All saved definitions, to pick one to edit or extend. */
  definitions: ScreenDefinition[];
  /** Edit a saved definition, or start a new one for this screen (null). */
  onPick: (def: ScreenDefinition | null) => void;
  /** False when the server lets this browser save without the token. */
  tokenRequired: boolean;
  /** Custom components installed on the server. */
  components: string[];
  /** Site-wide CSS and JavaScript as saved. */
  site: SiteCustomization;
  /** Select a screen position (after moving custom HTML). */
  onSelect: (at: Target) => void;
  /** The last position clicked on the screen; a new click shows the Selected tab. */
  clickedAt: Target | null;
  onSaved: () => void;
  onClose: () => void;
  /** The theme in use for everyone. */
  theme: ActiveTheme | null;
  /** The text area whose fields a click on the screen adds or takes out (its first field), if any. */
  joining: string | null;
  onJoining: (first: string | null) => void;
}

type Tab = 'site' | 'themes' | 'page' | 'selected';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'site', label: 'Site-wide' },
  { id: 'themes', label: 'Themes' },
  { id: 'page', label: 'Page' },
  { id: 'selected', label: 'Selected' },
];

/** A curved arrow back (undo) or, mirrored, forward (redo). */
function UndoIcon({ redo = false }: { redo?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={redo ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M5.5 3 2 6.5 5.5 10M2.5 6.5h7a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "3 lines" for code that has some, for a closed section's header. */
function lineCount(code: string | undefined): string | undefined {
  const n = code?.trim() ? code.trim().split('\n').length : 0;
  return n === 0 ? undefined : n === 1 ? '1 line' : `${n} lines`;
}

function loadToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function DesignPanel(props: Props) {
  const { snap, draft, setDraft, saved, existing, selection, tokenRequired } = props;
  const [token, setToken] = useState(loadToken);
  const canSave = !tokenRequired || token !== '';
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const matched = matches(snap, draft);
  const print = useMemo(() => fingerprint(snap), [snap]);
  const screenIds = draft.match.screenIds ?? [];
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  useEffect(() => { setStatus(null); }, [draft]);

  const storeToken = (t: string) => {
    setToken(t);
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
  };

  async function request(method: 'PUT' | 'DELETE', url = `/api/screens/${encodeURIComponent(draft.id)}`, payload: unknown = draft): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(tokenRequired ? { Authorization: `Bearer ${token}` } : {}),
          ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'PUT' ? { body: JSON.stringify(payload) } : {}),
      });
      if (res.ok) return true;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus({ kind: 'error', text: res.status === 401 ? 'Enter a valid designer token.' : body.error ?? `HTTP ${res.status}` });
      return false;
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const save = async () => {
    if (await request('PUT')) {
      setStatus({ kind: 'ok', text: 'Saved.' });
      props.onSaved();
    }
  };
  const remove = async () => {
    if (!window.confirm(`Delete the customization "${draft.name}"?`)) return;
    if (await request('DELETE')) {
      props.onSaved();
      props.onClose();
    }
  };

  // Site-wide code is edited and saved separately from the screen.
  const [siteDraft, setSiteDraft] = useState(props.site);
  useEffect(() => { setSiteDraft(props.site); }, [props.site]);
  const siteDirty = JSON.stringify(siteDraft) !== JSON.stringify(props.site);

  // Themes are saved through their own API, with the same token.
  const themes = useMemo(() => themeApi((): Record<string, string> => (tokenRequired ? { Authorization: `Bearer ${token}` } : {})), [tokenRequired, token]);
  const [themesDirty, setThemesDirty] = useState(false);
  const saveSite = async () => {
    if (await request('PUT', '/api/site', siteDraft)) {
      const loadChanged = siteDraft.scripts.load !== props.site.scripts.load;
      setStatus({ kind: 'ok', text: loadChanged ? 'Site saved. Reload the page to run the new page-load script.' : 'Site saved.' });
      props.onSaved();
    }
  };

  // The event whose script each tab is showing.
  const [siteEvent, setSiteEvent] = useState<SiteEvent>('load');
  const [pageEvent, setPageEvent] = useState<ScreenEvent>('load');
  const pageScript = draft.scripts?.[pageEvent] ?? '';
  const siteScript = siteDraft.scripts[siteEvent];

  // "Test script" runs a draft script once on the screen; the next test or closing the panel undoes it.
  const testCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => testCleanup.current?.(), []);
  const testScript = (code: string, label: string) => {
    testCleanup.current?.();
    const el = document.querySelector<HTMLElement>('form.sheet');
    if (!el || !code) return;
    const result = runScript(code, `${label} (test)`, el);
    testCleanup.current = result.cleanup;
    setStatus(result.error ? { kind: 'error', text: `Script error: ${result.error}` } : { kind: 'ok', text: 'Script ran. Scripts run by themselves when you leave design mode.' });
  };

  const [inventory, setInventory] = useState(false);

  // Clicking something on the screen shows it in the Selected tab.
  const [tab, setTab] = useState<Tab>('page');
  useEffect(() => { if (props.clickedAt) setTab('selected'); }, [props.clickedAt]);

  // Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) undo and redo page changes. In a text
  // box they are left to the browser, which undoes the typing there.
  // The Site-wide and Themes tabs have their own undo (the code boxes', the theme's buttons).
  const ownUndo = tab === 'site' || tab === 'themes';
  const undoKeys = useRef({ onUndo: props.onUndo, onRedo: props.onRedo, site: ownUndo });
  undoKeys.current = { onUndo: props.onUndo, onRedo: props.onRedo, site: ownUndo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const redoKey = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey);
      if (!redoKey && !(key === 'z' && !e.shiftKey)) return;
      const k = undoKeys.current;
      if (k.site || (e.target as HTMLElement).closest?.('input, textarea, [contenteditable]') || document.querySelector('.overlay')) return;
      e.preventDefault();
      if (redoKey) k.onRedo(); else k.onUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Open and closed Page sections; picking another customization or screen starts over.
  const sections = useSectionState(`${saved?.id ?? ''}|${print.id}`);

  const buttons = buttonsOf(draft);
  const setButton = (i: number, button: { label: string; action: ButtonAction }) =>
    setDraft(setButtons(draft, buttons.map((x, j) => (j === i ? button : x))));
  const idValid = ID_PATTERN.test(draft.id);

  return (
    <aside className="design-panel" aria-label="Screen designer">
      <header className="dp-head">
        <h2>Design</h2>
        <div className="dp-head-actions">
          {!ownUndo && (
            <>
              <button type="button" className="ghost dp-undo" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!props.canUndo} onClick={props.onUndo}><UndoIcon /></button>
              <button type="button" className="ghost dp-undo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!props.canRedo} onClick={props.onRedo}><UndoIcon redo /></button>
            </>
          )}
          <button
            type="button" className={`ghost dp-preview-toggle${props.previewing ? ' on' : ''}`} aria-pressed={props.previewing}
            title="See the screen as users do: hidden items gone, no outlines. The screen is look-only meanwhile."
            onClick={() => props.onPreview(!props.previewing)}
          >Preview</button>
          <button type="button" className="ghost" onClick={() => setInventory(true)} title="Every screen Veneer has shown">Screens</button>
          <button type="button" className="ghost" onClick={props.onClose}>Done</button>
        </div>
      </header>

      <div className="dp-tabs" role="tablist" aria-label="Designer sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`dp-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="dp-tabpanel"
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {(t.id === 'site' ? siteDirty : t.id === 'themes' ? themesDirty : t.id === 'page' && dirty) && <span className="dp-dot" title="Unsaved changes" />}
          </button>
        ))}
      </div>

      <div className="dp-body" id="dp-tabpanel" role="tabpanel" aria-labelledby={`dp-tab-${tab}`}>
        {tab === 'themes' && (
          <ThemesTab api={themes} saved={props.theme} canSave={canSave} setStatus={setStatus} onSaved={props.onSaved} onDirty={setThemesDirty} />
        )}
        {tab === 'site' && (
          <>
          <p className="dp-hint">The site's colors, logo and fonts are its theme (Themes tab).</p>
          <section>
            <h3>Site-wide CSS</h3>
            <p className="dp-hint">On every page, for every screen. Saved as global.css.</p>
            <CodeBox className="dp-solo" rows={5} label="Site-wide CSS" value={siteDraft.css}
              onChange={(css) => setSiteDraft({ ...siteDraft, css })} />
          </section>
          <section>
            <h3>Site-wide JavaScript</h3>
            <EventScript
              events={SITE_EVENT_LABELS}
              event={siteEvent}
              onEvent={setSiteEvent}
              has={(e) => siteDraft.scripts[e] !== ''}
              code={siteScript}
              placeholder={siteEvent === 'load'
                ? "// Once, when the page loads (global.js)\nveneer.on('screen', (screen, element) => { … });"
                : '// After every screen is drawn (global-screen.js)\n// screen.id, screen.fields, element; return a function to clean up'}
              onChange={(code) => setSiteDraft({ ...siteDraft, scripts: { ...siteDraft.scripts, [siteEvent]: code } })}
              onTest={() => testScript(siteScript, `the site ${siteEvent} script`)}
            />
          </section>
          </>
        )}
        {tab === 'page' && (
          <SectionContext.Provider value={sections}>
          <SectionGroup title="Page" />
          <Section title="Customization" inUse>
            <select
              className="dp-pick"
              aria-label="Customization to edit"
              value={existing ? draft.id : ''}
              onChange={(e) => props.onPick(props.definitions.find((d) => d.id === e.target.value) ?? null)}
            >
              <option value="">New customization for this screen</option>
              {[...props.definitions].sort((a, b) => a.name.localeCompare(b.name)).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            <label className="dp-row">Name
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="dp-row">File id
              <input
                value={draft.id}
                disabled={existing}
                aria-invalid={!idValid}
                onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })}
              />
            </label>
            <label className="dp-row">Page title
              <input
                value={draft.title ?? ''}
                placeholder={props.view.title ?? ''}
                onChange={(e) => {
                  const { title: _omit, ...rest } = draft;
                  setDraft(e.target.value ? { ...rest, title: e.target.value } : rest);
                }}
              />
            </label>
          </Section>

          <Section title="Recognised by" note={matched ? 'matches' : 'does not match'} inUse={!matched}>
            {screenIds.length > 0 && (
              <ul className="dp-list">
                {screenIds.map((sid) => (
                  <li key={sid}>
                    Screen ID <code>{sid}</code>
                    {sid === print.id && <span className="dp-tag">this screen</span>}
                    <span className="dp-quote" />
                    <button type="button" className="dp-x" aria-label="Remove screen ID" onClick={() => setDraft(removeScreenId(draft, sid))}>×</button>
                  </li>
                ))}
              </ul>
            )}
            {!screenIds.includes(print.id) && (
              <button type="button" className="ghost" onClick={() => setDraft(addScreenId(draft, print.id))}>
                Add this screen (ID <code>{print.id}</code>)
              </button>
            )}
            {print.fields === 0 && (
              <p className="dp-hint">This screen has no input fields, so its ID comes from the title alone. Add a text rule if other screens share the title.</p>
            )}
            {draft.match.text.length > 0 && <p className="dp-hint">{screenIds.length > 0 ? 'and this text:' : 'Text:'}</p>}
            <ul className="dp-list">
              {draft.match.text.map((m, i) => (
                <li key={`${m.row}:${m.col}:${i}`}>
                  <code>{m.row},{m.col}</code> <span className="dp-quote">“{m.text}”</span>
                  <button
                    type="button"
                    className="dp-x"
                    aria-label="Remove match rule"
                    onClick={() => setDraft({ ...draft, match: { ...draft.match, text: draft.match.text.filter((_, j) => j !== i) } })}
                  >×</button>
                </li>
              ))}
            </ul>
            <p className={matched ? 'dp-ok' : 'dp-warn'}>
              {matched ? '✓ Matches this screen'
                : screenIds.length === 0 && draft.match.text.length === 0 ? 'Add a screen ID or a text rule.'
                : '✗ Does not match this screen'}
            </p>
          </Section>

          <ChangesList draft={draft} setDraft={setDraft} view={props.view} snap={snap} onSelect={props.onSelect} />

          <Section title="Buttons" count={buttons.length}>
            {buttons.map((b, i) => (
              <div className="dp-button" key={i}>
                <input
                  value={b.label}
                  aria-label="Button label"
                  onChange={(e) => setButton(i, { ...b, label: e.target.value })}
                />
                <select
                  value={'url' in b.action ? URL_ACTION : b.action.aid}
                  aria-label="What the button does"
                  onChange={(e) => setButton(i, { ...b, action: actionFor(b.action, e.target.value) })}
                >
                  {AIDS.map((a) => <option key={a} value={a}>{a}</option>)}
                  <option value={URL_ACTION}>Open URL</option>
                </select>
                <button type="button" className="dp-x" aria-label="Remove button" onClick={() => setDraft(setButtons(draft, buttons.filter((_, j) => j !== i)))}>×</button>
                {'url' in b.action && (
                  <UrlEditor
                    url={b.action.url} snap={snap} at={selection?.at}
                    onChange={(url) => setButton(i, { ...b, action: { url } })}
                  />
                )}
              </div>
            ))}
            <button type="button" className="ghost" onClick={() => setDraft(setButtons(draft, [...buttons, { label: 'New button', action: { aid: 'Enter' } }]))}>
              Add button
            </button>
          </Section>

          <SectionGroup title="Layout and behavior" />
          <StyleRules draft={draft} setDraft={setDraft} view={props.view} selected={selection?.at} />
          <CardsAndTabs draft={draft} setDraft={setDraft} view={props.view} selection={selection} />
          <ComponentsSection draft={draft} setDraft={setDraft} snap={snap} installed={props.components} onSelect={props.onSelect} />

          <Section title="HTML" count={htmlOf(draft).length}>
            {htmlOf(draft).length > 0 && (
              <ul className="dp-list">
                {htmlOf(draft).map((h) => (
                  <li key={`${h.at.row}:${h.at.col}`}>
                    <code>{h.at.row},{h.at.col}</code>
                    <button type="button" className="dp-link dp-quote" onClick={() => props.onSelect(h.at)} title="Edit this HTML">
                      {h.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || '(no text)'}
                    </button>
                    <button type="button" className="dp-x" aria-label="Remove HTML" onClick={() => setDraft(setHtml(draft, h.at, null))}>×</button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="ghost"
              onClick={() => {
                const at = freeSpot(snap, draft, 2);
                setDraft(setHtml(draft, at, { at, html: '<div>New content</div>', width: Math.min(40, snap.cols - 1), height: 2 }));
                props.onSelect(at);
              }}
            >
              Add HTML
            </button>
            <p className="dp-hint">Or click an empty spot on the screen to add HTML there.</p>
          </Section>

          <SectionGroup title="Code" />
          <Section title="Page CSS" note={lineCount(draft.css)}>
            <p className="dp-hint">While this screen is shown.</p>
            <CodeBox className="dp-solo" rows={5} label="Page CSS" value={draft.css ?? ''}
              placeholder={`[data-screen="${draft.id}"] .text { … }`}
              onChange={(css) => setDraft(setCss(draft, css))} />
          </Section>
          <Section title="Page JavaScript" count={(Object.keys(PAGE_EVENT_LABELS) as ScreenEvent[]).filter((e) => draft.scripts?.[e]).length}>
            <EventScript
              events={PAGE_EVENT_LABELS}
              event={pageEvent}
              onEvent={setPageEvent}
              has={(e) => Boolean(draft.scripts?.[e])}
              code={pageScript}
              placeholder={pageEvent === 'load'
                ? "// When this screen opens (not when it pages or redraws)\nveneer.setField('6:53', 'Y');\n// return a function to run when the screen closes"
                : '// Every time this screen is drawn, paging and errors too\n// screen.fields, element; return a function to run before the next redraw'}
              onChange={(code) => setDraft(setScript(draft, pageEvent, code))}
              onTest={() => testScript(pageScript, `the ${pageEvent} script of "${draft.name}"`)}
            />
          </Section>
          </SectionContext.Provider>
        )}
        {tab === 'selected' && (
          <>
          <section>
            <h3>Selected</h3>
            {selection && selection.kind !== 'empty' && <p className="dp-hint">Changes here are part of this page's customization.</p>}
            {selection ? <SelectionEditor draft={draft} setDraft={setDraft} selection={selection} name={labelAt(props.view, snap, selection.at, { shown: true })} cols={snap.cols} onSelect={props.onSelect} components={props.components}
              snap={snap} joining={selection.kind === 'field' && props.joining === selection.field.id} onJoining={(on) => props.onJoining(on && selection.kind === 'field' ? selection.field.id : null)} /> : (
              <p className="dp-hint">Click any text, field or table on the screen, or an empty spot to add HTML.</p>
            )}
            {selection && selection.kind !== 'empty' && selection.item && !(selection.kind === 'item' && selection.header) && (() => {
              const card = cardAround(selection.item);
              return cardsOf(draft).some((c) => c.from.row === card.from.row && c.from.col === card.from.col) ? null : (
                <button type="button" className="ghost" onClick={() => setDraft(setCard(draft, card.from, card))}>
                  Add card around this
                </button>
              );
            })()}
            {selection?.kind === 'item' && selection.item.kind !== 'table' && selection.item.kind !== 'html' && (() => {
              const m = originalText(snap, selection.item);
              return m && !draft.match.text.some((x) => x.row === m.row && x.col === m.col) ? (
                <button type="button" className="ghost" onClick={() => setDraft({ ...draft, match: { ...draft.match, text: [...draft.match.text, m] } })}>
                  Also require “{m.text}”
                </button>
              ) : null;
            })()}
          </section>

          </>
        )}
      </div>

      <footer className="dp-foot">
        {tokenRequired && (
          <>
            {!token && <p className="dp-hint">Saving needs the designer token (VENEER_DESIGNER_TOKEN).</p>}
            <label className="dp-row">Designer token
              <input type="password" value={token} autoComplete="off" onChange={(e) => storeToken(e.target.value)} />
            </label>
          </>
        )}
        {status && <p className={status.kind === 'ok' ? 'dp-ok' : 'dp-warn'} role="status">{status.text}</p>}
        {tab === 'themes' ? null : tab === 'site' ? (
          <div className="dp-actions">
            <button type="button" className="primary" disabled={busy || !siteDirty || !canSave} onClick={saveSite}>Save site</button>
            {siteDirty && <button type="button" className="ghost" disabled={busy} onClick={() => setSiteDraft(props.site)}>Revert</button>}
          </div>
        ) : (
            <div className="dp-actions">
              <button type="button" className="primary" disabled={busy || !dirty || !idValid || (screenIds.length === 0 && draft.match.text.length === 0) || !canSave} onClick={save}>
                {saved ? 'Save changes' : 'Save'}
              </button>
              {saved && <button type="button" className="ghost" disabled={busy || !dirty} onClick={() => setDraft(saved)}>Revert</button>}
              {saved && <button type="button" className="ghost danger" disabled={busy || !canSave} onClick={remove}>Delete</button>}
            </div>
        )}
      </footer>
      {inventory && (
        <InventoryDialog
          auth={tokenRequired ? `Bearer ${token}` : undefined}
          definitions={props.definitions}
          currentId={print.id}
          onClose={() => setInventory(false)}
        />
      )}
    </aside>
  );
}

function SelectionEditor({ draft, setDraft, selection, name, cols, onSelect, components, snap, joining, onJoining }: {
  draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; selection: Selection; cols: number; onSelect: (at: Target) => void;
  snap: ScreenSnapshot;
  /** Clicks on fields add them to (or take them out of) the selected text area. */
  joining: boolean;
  onJoining: (on: boolean) => void;
  /** What people would call the selection, such as a field's label (names.ts). */
  name: string | undefined;
  components: string[];
}) {
  const at = selection.at;
  if (selection.kind === 'empty') {
    return (
      <>
        <p className="dp-desc">Empty space at <code>{at.row},{at.col}</code></p>
        <button
          type="button"
          className="ghost"
          onClick={() => setDraft(setHtml(draft, at, { at, html: '<div>New content</div>', width: Math.min(20, cols - at.col + 1), height: 2 }))}
        >
          Add HTML here
        </button>
      </>
    );
  }
  if (selection.kind === 'item' && selection.item.kind === 'component') {
    const component = componentAt(draft, at);
    return component
      ? <ComponentEditor key={`${at.row}:${at.col}`} draft={draft} setDraft={setDraft} component={component} installed={components} cols={cols} onSelect={onSelect} />
      : null;
  }
  if (selection.kind === 'item' && selection.item.kind === 'html') {
    const html = htmlAt(draft, at);
    return html ? <HtmlEditor key={`${at.row}:${at.col}`} draft={draft} setDraft={setDraft} html={html} cols={cols} onSelect={onSelect} /> : null;
  }
  const hidden = isHidden(draft, at);
  const hideToggle = (
    <label className="dp-check">
      <input type="checkbox" checked={hidden} onChange={(e) => setDraft(setHidden(draft, at, e.target.checked))} /> Hide
    </label>
  );

  if (selection.kind === 'field') {
    const f = selection.field;
    const widget = widgetOf(draft, f.id);
    const component = componentForField(draft, f.id);
    const area = textAreaOf(draft, f.id);
    const showAs = (value: string) => {
      let next = component ? setComponent(draft, component.at, null) : draft;
      if (value === 'component') next = setComponent(setWidget(next, f.id, null), f, componentForFieldChange(components[0]!, f));
      else next = setWidget(next, f.id, defaultWidget(value, f));
      setDraft(next);
      onJoining(false);
      if (value === 'component') onSelect({ row: f.row, col: f.col });
    };
    const fieldAt = (id: string) => {
      const [row, col] = id.split(':').map(Number) as [number, number];
      return { row, col };
    };
    return (
      <>
        <p className="dp-desc">
          {name ? <><strong>{name}</strong>, input field</> : 'Input field'}, {f.length} character{f.length === 1 ? '' : 's'}
          {f.value ? ` (now “${f.value}”)` : ''} <code>{f.id}</code>
        </p>
        {hideToggle}
        {!selection.item && <p className="dp-hint">Part of a table: drag the table to move it.</p>}
        {selection.item && !(area && area.first !== f.id) && <PositionEditor draft={draft} setDraft={setDraft} at={at} cols={cols} />}
        {area && area.first !== f.id ? (
          <TextAreaPart first={area.first} field={f.id} draft={draft} setDraft={setDraft} onSelect={(id) => onSelect(fieldAt(id))} />
        ) : (
          <>
            <label className="dp-row">Show as
              <select value={component ? 'component' : widget?.type ?? 'text'} onChange={(e) => showAs(e.target.value)}>
                {showAsChoices(f, widget).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                {(components.length > 0 || component) && <option value="component">Component</option>}
              </select>
            </label>
            {widget && (
              <WidgetEditor key={`${f.id}:${widget.type}`} widget={widget} field={f} onChange={(w) => setDraft(setWidget(draft, f.id, w))}
                text={{ draft, setDraft, snap, joining, onJoining }} />
            )}
          </>
        )}
      </>
    );
  }

  const item = selection.item;
  const kind = selection.header ? 'page header text' : item.kind === 'text' ? 'text' : item.kind === 'link' ? 'menu option' : item.kind === 'table' ? 'list' : 'field';
  const original = item.kind === 'text' || item.kind === 'link' ? item.text : '';
  return (
    <>
      <p className="dp-desc">
        {/* A list's name already says it is a list. */}
        {name ? <><strong>{name}</strong>{item.kind === 'table' ? '' : `, ${kind}`}</> : kind[0]!.toUpperCase() + kind.slice(1)} <code>{at.row},{at.col}</code>
      </p>
      {hideToggle}
      {!selection.header && <PositionEditor draft={draft} setDraft={setDraft} at={at} cols={cols} />}
      {(item.kind === 'text' || item.kind === 'link') && (
        <label className="dp-row">Text
          <input
            value={textOf(draft, at) ?? ''}
            placeholder={original}
            onChange={(e) => setDraft(setText(draft, at, e.target.value === '' ? null : e.target.value))}
          />
        </label>
      )}
      {item.kind === 'text' && (
        <label className="dp-row">Style
          <select value={roleOf(draft, at) ?? ''} onChange={(e) => setDraft(setRole(draft, at, (e.target.value || null) as Role | null))}>
            <option value="">As on the host</option>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

/** Where an item is drawn; drag it on the screen or use the arrow keys too. */
function PositionEditor({ draft, setDraft, at, cols }: {
  draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; at: Target; cols: number;
}) {
  const to = moveOf(draft, at) ?? at;
  const num = (value: string, max: number) => Math.min(max, Math.max(1, Math.trunc(Number(value)) || 1));
  return (
    <>
      <div className="dp-pair">
        <label className="dp-row">Row<input type="number" min={1} max={27} value={to.row}
          onChange={(e) => setDraft(setMove(draft, at, { ...to, row: num(e.target.value, 27) }))} /></label>
        <label className="dp-row">Column<input type="number" min={1} max={cols} value={to.col}
          onChange={(e) => setDraft(setMove(draft, at, { ...to, col: num(e.target.value, cols) }))} /></label>
      </div>
      {moveOf(draft, at) ? (
        <button type="button" className="ghost" onClick={() => setDraft(setMove(draft, at, null))}>
          Put back at {at.row},{at.col}
        </button>
      ) : (
        <p className="dp-hint">Drag it on the screen, or use the arrow keys, to move it.</p>
      )}
    </>
  );
}

const SITE_EVENT_LABELS: Record<SiteEvent, string> = { load: 'Page load', screen: 'Every screen' };
const PAGE_EVENT_LABELS: Record<ScreenEvent, string> = { load: 'Screen opens', show: 'Every redraw' };

/** An event picker over one script box; events with a script are marked. */
function EventScript<E extends string>({ events, event, onEvent, has, code, placeholder, onChange, onTest }: {
  events: Record<E, string>; event: E; onEvent: (e: E) => void; has: (e: E) => boolean;
  code: string; placeholder: string; onChange: (code: string) => void; onTest: () => void;
}) {
  return (
    <>
      <label className="dp-row">Event
        <select value={event} onChange={(e) => onEvent(e.target.value as E)}>
          {(Object.keys(events) as E[]).map((e) => (
            <option key={e} value={e}>{has(e) ? '● ' : ''}{events[e]}</option>
          ))}
        </select>
      </label>
      <CodeBox className="dp-solo" rows={7} label={`JavaScript: ${events[event]}`}
        value={code} placeholder={placeholder} onChange={onChange} />
      <div className="dp-actions">
        <button type="button" className="ghost" disabled={!code} onClick={onTest}>Test script</button>
      </div>
    </>
  );
}

function HtmlEditor({ draft, setDraft, html, cols, onSelect }: {
  draft: ScreenDefinition; setDraft: (d: ScreenDefinition) => void; html: NonNullable<ReturnType<typeof htmlAt>>; cols: number;
  onSelect: (at: Target) => void;
}) {
  const update = (next: Partial<typeof html>) => {
    const { op: _op, ...current } = html;
    const merged = { ...current, ...next };
    if (!merged.css) delete merged.css;
    if (!merged.script) delete merged.script;
    setDraft(setHtml(draft, html.at, merged));
    if (next.at) onSelect(next.at);
  };

  // "Test script" runs this box's draft script once; the next test or closing the editor undoes it.
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const testCleanup = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => testCleanup.current?.(), []);
  const testScript = () => {
    testCleanup.current?.();
    const box = document.querySelector<HTMLElement>(`[data-html="${html.at.row}:${html.at.col}"]`);
    if (!box || !html.script) return;
    const run = runScript(html.script, `the script of HTML at ${html.at.row},${html.at.col} (test)`, box);
    testCleanup.current = run.cleanup;
    setResult(run.error ? { kind: 'error', text: `Script error: ${run.error}` } : { kind: 'ok', text: 'Script ran.' });
  };
  const num = (value: string, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(Number(value)) || min));
  return (
    <>
      <p className="dp-desc">Custom HTML at <code>{html.at.row},{html.at.col}</code></p>
      <label className="dp-row">HTML
        <CodeBox rows={6} label="HTML" value={html.html} onChange={(code) => update({ html: code })} />
      </label>
      <label className="dp-row">CSS, for this box only
        <CodeBox rows={5} label="CSS for this HTML box" value={html.css ?? ''}
          placeholder={'background: #fff3c4;\nbutton { font-weight: 600; }'}
          onChange={(code) => update({ css: code })} />
      </label>
      <label className="dp-row">JavaScript, each time the screen is shown
        <CodeBox rows={5} label="JavaScript for this HTML box" value={html.script ?? ''}
          placeholder={"// Call from the HTML: onclick=\"doMessage()\"\nfunction doMessage() {\n  veneer.press('F4');\n}\n// element = this box"}
          onChange={(code) => { setResult(null); update({ script: code }); }} />
      </label>
      <div className="dp-actions">
        <button type="button" className="ghost" disabled={!html.script} onClick={testScript}>Test script</button>
      </div>
      {result && <p className={result.kind === 'ok' ? 'dp-ok' : 'dp-warn'} role="status">{result.text}</p>}
      <div className="dp-pair">
        <label className="dp-row">Row<input type="number" min={1} max={27} value={html.at.row}
          onChange={(e) => update({ at: { ...html.at, row: num(e.target.value, 1, 27) } })} /></label>
        <label className="dp-row">Column<input type="number" min={1} max={cols} value={html.at.col}
          onChange={(e) => update({ at: { ...html.at, col: num(e.target.value, 1, cols) } })} /></label>
      </div>
      <div className="dp-pair">
        <label className="dp-row">Width (columns)<input type="number" min={1} max={cols} value={html.width}
          onChange={(e) => update({ width: num(e.target.value, 1, cols) })} /></label>
        <label className="dp-row">Height (rows)<input type="number" min={1} max={27} value={html.height}
          onChange={(e) => update({ height: num(e.target.value, 1, 27) })} /></label>
      </div>
      <button type="button" className="ghost danger" onClick={() => setDraft(setHtml(draft, html.at, null))}>Remove HTML</button>
    </>
  );
}
