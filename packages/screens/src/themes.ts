// Themes: a style sheet plus artwork, kept in the screens folder
// (themes/<name>/theme.css and images) and made in the designer. One theme is
// in use for the whole site. These rules are shared by the server, which
// stores and serves themes, and the client, which shows them.

/** Theme names are folder names in URLs: letters, digits, "-" and "_". */
export const THEME_NAME = /^[A-Za-z0-9_-]{1,40}$/;

/** Themes that come with Veneer. They can be copied, not changed. */
export const BUILTIN_THEMES = ['default', 'compact', 'flat', 'green', 'soft', 'high-contrast'] as const;
export type BuiltinTheme = (typeof BUILTIN_THEMES)[number];

export const BUILTIN_LABELS: Record<BuiltinTheme, string> = {
  default: 'Default',
  compact: 'Compact',
  flat: 'Flat',
  green: 'Green screen',
  soft: 'Soft',
  'high-contrast': 'High contrast',
};

/** The theme used until a site picks one. */
export const DEFAULT_THEME: BuiltinTheme = 'default';

export const isBuiltinTheme = (name: string): name is BuiltinTheme => (BUILTIN_THEMES as readonly string[]).includes(name);

/** A theme's style sheet: at most this many characters. */
export const MAX_THEME_CSS = 128 * 1024;
/** Each image in a theme: at most this many bytes. */
export const MAX_THEME_FILE = 1024 * 1024;
/** Images in one theme. */
export const MAX_THEME_FILES = 50;

/** Image types a theme can hold, by file extension. */
export const THEME_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** An image's file name: starts with a letter or digit, no folders, a known extension. */
export const THEME_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}\.(png|svg|jpe?g|webp|gif)$/i;

/** The image type of a theme file name, or undefined if it is not one a theme can hold. */
export function themeImageType(file: string): string | undefined {
  if (!THEME_FILE.test(file)) return undefined;
  return THEME_IMAGE_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()];
}

/** The theme's logo: its image named logo.<type>, which replaces the header logo and tab icon. */
export function themeLogo(files: readonly string[]): string | undefined {
  return files.filter((f) => /^logo\./i.test(f) && themeImageType(f)).sort()[0];
}

/** Where a theme's files are served. */
export const themeBase = (name: string) => `/themes/${encodeURIComponent(name)}/`;

/** A theme as the designer lists it. */
export interface ThemeSummary {
  name: string;
  builtin: boolean;
  /** Its images, by file name. */
  files: Array<{ name: string; size: number }>;
}

/** The theme in use, as every page gets it with the screen definitions. */
export interface ActiveTheme {
  name: string;
  builtin: boolean;
  css: string;
  /** URL of the theme's logo, or null to keep the default (or VENEER_BRAND_LOGO). */
  logo: string | null;
}

/**
 * Point the style sheet's relative URLs (images, fonts, @import) at the
 * theme's folder, so the CSS works when it is put in the page as text. URLs
 * with a scheme, absolute paths, fragments and data: URLs are left alone.
 */
export function rebaseCss(css: string, base: string): string {
  const fix = (url: string) => (isRelative(url) ? base + url.replace(/^\.\//, '') : url);
  return css
    .replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (_m, q: string, url: string) => `url(${q}${fix(url)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, q: string, url: string) => `@import ${q}${fix(url)}${q}`);
}

function isRelative(url: string): boolean {
  return url !== '' && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(url);
}

/** A CSS variable a theme can set, for the designer's list and the README. */
export interface ThemeVariable {
  name: string;
  about: string;
  example: string;
}

export const THEME_VARIABLES: ThemeVariable[] = [
  { name: '--brand-accent', about: 'Accent color: buttons, links, focus and highlights', example: '#c8102e' },
  { name: '--brand-accent-dark', about: 'Accent color in dark mode (default: a lighter --brand-accent)', example: '#ff6b81' },
  { name: '--bg', about: 'Page background', example: '#f4f5f7' },
  { name: '--surface', about: 'The screen and panels', example: '#ffffff' },
  { name: '--surface-2', about: 'Raised and hovered areas, list stripes', example: '#f8f9fb' },
  { name: '--border', about: 'Borders and dividers', example: '#e2e5ea' },
  { name: '--text', about: 'Text', example: '#1d232b' },
  { name: '--text-strong', about: 'Headings and emphasis', example: '#0b1017' },
  { name: '--text-muted', about: 'Labels and secondary text', example: '#5c6673' },
  { name: '--header-bg', about: 'Page header background', example: '#0b3d91' },
  { name: '--header-text', about: 'Page header text', example: '#ffffff' },
  { name: '--header-muted', about: 'Page header secondary text', example: '#c9d6ee' },
  { name: '--header-border', about: 'Line under the page header', example: 'transparent' },
  { name: '--accent-2', about: 'Second accent (designer highlights, accent2 role)', example: '#a1349b' },
  { name: '--danger', about: 'Errors and the danger role', example: '#c62828' },
  { name: '--warning', about: 'Warnings and the warning role', example: '#a15c00' },
  { name: '--radius-small', about: 'Corners of buttons and fields', example: '6px' },
  { name: '--radius', about: 'Corners of panels and menus', example: '8px' },
  { name: '--radius-large', about: 'Corners of the screen', example: '12px' },
  { name: '--shadow', about: 'Shadow under the screen and dialogs', example: 'none' },
  { name: '--rh', about: 'Height of a screen row (spacing)', example: '1.9em' },
  { name: '--cw', about: 'Width of a screen column', example: '0.64em' },
  { name: '--font', about: 'Text font', example: '"Segoe UI", system-ui, sans-serif' },
  { name: '--mono', about: 'Fixed-width font (classic view, code)', example: 'Consolas, monospace' },
];

/**
 * Add `name: value` to the style sheet's first top-level `:root { }` rule, or
 * start one at the top. A variable already in that rule gets the new value.
 */
export function insertVariable(css: string, name: string, value: string): string {
  const start = topLevelRoot(css);
  if (start < 0) return `:root {\n  ${name}: ${value};\n}\n${css ? `\n${css}` : ''}`;
  const end = css.indexOf('}', start);
  if (end < 0) return `${css}\n  ${name}: ${value};\n}\n`;
  const body = css.slice(start, end);
  const existing = new RegExp(`(^|[\\s;{])(${name.replace(/[-]/g, '\\-')}\\s*:)[^;}]*`).exec(body);
  if (existing) {
    const at = start + existing.index + existing[1]!.length;
    const stop = start + existing.index + existing[0].length;
    return `${css.slice(0, at)}${name}: ${value}${css.slice(stop)}`;
  }
  const trimmed = body.replace(/\s*$/, '');
  const sep = trimmed === '' || trimmed.endsWith(';') || trimmed.endsWith('{') ? '' : ';';
  return `${css.slice(0, start)}${trimmed}${sep}\n  ${name}: ${value};\n${css.slice(end)}`;
}

/** Where the body of the first `:root {` outside any block (@media) starts, or -1. Comments are skipped. */
function topLevelRoot(css: string): number {
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith('/*', i)) {
      const close = css.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 1;
    } else if (css[i] === '{') depth++;
    else if (css[i] === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && css.startsWith(':root', i) && (i === 0 || /[\s;}]/.test(css[i - 1]!))) {
      const m = /^:root\s*\{/.exec(css.slice(i));
      if (m) return i + m[0].length;
    }
  }
  return -1;
}
