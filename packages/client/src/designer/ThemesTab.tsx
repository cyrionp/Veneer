// The designer's Themes tab: pick a theme to see the screen in it, start a new
// one from another, edit its style sheet (with the CSS variables to insert),
// add its artwork, save it, and use it for everyone. Built-in themes can be
// looked at and copied, not changed. Edits are a draft, with undo, until saved.

import { BUILTIN_THEMES, THEME_VARIABLES, type ActiveTheme } from '@veneer/screens';
import { useEffect, useRef, useState } from 'react';
import { applyTheme } from '../ui/themes.ts';
import { CodeBox } from './CodeBox.tsx';
import { record, redo, startHistory, undo, type History } from './history.ts';
import { copyName, cssUrl, logoUrl, sizeLabel, themeLabel, uploadName, validThemeName, type ThemeApi, type ThemeDetail, type ThemeList } from './themes.ts';
import { insertVariable } from '@veneer/screens';

interface Props {
  api: ThemeApi;
  /** The theme in use, which the page goes back to when the tab closes. */
  saved: ActiveTheme | null;
  canSave: boolean;
  setStatus: (status: { kind: 'ok' | 'error'; text: string } | null) => void;
  /** Tells the page the theme in use (or one it shows) changed. */
  onSaved: () => void;
  /** Reports unsaved edits, for the tab's dot. */
  onDirty: (dirty: boolean) => void;
}

export function ThemesTab({ api, saved, canSave, setStatus, onSaved, onDirty }: Props) {
  const [list, setList] = useState<ThemeList | null>(null);
  const [theme, setTheme] = useState<ThemeDetail | null>(null);
  const [history, setHistory] = useState<History<string>>(() => startHistory(''));
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [logoVersion, setLogoVersion] = useState('');
  const draft = history.present;
  const dirty = !!theme && draft !== theme.css;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const run = async <T,>(work: () => Promise<T>, done?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const out = await work();
      // Steps that say nothing (loading the list after a copy) keep the last message.
      if (done) setStatus({ kind: 'ok', text: done });
      return out;
    } catch (err) {
      setStatus({ kind: 'error', text: (err as Error).message });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const open = async (name: string) => {
    const detail = await run(() => api.get(name));
    if (!detail) return;
    setTheme(detail);
    setHistory(startHistory(detail.css));
    setNewName(copyName(name, list?.themes.map((t) => t.name) ?? []));
  };
  const refresh = async (select?: string) => {
    const next = await run(() => api.list());
    if (!next) return;
    setList(next);
    if (select) await open(select);
  };
  useEffect(() => { void refresh(saved?.name ?? 'default'); /* once */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The page shows the theme being edited; leaving the tab puts back the theme in use.
  const restore = useRef(saved);
  restore.current = saved;
  useEffect(() => {
    if (theme) applyTheme({ name: theme.name, css: draft, logo: logoUrl(theme.name, theme.files, logoVersion) });
  }, [theme, draft, logoVersion]);
  useEffect(() => () => applyTheme(restore.current), []);

  const leave = () => !dirty || window.confirm(`Discard the unsaved changes to “${theme?.name}”?`);
  const pick = (name: string) => { if (leave()) void open(name); };
  const builtin = theme?.builtin ?? true;
  const inUse = theme?.name === list?.active;
  const names = list?.themes.map((t) => t.name) ?? [];

  const create = async () => {
    if (!theme || !leave()) return;
    const made = await run(() => api.create(newName, theme.name), `Made “${newName}” from ${themeLabel(theme.name)}.`);
    if (made) await refresh(made.name);
  };
  const save = async () => {
    if (!theme) return;
    const next = await run(() => api.save(theme.name, draft), inUse ? 'Saved. Everyone sees it from their next screen.' : 'Saved.');
    if (!next) return;
    setTheme(next);
    setHistory((h) => ({ ...h, editedAt: 0 }));
    if (inUse) onSaved();
  };
  const rename = async () => {
    if (!theme || builtin || !leave()) return;
    const to = window.prompt('New name (letters, digits, - and _):', theme.name)?.trim();
    if (!to || to === theme.name) return;
    const next = await run(() => api.rename(theme.name, to), `Renamed to “${to}”.`);
    if (!next) return;
    await refresh(next.name);
    if (inUse) onSaved();
  };
  const remove = async () => {
    if (!theme || builtin || inUse || !window.confirm(`Delete the theme “${theme.name}” and its images?`)) return;
    const ok = await run(async () => { await api.remove(theme.name); return true; }, `Deleted “${theme.name}”.`);
    if (ok) await refresh(list?.active ?? 'default');
  };
  const use = async () => {
    if (!theme || dirty) return;
    const ok = await run(() => api.use(theme.name), `Everyone now sees “${themeLabel(theme.name)}”, from their next screen.`);
    if (!ok) return;
    setList((l) => (l ? { ...l, active: theme.name } : l));
    onSaved();
  };
  const upload = async (files: FileList | null) => {
    if (!theme || !files) return;
    for (const file of Array.from(files)) {
      const name = uploadName(file.name);
      if (!name) { setStatus({ kind: 'error', text: `“${file.name}” is not a PNG, SVG, JPEG, WebP or GIF image.` }); continue; }
      const out = await run(() => api.upload(theme.name, name, file, file.type), `Added ${name}. Use it in the CSS as ${cssUrl(name)}.`);
      if (!out) return;
      setTheme((t) => (t ? { ...t, files: out.files } : t));
      setLogoVersion(String(Date.now()));
    }
    if (inUse) onSaved();
  };
  const removeFile = async (file: string) => {
    if (!theme || !window.confirm(`Delete ${file} from “${theme.name}”?`)) return;
    const out = await run(() => api.removeFile(theme.name, file), `Deleted ${file}.`);
    if (!out) return;
    setTheme((t) => (t ? { ...t, files: out.files } : t));
    if (inUse) onSaved();
  };
  const edit = (css: string) => setHistory((h) => record(h, css, Date.now()));

  return (
    <div className="dp-themes">
      <section>
        <h3>Theme</h3>
        <p className="dp-hint">The look of every page, for everyone: a style sheet and artwork. Pick one to see the screen in it.</p>
        <select className="dp-pick" aria-label="Theme" value={theme?.name ?? ''} disabled={!list || busy} onChange={(e) => pick(e.target.value)}>
          <optgroup label="Built in">
            {list?.themes.filter((t) => t.builtin).map((t) => (
              <option key={t.name} value={t.name}>{themeLabel(t.name)}{t.name === list.active ? ' (in use)' : ''}</option>
            ))}
          </optgroup>
          {list && list.themes.some((t) => !t.builtin) && (
            <optgroup label="This site's">
              {list.themes.filter((t) => !t.builtin).map((t) => (
                <option key={t.name} value={t.name}>{t.name}{t.name === list.active ? ' (in use)' : ''}</option>
              ))}
            </optgroup>
          )}
        </select>
        {theme && (
          <div className="dp-actions">
            {inUse ? <span className="dp-tag">In use for everyone</span> : (
              <button type="button" className="primary" disabled={busy || dirty || !canSave} onClick={use}
                title={dirty ? 'Save your changes first' : 'Every user sees this theme from their next screen'}>Use for everyone</button>
            )}
            {!builtin && <button type="button" className="ghost" disabled={busy || !canSave} onClick={rename}>Rename</button>}
            {!builtin && !inUse && <button type="button" className="ghost danger" disabled={busy || !canSave} onClick={remove}>Delete</button>}
          </div>
        )}
      </section>

      <section>
        <h3>New theme</h3>
        <p className="dp-hint">A copy of {theme ? `“${themeLabel(theme.name)}”` : 'the theme above'}, style sheet and images, to make your own.</p>
        <div className="dp-url-row">
          <input value={newName} aria-label="New theme name" placeholder="acme" aria-invalid={newName !== '' && !validThemeName(newName)}
            onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="ghost" disabled={busy || !theme || !canSave || !validThemeName(newName) || names.includes(newName)} onClick={create}>Make a copy</button>
        </div>
        {newName !== '' && !validThemeName(newName) && (
          <p className="dp-warn">Use letters, digits, - and _ (not the name of a built-in theme: {BUILTIN_THEMES.join(', ')}).</p>
        )}
      </section>

      {theme && (
        <section>
          <h3>Style sheet</h3>
          {builtin
            ? <p className="dp-hint">Built-in themes can't be changed. Make a copy to start your own from this one.</p>
            : <p className="dp-hint">Loaded after Veneer's styles. The screen shows your changes as you type.</p>}
          <CodeBox className="dp-solo" rows={10} label={`Style sheet of ${themeLabel(theme.name)}`} value={draft}
            readOnly={builtin} onChange={(css) => { if (!builtin) edit(css); }} />
          {!builtin && (
            <div className="dp-actions">
              <button type="button" className="primary" disabled={busy || !dirty || !canSave} onClick={save}>Save theme</button>
              <button type="button" className="ghost" disabled={history.past.length === 0} onClick={() => setHistory(undo)}>Undo</button>
              <button type="button" className="ghost" disabled={history.future.length === 0} onClick={() => setHistory(redo)}>Redo</button>
              {dirty && <button type="button" className="ghost" disabled={busy} onClick={() => edit(theme.css)}>Revert</button>}
            </div>
          )}
          {!builtin && (
            <details className="dp-variables">
              <summary>CSS variables</summary>
              <p className="dp-hint">Most themes only set these. Insert adds one to the <code>:root</code> rule, with an example value to change.</p>
              <ul className="dp-list">
                {THEME_VARIABLES.map((v) => (
                  <li key={v.name}>
                    <code>{v.name}</code>
                    <span className="dp-quote" title={v.about}>{v.about}</span>
                    <button type="button" className="ghost" aria-label={`Insert ${v.name}`} onClick={() => edit(insertVariable(draft, v.name, v.example))}>Insert</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {theme && (
        <section>
          <h3>Artwork</h3>
          <p className="dp-hint">
            {builtin ? 'Built-in themes have no images.' : 'PNG, SVG, JPEG, WebP or GIF, up to 1 MB each. An image named logo (logo.svg, logo.png…) replaces the logo in the header and the tab icon.'}
          </p>
          {theme.files.length > 0 && (
            <ul className="dp-list">
              {theme.files.map((f) => (
                <li key={f.name}>
                  <img className="dp-thumb" src={`/themes/${encodeURIComponent(theme.name)}/${encodeURIComponent(f.name)}?v=${logoVersion}`} alt="" />
                  <code title="Use this in the style sheet">{cssUrl(f.name)}</code>
                  <span className="dp-quote">{sizeLabel(f.size)}</span>
                  {!builtin && <button type="button" className="dp-x" aria-label={`Delete ${f.name}`} disabled={busy || !canSave} onClick={() => removeFile(f.name)}>×</button>}
                </li>
              ))}
            </ul>
          )}
          {!builtin && (
            <label className="ghost dp-upload">
              Add images…
              <input type="file" multiple accept=".png,.svg,.jpg,.jpeg,.webp,.gif,image/png,image/svg+xml,image/jpeg,image/webp,image/gif"
                disabled={busy || !canSave} onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
            </label>
          )}
        </section>
      )}
    </div>
  );
}
