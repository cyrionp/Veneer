// The designer's theme editing, without the UI: the /api/themes calls, and
// small rules the Themes tab uses (names for uploads and copies, the logo).

import {
  BUILTIN_LABELS, THEME_FILE, THEME_NAME, isBuiltinTheme, themeBase, themeLogo, type ThemeSummary,
} from '@veneer/screens';

/** A theme with its style sheet, as GET /api/themes/<name> gives it. */
export interface ThemeDetail extends ThemeSummary {
  css: string;
}

export interface ThemeList {
  active: string;
  themes: ThemeSummary[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The theme API, with the designer token's headers on every call. Failures throw the server's reason. */
export function themeApi(headers: () => Record<string, string>, fetchImpl: Fetch = (u, i) => fetch(u, i)) {
  const call = async <T>(method: string, url: string, body?: unknown, type?: string): Promise<T> => {
    const raw = body instanceof Blob || body instanceof ArrayBuffer;
    const res = await fetchImpl(url, {
      method,
      headers: {
        ...headers(),
        ...(body === undefined ? {} : { 'Content-Type': raw ? type || 'application/octet-stream' : 'application/json' }),
      },
      ...(body === undefined ? {} : { body: raw ? (body as BodyInit) : JSON.stringify(body) }),
    });
    if (!res.ok) {
      const reason = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      throw new Error(res.status === 401 ? 'Enter a valid designer token.' : reason ?? `HTTP ${res.status}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
  const at = (name: string) => `/api/themes/${encodeURIComponent(name)}`;
  return {
    list: () => call<ThemeList>('GET', '/api/themes'),
    get: (name: string) => call<ThemeDetail>('GET', at(name)),
    create: (name: string, from: string) => call<ThemeDetail>('POST', '/api/themes', { name, from }),
    save: (name: string, css: string) => call<ThemeDetail>('PUT', at(name), { css }),
    rename: (from: string, to: string) => call<ThemeDetail>('POST', `${at(from)}/rename`, { to }),
    remove: (name: string) => call<void>('DELETE', at(name)),
    upload: (name: string, file: string, data: Blob | ArrayBuffer, type?: string) =>
      call<{ files: ThemeSummary['files'] }>('PUT', `${at(name)}/files/${encodeURIComponent(file)}`, data, type),
    removeFile: (name: string, file: string) => call<{ files: ThemeSummary['files'] }>('DELETE', `${at(name)}/files/${encodeURIComponent(file)}`),
    use: (name: string) => call<{ active: string }>('PUT', '/api/theme', { name }),
  };
}

export type ThemeApi = ReturnType<typeof themeApi>;

/** How a theme is named in the list: the built-in ones by their label. */
export const themeLabel = (name: string) => (isBuiltinTheme(name) ? BUILTIN_LABELS[name] : name);

/**
 * A name an uploaded file can be kept under: "Company Logo (2).PNG" becomes
 * "Company-Logo-2.png". Undefined when it isn't an image a theme can hold.
 */
export function uploadName(file: string): string | undefined {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = file.slice(dot + 1).toLowerCase();
  const stem = file.slice(0, dot).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 60) || 'image';
  const name = `${stem}.${ext}`;
  return THEME_FILE.test(name) ? name : undefined;
}

/** A free name for a copy of `from`: "acme-copy", "acme-copy-2", … */
export function copyName(from: string, taken: readonly string[]): string {
  const base = `${from}-copy`.slice(0, 34);
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

export const validThemeName = (name: string) => THEME_NAME.test(name) && !isBuiltinTheme(name);

/** The URL of a theme's logo for the preview, or null when it has none. */
export function logoUrl(name: string, files: ThemeSummary['files'], version = ''): string | null {
  const logo = themeLogo(files.map((f) => f.name));
  return logo ? `${themeBase(name)}${encodeURIComponent(logo)}${version ? `?v=${version}` : ''}` : null;
}

/** What to write in the theme's CSS to use an image. */
export const cssUrl = (file: string) => `url(${file})`;

/** Bytes as "12 KB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
