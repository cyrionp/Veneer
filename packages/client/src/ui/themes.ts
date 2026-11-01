// The site's theme (the server's themes/, chosen in the designer): its style
// sheet goes in the page after Veneer's own styles and before the site's and
// screens' CSS, <html data-theme> names it for scripts and components, and its
// logo replaces the header logo and the tab icon. While the designer edits a
// theme, the page shows the draft; closing it puts back the theme in use.

import { rebaseCss, themeBase, type ActiveTheme } from '@veneer/screens';
import { useSyncExternalStore } from 'react';

/** What applyTheme needs: the theme in use, or a draft in the designer. */
export type ShownTheme = Pick<ActiveTheme, 'name' | 'css' | 'logo'>;

/** The theme's style sheet as page text, its relative URLs pointing into its folder. */
export function themeStyleText(theme: ShownTheme): string {
  return rebaseCss(theme.css, themeBase(theme.name));
}

let logo: string | null = null;
const listeners = new Set<() => void>();

/** Show `theme` on the page; null takes it away (Veneer's own look). */
export function applyTheme(theme: ShownTheme | null | undefined, doc: Document = document): void {
  const root = doc.documentElement;
  let el = doc.head.querySelector<HTMLStyleElement>('style[data-veneer-theme]');
  if (!theme) {
    delete root.dataset.theme;
    el?.remove();
  } else {
    root.dataset.theme = theme.name;
    if (!el) {
      el = doc.createElement('style');
      el.dataset.veneerTheme = '';
      // Last in <head>: after Veneer's styles and the brand colors. The site's
      // and screens' CSS are in the page body, so they still come after it.
      doc.head.append(el);
    }
    const text = themeStyleText(theme);
    if (el.textContent !== text) el.textContent = text;
  }
  const next = theme?.logo ?? null;
  if (next !== logo) {
    logo = next;
    for (const fn of [...listeners]) fn();
  }
}

/** The shown theme's logo URL, or null when it has none (the brand logo is shown). */
export function useThemeLogo(): string | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => logo,
  );
}

/** For tests: the logo applyTheme last set. */
export const shownLogo = () => logo;
