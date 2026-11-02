// A tiny fake mainframe: negotiates TN3270E (device type, LU, functions),
// shows a sign-on screen, and a menu after Enter. Records every inbound 3270
// record (without its TN3270E header) and the LU names asked for.

import net from 'node:net';
import { HostStream } from '@veneer/tn3270';

const IAC = 0xff, SB = 0xfa, SE = 0xf0, EOR = 0xef, DO = 0xfd, TN3270E = 0x28;

export const SIGN_ON = new HostStream().eraseWrite()
  .text(1, 30, 'Sign On', { attr: 0x28 })
  .text(5, 10, 'Userid').input(5, 30, 8)
  .text(6, 10, 'Password').input(6, 30, 8, { attr: 0x0c })
  .cursor(5, 30).build();

export const MENU = new HostStream().eraseWrite()
  .text(1, 30, 'Main Menu', { attr: 0x28 })
  .text(22, 2, 'Option').input(22, 10, 2)
  .cursor(22, 10).build();

export class FakeHost3270 {
  readonly server = net.createServer((s) => this.onConnection(s));
  /** Inbound 3270 records, header stripped. */
  readonly records: number[][] = [];
  /** LU names clients asked for (null: none). */
  readonly lus: Array<string | null> = [];
  readonly terminalTypes: string[] = [];

  async start(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return (this.server.address() as net.AddressInfo).port;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  private onConnection(s: net.Socket): void {
    let state: 'data' | 'iac' | 'verb' | 'sb' | 'sbiac' = 'data';
    let record: number[] = [];
    let sub: number[] = [];
    const send = (data: number[]) => s.write(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, ...data.flatMap((b) => (b === IAC ? [b, b] : [b])), IAC, EOR]));
    const onSub = ([option, word, verb, ...rest]: number[]) => {
      if (option !== TN3270E) return;
      if (word === 0x02 && verb === 0x07) {
        const connect = rest.indexOf(0x01);
        this.terminalTypes.push(String.fromCharCode(...rest.slice(0, connect < 0 ? undefined : connect)));
        const lu = connect < 0 ? null : String.fromCharCode(...rest.slice(connect + 1));
        this.lus.push(lu);
        const type = this.terminalTypes.at(-1)!;
        s.write(Buffer.from([IAC, SB, TN3270E, 0x02, 0x04, ...Buffer.from(type), 0x01, ...Buffer.from(lu ?? 'TCP00001'), IAC, SE]));
      } else if (word === 0x03 && verb === 0x07) {
        s.write(Buffer.from([IAC, SB, TN3270E, 0x03, 0x04, ...rest, IAC, SE]));
        send(SIGN_ON);
      }
    };
    s.on('data', (chunk) => {
      for (const b of chunk) {
        if (state === 'data') { if (b === IAC) state = 'iac'; else record.push(b); }
        else if (state === 'iac') {
          state = 'data';
          if (b === IAC) record.push(b);
          else if (b === EOR) {
            const data = record.slice(5);
            record = [];
            this.records.push(data);
            if (data[0] === 0x7d) send(MENU);
          } else if (b === SB) { sub = []; state = 'sb'; }
          else if (b >= 0xfb) state = 'verb';
        } else if (state === 'verb') {
          state = 'data';
          if (b === TN3270E) s.write(Buffer.from([IAC, SB, TN3270E, 0x08, 0x02, IAC, SE]));
        } else if (state === 'sb') { if (b === IAC) state = 'sbiac'; else sub.push(b); }
        else if (b === SE) { state = 'data'; onSub(sub); }
        else { sub.push(b); state = 'sb'; }
      }
    });
    s.on('error', () => {});
    s.write(Buffer.from([IAC, DO, TN3270E]));
  }
}
