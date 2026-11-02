import { getCodepage } from '@veneer/terminal';
import { decodeAddress } from '../src/address.ts';
import { HostStream } from '../src/hostStream.ts';
import { snapshot } from '../src/screen.ts';
import { Terminal } from '../src/terminal.ts';

export const cp = getCodepage(37);
export const e = (s: string): number[] => cp.encode(s);

/** A terminal that collects what it sends. */
export function makeTerminal(model = 2, ccsid = 37) {
  const sent: number[][] = [];
  const sscp: number[][] = [];
  const warnings: string[] = [];
  const terminal = new Terminal({
    codepage: getCodepage(ccsid),
    model,
    send3270: (d) => sent.push(d),
    sendSscpLu: (d) => sscp.push(d),
    onWarning: (w) => warnings.push(w),
  });
  return {
    terminal, sent, sscp, warnings,
    host: (data: number[]) => terminal.processRecord(Uint8Array.from(data)),
    snap: () => snapshot(terminal.screen, getCodepage(ccsid)),
  };
}

export const stream = () => new HostStream();

/** A small sign-on screen: a title, a user field, a hidden password field and a numeric field. */
export function signOn() {
  const t = makeTerminal();
  t.host(stream().eraseWrite()
    .text(1, 30, 'Sign On', { attr: 0x28 })
    .text(5, 10, 'User')
    .input(5, 30, 8)
    .text(6, 10, 'Password')
    .input(6, 30, 8, { attr: 0x0c })
    .text(7, 10, 'Account')
    .input(7, 30, 5, { attr: 0x10 })
    .cursor(5, 30)
    .build());
  return t;
}

/** Split an inbound Read Modified: AID, cursor address and fields (address -> text). */
export function parseReadModified(data: number[], cols = 80) {
  const aid = data[0];
  if (data.length === 1) return { aid };
  const cursor = decodeAddress(data[1]!, data[2]!);
  const fields: Record<string, string> = {};
  let i = 3;
  while (i < data.length) {
    if (data[i] !== 0x11) throw new Error(`expected SBA at ${i}`);
    const a = decodeAddress(data[i + 1]!, data[i + 2]!);
    i += 3;
    const start = i;
    while (i < data.length && data[i] !== 0x11) i++;
    fields[`${Math.floor(a / cols) + 1}:${(a % cols) + 1}`] = cp.decode(data.slice(start, i));
  }
  return { aid, cursor: { row: Math.floor(cursor / cols) + 1, col: (cursor % cols) + 1 }, fields };
}

/** Split an inbound query reply into its structured fields: QCode -> data. */
export function parseQueryReply(data: number[]): Map<number, number[]> {
  if (data[0] !== 0x88) throw new Error('not a structured field reply');
  const out = new Map<number, number[]>();
  let i = 1;
  while (i < data.length) {
    const length = (data[i]! << 8) | data[i + 1]!;
    if (data[i + 2] !== 0x81) throw new Error('not a query reply');
    out.set(data[i + 3]!, data.slice(i + 4, i + length));
    i += length;
  }
  return out;
}
