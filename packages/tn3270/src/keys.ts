// AID names -> 3270 AID bytes.

import type { AidName } from '@veneer/terminal';
import { Aid, PF_AIDS } from './constants.ts';
import { ProtocolError } from './terminal.ts';

export function aidByte(name: AidName): number {
  switch (name) {
    case 'Enter': return Aid.ENTER;
    case 'Clear': return Aid.CLEAR;
    case 'PA1': return Aid.PA1;
    case 'PA2': return Aid.PA2;
    case 'PA3': return Aid.PA3;
  }
  const m = /^F(\d+)$/.exec(name);
  const code = m ? PF_AIDS[Number(m[1]) - 1] : undefined;
  if (code === undefined) throw new ProtocolError(`A 3270 has no ${name} key`);
  return code;
}
