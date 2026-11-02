// 5250 field rules applied in the browser: allowed characters, the
// Field+/Field- keys, and the mandatory checks a terminal makes before Enter.

import type { FieldSnapshot } from '@veneer/terminal';

const NUMERIC_CHARS = /^[0-9 ,.+-]$/;
/**
 * Signed numeric fields take digits only, as on a terminal: the decimal point
 * is implied by the field (type 1250 for 12.50), and IBM i rejects the
 * record (CPF0886) if one is sent. The sign is typed or set with Field+/Field-.
 */
const SIGNED_CHARS = /^[0-9+-]$/;

/** Signed and numeric-only fields: right-aligned, numbers and signs only. */
export function isNumeric(f: FieldSnapshot): boolean {
  return f.shift === 'numericOnly' || f.shift === 'signedNumeric';
}

export function acceptsChar(f: FieldSnapshot, ch: string): boolean {
  if (f.shift === 'signedNumeric') return SIGNED_CHARS.test(ch);
  if (f.shift === 'numericOnly') return NUMERIC_CHARS.test(ch);
  if (f.shift === 'digitsOnly') return ch >= '0' && ch <= '9';
  return true;
}

/** Drop characters the field does not accept. */
export function filterValue(f: FieldSnapshot, value: string): string {
  return [...value].filter((ch) => acceptsChar(f, ch)).join('');
}

/** Field+ / Field-: set the sign of a numeric value ("123" -> "123-"). */
export function withSign(value: string, negative: boolean): string {
  const digits = value.trim().replace(/^[-+]|[-+]$/, '').trim();
  return negative && digits ? `${digits}-` : digits;
}

export interface FieldProblem {
  id: string;
  message: string;
}

/** The checks a 5250 makes before sending Enter: mandatory entry and mandatory fill. */
export function checkFields(fields: FieldSnapshot[], edits: Record<string, string>): FieldProblem | null {
  for (const f of fields) {
    if (f.bypass) continue;
    const edited = f.id in edits && edits[f.id] !== f.value;
    const value = edits[f.id] ?? f.value;
    if (f.mandatoryEnter && !f.modified && !edited) {
      return { id: f.id, message: 'This field requires an entry.' };
    }
    const length = value.replace(/\s+$/, '').length;
    if (f.adjust === 'mandatoryFill' && length > 0 && length < f.length) {
      return { id: f.id, message: `This field must be completely filled (${f.length} characters).` };
    }
  }
  return null;
}
