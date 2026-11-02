// The spinner widget's arithmetic: step a field's value up or down, kept in
// the form typing the number would give (README, Field handling). Signed
// numeric fields hold digits and a trailing sign, with the decimals implied
// (1250 for 12.50), so a spinner on one counts in those units.

import type { FieldSnapshot } from '@veneer/tn5250';

export interface SpinSettings {
  min?: number;
  max?: number;
  step?: number;
}

interface Parsed {
  /** The value times 10^decimals, as an integer. */
  units: bigint;
  decimals: number;
  /** The decimal separator typed, for numeric-only fields. */
  separator: '.' | ',';
}

const decimalsOf = (n: number) => {
  const s = String(n);
  if (s.includes('e')) return 0;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
};

/** The number in a field value, or null if it isn't one. Blank reads as 0. */
export function parseValue(value: string, field: Pick<FieldSnapshot, 'shift'>): Parsed | null {
  let s = value.trim();
  let negative = false;
  if (/^-|-$/.test(s)) { negative = true; s = s.replace(/^-\s*|\s*-$/, ''); }
  else s = s.replace(/^\+\s*|\s*\+$/, '');
  s = s.trim();
  let separator: '.' | ',' = '.';
  let whole = s;
  let frac = '';
  if (field.shift !== 'signedNumeric' && field.shift !== 'digitsOnly') {
    // The last separator is the decimal one; others group thousands (1,234.50 or 1.234,50).
    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (last >= 0) {
      separator = s[last] as '.' | ',';
      const other = separator === '.' ? ',' : '.';
      whole = s.slice(0, last).split(other).join('');
      frac = s.slice(last + 1);
    }
  }
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
  const units = BigInt(`${whole || '0'}${frac}`) * (negative ? -1n : 1n);
  return { units, decimals: frac.length, separator };
}

const scale = (n: bigint, from: number, to: number) => n * 10n ** BigInt(to - from);
const toUnits = (n: number, decimals: number) => BigInt(Math.round(n * 10 ** decimals));

function format(units: bigint, decimals: number, separator: string, field: Pick<FieldSnapshot, 'shift'>): string {
  const negative = units < 0n;
  let digits = (negative ? -units : units).toString();
  if (decimals > 0) {
    digits = digits.padStart(decimals + 1, '0');
    digits = `${digits.slice(0, -decimals)}${separator}${digits.slice(-decimals)}`;
  }
  if (!negative) return digits;
  // Signed fields take the sign after the digits, as Field- leaves it.
  return field.shift === 'signedNumeric' ? `${digits}-` : `-${digits}`;
}

/**
 * The value one step up or down, within min and max, or null when it can't
 * move: not a number, already at the limit, or too long for the field.
 */
export function stepValue(value: string, field: Pick<FieldSnapshot, 'shift' | 'length'>, spin: SpinSettings, up: boolean): string | null {
  const parsed = parseValue(value, field);
  if (!parsed) return null;
  const step = spin.step ?? 1;
  const decimals = Math.max(parsed.decimals, decimalsOf(step), decimalsOf(spin.min ?? 0), decimalsOf(spin.max ?? 0));
  // Signed and digits-only fields have no decimal point to type.
  if (decimals > 0 && (field.shift === 'signedNumeric' || field.shift === 'digitsOnly')) return null;
  const current = scale(parsed.units, parsed.decimals, decimals);
  let next = current + (up ? 1n : -1n) * toUnits(step, decimals);
  const min = spin.min !== undefined ? toUnits(spin.min, decimals) : field.shift === 'digitsOnly' ? 0n : undefined;
  const max = spin.max !== undefined ? toUnits(spin.max, decimals) : undefined;
  if (min !== undefined && next < min) next = min;
  if (max !== undefined && next > max) next = max;
  const blank = value.trim() === '';
  if (next === current && !blank) return null;
  const out = format(next, decimals, parsed.separator, field);
  // A signed field keeps its last position for the sign.
  const room = field.shift === 'signedNumeric' ? field.length - 1 : field.length;
  return out.replace(/-$/, '').length <= room && out.length <= field.length ? out : null;
}
