// Screen definitions from the server, refetched when the server reports a change.

import type { ActiveTheme, ScreenDefinition, SiteCustomization } from '@veneer/screens';
import { useCallback, useEffect, useState } from 'react';
import { setInstalled } from '../custom/components.ts';

export interface ScreensApi {
  screens: ScreenDefinition[];
  /** Site-wide CSS and JavaScript (global.css, global.js); null until loaded. */
  site: SiteCustomization | null;
  /** The theme in use for everyone; null until loaded. */
  theme: ActiveTheme | null;
  /** Names of the custom components installed on the server. */
  components: string[];
  /** Whether the server allows saving from the designer. */
  designer: boolean;
  /** Whether saving needs the designer token (false for a browser on the server's machine in local mode). */
  tokenRequired: boolean;
  reload: () => void;
}

export function useScreens(version: number): ScreensApi {
  const [screens, setScreens] = useState<ScreenDefinition[]>([]);
  const [site, setSite] = useState<SiteCustomization | null>(null);
  const [theme, setTheme] = useState<ActiveTheme | null>(null);
  const [designer, setDesigner] = useState(false);
  const [tokenRequired, setTokenRequired] = useState(true);
  const [tick, setTick] = useState(0);
  const [components, setComponents] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch('/api/config'), fetch('/api/screens')])
      .then(async ([config, list]) => {
        if (!config.ok || !list.ok) throw new Error(`HTTP ${config.status}/${list.status}`);
        const c = (await config.json()) as { designer: boolean; tokenRequired?: boolean };
        const l = (await list.json()) as { screens: ScreenDefinition[]; site?: SiteCustomization; theme?: ActiveTheme };
        if (cancelled) return;
        setDesigner(c.designer);
        setTokenRequired(c.tokenRequired ?? true);
        setScreens(l.screens);
        setSite(l.site ?? { css: '', scripts: { load: '', screen: '' } });
        // Kept when unchanged, so the page doesn't restyle on every reload.
        const next = l.theme ?? null;
        setTheme((t) => (JSON.stringify(t) === JSON.stringify(next) ? t : next));
      })
      .catch((err: Error) => console.warn('Could not load screen definitions:', err.message));
    // Fetched again with the definitions, so a reload in the designer picks up new ones.
    fetch('/api/components')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { components: list } = (await res.json()) as { components: Array<{ name: string; version: string }> };
        if (cancelled) return;
        setInstalled(list);
        setComponents(list.map((c) => c.name));
      })
      .catch((err: Error) => {
        console.warn('Could not load the component list:', err.message);
        if (!cancelled) setInstalled([]);
      });
    return () => { cancelled = true; };
  }, [version, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { screens, site, theme, components, designer, tokenRequired, reload };
}
