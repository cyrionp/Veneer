// System Request: where to type "1" to transfer to the secondary job.

import type { FieldSnapshot, ScreenSnapshot } from '@veneer/terminal';

/**
 * The one input field of the System Request line (bottom row) or, on systems
 * that show it straight away (QSYSREQ), of the System Request menu.
 */
export function sysreqField(snap: ScreenSnapshot): FieldSnapshot | null {
  const inputs = snap.fields.filter((f) => !f.bypass);
  return inputs.length === 1 ? inputs[0]! : null;
}
