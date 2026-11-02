// Reads who is signing on, and the display name, from the IBM i sign-on
// screen, so the admin page can show them. Only the user field is read.

import type { FieldSnapshot, ScreenSnapshot } from '@veneer/terminal';

/** IBM i user profile and device names. */
const NAME = /^[A-Z#$@][A-Z0-9#$@_]{0,9}$/;

/**
 * The user field of a sign-on screen: an input labelled with the word "user"
 * ("User . . ." on IBM's screen, "Your user name:" on some custom ones) on a
 * screen that also has a hidden (password) field. Undefined elsewhere.
 */
export function signOnUserField(snap: ScreenSnapshot): FieldSnapshot | undefined {
  if (!snap.fields.some((f) => f.attr.nonDisplay && !f.bypass)) return undefined;
  return snap.fields.find((f) => !f.bypass && !f.attr.nonDisplay
    && /\buser\b/i.test(snap.lines[f.row - 1]?.slice(0, f.col - 2) ?? ''));
}

/** The user name submitted on a sign-on screen, if it looks like one. */
export function submittedUser(snap: ScreenSnapshot, fields: Record<string, string> | undefined): string | undefined {
  const field = signOnUserField(snap);
  if (!field) return undefined;
  const user = (fields?.[field.id] ?? field.value).trim().toUpperCase();
  return NAME.test(user) ? user : undefined;
}

/** The display (device) name the sign-on screen shows, e.g. QPADEV0001. */
export function displayName(snap: ScreenSnapshot): string | undefined {
  for (const line of snap.lines) {
    const m = /\bDisplay(?: name)?[ .]*:\s*(\S+)/i.exec(line);
    if (m && NAME.test(m[1]!.toUpperCase())) return m[1]!.toUpperCase();
  }
  return undefined;
}
