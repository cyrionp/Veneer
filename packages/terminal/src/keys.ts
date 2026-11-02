// The keys (AIDs) that send a screen to the host. Some every host type has;
// the rest only some do.

import type { HostType } from './screen.ts';

/** F1-F24 (PF1-PF24 on a 3270). */
export type FunctionKeyName = `F${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24}`;

/** Named keys every host type has. */
export const COMMON_AIDS = ['Enter', 'Clear'] as const;

/** Named keys only a 5250 has. */
export const AIDS_5250 = ['Help', 'PageUp', 'PageDown', 'Print', 'RecordBackspace'] as const;

/** Named keys only a 3270 has: the program attention keys, which send no field data. */
export const AIDS_3270 = ['PA1', 'PA2', 'PA3'] as const;

export type AidName = (typeof COMMON_AIDS)[number] | (typeof AIDS_5250)[number] | (typeof AIDS_3270)[number] | FunctionKeyName;

const NAMED: ReadonlySet<string> = new Set<string>([...COMMON_AIDS, ...AIDS_5250, ...AIDS_3270]);

export function isAidName(v: unknown): v is AidName {
  return typeof v === 'string' && (NAMED.has(v) || /^F([1-9]|1\d|2[0-4])$/.test(v));
}

/** Whether a host type has a key: 5250s have no PA keys, 3270s no Help, paging, Print or Record Backspace. */
export function hostHasAid(host: HostType, aid: AidName): boolean {
  const only = (host === '5250' ? AIDS_3270 : AIDS_5250) as readonly string[];
  return !only.includes(aid);
}
