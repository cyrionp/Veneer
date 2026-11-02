// The admin page (/admin): who is connected, ending stuck sessions, recent
// warnings and errors, and server facts. Polls /api/admin/status.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useBrand } from '../ui/brand.ts';
import './admin.css';

interface ServerInfo {
  version: string;
  node: string;
  startedAt: string;
  uptimeSeconds: number;
  ibmi: { type?: '5250' | '3270'; host: string; port: number; tls: boolean };
  https: boolean;
  maxSessions: number;
  deviceNamePrefix: string | null;
}

interface SessionInfo {
  id: string;
  user: string | null;
  device: string | null;
  remote: string;
  connectedAt: string;
  lastActivity: string;
  hostConnected: boolean;
  attached: boolean;
  graceEndsAt: string | null;
}

interface Problem {
  time: string;
  level: 'warn' | 'error';
  msg: string;
  fields?: Record<string, unknown>;
}

interface Status {
  server: ServerInfo;
  sessions: SessionInfo[];
  problems: Problem[];
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ok'; status: Status; at: number }
  | { kind: 'token'; message?: string }
  | { kind: 'off'; message: string };

const TOKEN_KEY = 'veneer.adminToken';
const POLL_MS = 2000;

function loadToken(): string {
  try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function AdminPage() {
  const brand = useBrand();
  const [token, setToken] = useState(loadToken);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // Set when the server can't be reached; the last good status stays on screen.
  const [offline, setOffline] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const headers = useCallback((): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  const refresh = useCallback(async () => {
    let res: Response;
    try {
      res = await fetch('/api/admin/status', { headers: headers() });
    } catch {
      setOffline('Cannot reach the Veneer server.');
      return;
    }
    setOffline(null);
    if (res.status === 401) return setLoad({ kind: 'token', ...(token ? { message: 'That token was not accepted.' } : {}) });
    const body = (await res.json().catch(() => ({}))) as Partial<Status> & { error?: string };
    if (res.status === 403) return setLoad({ kind: 'off', message: body.error ?? 'The admin page is disabled.' });
    if (!res.ok) return setOffline(body.error ?? `HTTP ${res.status}`);
    setLoad({ kind: 'ok', status: body as Status, at: Date.now() });
  }, [headers, token]);

  // Poll while the tab is visible.
  const polling = load.kind === 'ok' || load.kind === 'loading';
  useEffect(() => {
    if (!polling) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [polling, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const signIn = (t: string) => {
    try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
    setToken(t);
    setLoad({ kind: 'loading' });
  };

  const endSession = async (s: SessionInfo) => {
    const who = [s.user, s.device].filter(Boolean).join(' on ') || `the session from ${s.remote}`;
    if (!window.confirm(`End ${who}?\n\nTheir browser is disconnected and the IBM i job ends. Unsaved work in it is lost.`)) return;
    const res = await fetch(`/api/admin/sessions/${encodeURIComponent(s.id)}/end`, { method: 'POST', headers: headers() }).catch(() => null);
    if (!res) setOffline('Cannot reach the Veneer server.');
    else if (!res.ok && res.status !== 404) window.alert(`Could not end the session (HTTP ${res.status}).`);
    void refresh();
  };

  const status = load.kind === 'ok' ? load.status : null;
  return (
    <div className="app admin">
      <header className="topbar">
        {brand ? <img className="brand" src={brand.logo} alt={brand.name} /> : <span className="brand" />}
        <div className="titles">
          <h1>{brand?.name} admin</h1>
          {status && (
            <div className="meta">
              Version {status.server.version} · up {duration(status.server.uptimeSeconds * 1000 + (now - (load.kind === 'ok' ? load.at : now)))}
            </div>
          )}
        </div>
        <div className="top-actions">
          {load.kind === 'ok' && (
            <span className={`status ${offline ? 'status-closed' : 'status-connected'}`}>{offline ? 'Offline' : 'Live'}</span>
          )}
          <a className="ghost-link" href="/">Open Veneer</a>
        </div>
      </header>

      <main className="admin-main">
        {offline && <div className="banner banner-error" role="alert">{offline} Retrying…</div>}
        {load.kind === 'loading' && !offline && <p className="admin-muted">Loading…</p>}
        {load.kind === 'off' && (
          <section className="admin-card admin-narrow">
            <h2>The admin page is turned off</h2>
            <p className="admin-muted">{load.message}</p>
          </section>
        )}
        {load.kind === 'token' && <TokenForm message={load.message} onSubmit={signIn} />}
        {status && (
          <>
            <Sessions sessions={status.sessions} max={status.server.maxSessions} now={now} onEnd={endSession} />
            <div className="admin-grid">
              <Problems problems={status.problems} now={now} />
              <Server info={status.server} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function TokenForm({ message, onSubmit }: { message: string | undefined; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <form className="admin-card admin-narrow" onSubmit={submit}>
      <h2>Admin token</h2>
      <p className="admin-muted">Enter the token set in <code>VENEER_ADMIN_TOKEN</code>. It is kept for this tab only.</p>
      {message && <p className="admin-error" role="alert">{message}</p>}
      <div className="admin-token">
        <input type="password" autoComplete="off" autoFocus aria-label="Admin token" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="admin-primary">Sign in</button>
      </div>
    </form>
  );
}

function Sessions({ sessions, max, now, onEnd }: { sessions: SessionInfo[]; max: number; now: number; onEnd: (s: SessionInfo) => void }) {
  const sorted = [...sessions].sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
  return (
    <section className="admin-card">
      <div className="admin-head">
        <h2>Active sessions</h2>
        <span className="admin-muted">{sessions.length} of {max}</span>
      </div>
      {sorted.length === 0 ? (
        <p className="admin-empty">No one is connected.</p>
      ) : (
        <div className="admin-scroll">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th><th>Device</th><th>Address</th><th>Connected</th><th>Last activity</th><th>Browser</th><th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.id}>
                  <td>{s.user ? <strong>{s.user}</strong> : <span className="admin-muted">Not signed on</span>}</td>
                  <td><code>{s.device ?? '—'}</code></td>
                  <td><code>{address(s.remote)}</code></td>
                  <td title={new Date(s.connectedAt).toLocaleString()}>{ago(s.connectedAt, now)}</td>
                  <td title={new Date(s.lastActivity).toLocaleString()}>{ago(s.lastActivity, now)}</td>
                  <td><SessionState s={s} now={now} /></td>
                  <td className="admin-actions">
                    <button type="button" className="admin-danger" onClick={() => onEnd(s)}>End</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SessionState({ s, now }: { s: SessionInfo; now: number }) {
  if (!s.hostConnected) return <span className="admin-pill pill-warn">Connecting</span>;
  if (s.attached) return <span className="admin-pill pill-ok">Attached</span>;
  const left = s.graceEndsAt ? Math.max(0, Math.ceil((Date.parse(s.graceEndsAt) - now) / 1000)) : 0;
  return <span className="admin-pill pill-wait" title="The browser went away; the session waits for it to reload.">Waiting · {left}s</span>;
}

function Problems({ problems, now }: { problems: Problem[]; now: number }) {
  return (
    <section className="admin-card">
      <div className="admin-head">
        <h2>Recent warnings and errors</h2>
        <span className="admin-muted">{problems.length > 0 ? `${problems.length} since start` : ''}</span>
      </div>
      {problems.length === 0 ? (
        <p className="admin-empty">None since the server started.</p>
      ) : (
        <ul className="admin-problems">
          {problems.map((p, i) => (
            <li key={`${p.time}-${i}`}>
              <span className={`admin-pill ${p.level === 'error' ? 'pill-error' : 'pill-warn'}`}>{p.level === 'error' ? 'Error' : 'Warning'}</span>
              <div className="admin-problem">
                <div>{p.msg}</div>
                {p.fields && Object.keys(p.fields).length > 0 && (
                  <code>{Object.entries(p.fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ')}</code>
                )}
              </div>
              <time dateTime={p.time} title={new Date(p.time).toLocaleString()}>{ago(p.time, now)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Server({ info }: { info: ServerInfo }) {
  const rows: Array<[string, string]> = [
    [hostName(info), `${info.ibmi.host}:${info.ibmi.port}`],
    [`${hostName(info)} connection`, info.ibmi.tls ? 'TLS' : 'Plain Telnet (unencrypted)'],
    ['Browser connection', info.https ? 'HTTPS' : 'HTTP'],
    ['Device names', info.deviceNamePrefix ? `${info.deviceNamePrefix}…` : 'Assigned by IBM i'],
    ['Session limit', String(info.maxSessions)],
    ['Started', new Date(info.startedAt).toLocaleString()],
    ['Veneer', info.version],
    ['Node.js', info.node],
  ];
  return (
    <section className="admin-card">
      <h2>Server</h2>
      <dl className="admin-facts">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </section>
  );
}

/** "::ffff:10.0.0.5" reads better as 10.0.0.5. */
/** What the host is called: an IBM i, or a 3270 mainframe. */
function hostName(info: ServerInfo): string {
  return info.ibmi.type === '3270' ? 'Mainframe (3270)' : 'IBM i';
}

function address(remote: string): string {
  return remote.replace(/^::ffff:/, '');
}

function ago(iso: string, now: number): string {
  return `${duration(now - Date.parse(iso))} ago`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
