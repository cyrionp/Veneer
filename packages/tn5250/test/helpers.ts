import { getCodepage } from '@veneer/terminal';
import { Terminal, buildRecord } from '../src/terminal.ts';

export const cp = getCodepage(37);
export const e = (s: string): number[] => cp.encode(s);

/** A terminal that collects every inbound record it sends. */
export function makeTerminal() {
  const sent: Buffer[] = [];
  const warnings: string[] = [];
  const terminal = new Terminal({
    codepage: cp,
    terminalType: 'IBM-3179-2',
    sendRecord: (r) => sent.push(r),
    onWarning: (w) => warnings.push(w),
  });
  return { terminal, sent, warnings, host: (data: number[], opcode = 0x03) => terminal.processRecord(buildRecord(opcode, data)) };
}

// Host data stream builders
export const CLEAR = [0x04, 0x40];
export const wtd = (cc1: number, cc2: number, ...orders: number[]) => [0x04, 0x11, cc1, cc2, ...orders];
export const sba = (r: number, c: number) => [0x11, r, c];
export const ic = (r: number, c: number) => [0x13, r, c];
export const sf = (ffw: number, attr: number, len: number) => [0x1d, ffw >> 8, ffw & 0xff, attr, len >> 8, len & 0xff];
export const readMdt = (cc1 = 0x00, cc2 = 0x00) => [0x04, 0x52, cc1, cc2];
export const UNLOCK = 0x08;
