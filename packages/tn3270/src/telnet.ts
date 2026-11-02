// Telnet framing and option negotiation for TN3270E (RFC 2355), falling back
// to plain TN3270 (RFC 1576, with RFC 1646's TYPE@LU names). Transport-
// agnostic: feed received bytes to receive(); outbound bytes go to `send`.

import { DeviceNameInUseError } from '@veneer/terminal';
import { DataType, E, Func, RejectReason, ResponseFlag, TType, Telnet, TelnetOption } from './constants.ts';

/** What a record from the host carries. */
export type RecordKind = '3270' | 'sscp-lu' | 'bind' | 'unbind' | 'other';

export interface TelnetOptions {
  /** e.g. IBM-3278-2-E (24x80) or IBM-3278-5-E (27x132). */
  terminalType: string;
  /** LU name to ask for; omit to let the host pick one. */
  deviceName?: string | undefined;
  /** Use TN3270E when the host offers it (default true). */
  tn3270e?: boolean | undefined;
  /** The LU is in use: return another to try, or undefined to give up. */
  onDeviceNameInUse?: ((name: string) => string | undefined) | undefined;
  send: (bytes: Buffer) => void;
  /** A record from the host. Throwing sends a negative response when the host asked for one. */
  onRecord: (kind: RecordKind, data: Buffer) => void;
  /** Negotiation failed for good, e.g. no such LU. */
  onFailure: (err: Error) => void;
  /** Receives every record in both directions, with the TN3270E header if any. */
  trace?: ((direction: 'in' | 'out', record: Buffer) => void) | undefined;
}

/** Functions we ask for: BIND-IMAGE tells us when an application is bound, RESPONSES lets hosts ask for acknowledgements. */
const WANTED_FUNCTIONS = [Func.BIND_IMAGE, Func.RESPONSES];

const State = { Data: 0, Iac: 1, Will: 2, Wont: 3, Do: 4, Dont: 5, Sb: 6, SbIac: 7 } as const;
type State = (typeof State)[keyof typeof State];

export class TelnetCodec {
  private readonly opts: TelnetOptions;
  private state: State = State.Data;
  private record: number[] = [];
  private sub: number[] = [];
  private readonly localOn = new Set<number>();
  private readonly remoteOn = new Set<number>();
  private requestedName: string | undefined;
  private assignedName: string | undefined;
  private refused: string | undefined;
  private functions: number[] = [];
  /** True once TN3270E device type and functions are agreed. */
  private extended = false;
  private seq = 0;

  constructor(opts: TelnetOptions) {
    this.opts = opts;
    this.requestedName = opts.deviceName || undefined;
  }

  /** TN3270E is in use (records carry a header). */
  get tn3270e(): boolean {
    return this.extended;
  }

  /** The LU the host connected us to, or else the one asked for. */
  get deviceName(): string | undefined {
    return this.assignedName ?? this.requestedName;
  }

  /** The LU name the host refused when there was no other to offer. */
  get refusedDeviceName(): string | undefined {
    return this.refused;
  }

  /** The TN3270E functions agreed with the host. */
  get agreedFunctions(): readonly number[] {
    return this.functions;
  }

  receive(chunk: Uint8Array): void {
    for (const b of chunk) {
      switch (this.state) {
        case State.Data:
          if (b === Telnet.IAC) this.state = State.Iac;
          else this.record.push(b);
          break;
        case State.Iac:
          this.state = State.Data;
          if (b === Telnet.IAC) this.record.push(0xff);
          else if (b === Telnet.EOR) this.flushRecord();
          else if (b === Telnet.WILL) this.state = State.Will;
          else if (b === Telnet.WONT) this.state = State.Wont;
          else if (b === Telnet.DO) this.state = State.Do;
          else if (b === Telnet.DONT) this.state = State.Dont;
          else if (b === Telnet.SB) { this.sub = []; this.state = State.Sb; }
          break;
        case State.Will: this.state = State.Data; this.onWill(b); break;
        case State.Wont: this.state = State.Data; this.onWont(b); break;
        case State.Do: this.state = State.Data; this.onDo(b); break;
        case State.Dont: this.state = State.Data; this.onDont(b); break;
        case State.Sb:
          if (b === Telnet.IAC) this.state = State.SbIac;
          else this.sub.push(b);
          break;
        case State.SbIac:
          if (b === Telnet.SE) { this.state = State.Data; this.onSubnegotiation(this.sub); }
          else { this.sub.push(b); this.state = State.Sb; }
          break;
      }
    }
  }

  /** Send 3270 data (an inbound data stream: AID, cursor and fields). */
  send3270(data: Uint8Array): void {
    this.sendRecord(DataType.DATA_3270, data);
  }

  /** Send text typed on the SSCP-LU session (the VTAM logon screen). */
  sendSscpLu(data: Uint8Array): void {
    this.sendRecord(this.extended ? DataType.SSCP_LU_DATA : DataType.DATA_3270, data);
  }

  /** The Attention key: Telnet Interrupt Process. */
  sendAttention(): void {
    this.opts.send(Buffer.from([Telnet.IAC, Telnet.IP]));
  }

  private sendRecord(type: number, data: Iterable<number>, responseFlag: number = ResponseFlag.NO, seq?: number): void {
    const record: number[] = [];
    if (this.extended) {
      const n = seq ?? (this.seq = (this.seq + 1) & 0x7fff);
      record.push(type, 0x00, responseFlag, n >> 8, n & 0xff);
    }
    record.push(...data);
    this.opts.trace?.('out', Buffer.from(record));
    const out = record.flatMap((b) => (b === Telnet.IAC ? [b, b] : [b]));
    out.push(Telnet.IAC, Telnet.EOR);
    this.opts.send(Buffer.from(out));
  }

  private flushRecord(): void {
    const rec = Buffer.from(this.record);
    this.record = [];
    if (rec.length === 0) return;
    this.opts.trace?.('in', rec);
    if (!this.extended) return this.opts.onRecord('3270', rec);
    if (rec.length < 5) return;
    const [type, , responseFlag, s1, s2] = rec;
    const data = rec.subarray(5);
    const kind: RecordKind =
      type === DataType.DATA_3270 ? '3270'
      : type === DataType.SSCP_LU_DATA ? 'sscp-lu'
      : type === DataType.BIND_IMAGE ? 'bind'
      : type === DataType.UNBIND ? 'unbind'
      : 'other';
    let ok = true;
    try {
      this.opts.onRecord(kind, data);
    } catch {
      ok = false;
    }
    // Answer only for 3270 data, and only when RESPONSES was agreed.
    if (type !== DataType.DATA_3270 || !this.functions.includes(Func.RESPONSES)) return;
    const seq = (s1! << 8) | s2!;
    if (!ok && responseFlag !== ResponseFlag.NO) {
      this.sendRecord(DataType.RESPONSE, [0x00], ResponseFlag.NEGATIVE, seq); // command reject
    } else if (ok && responseFlag === ResponseFlag.ALWAYS) {
      this.sendRecord(DataType.RESPONSE, [0x00], ResponseFlag.POSITIVE, seq); // device end
    }
  }

  private reply(verb: number, option: number): void {
    this.opts.send(Buffer.from([Telnet.IAC, verb, option]));
  }

  private wantsLocal(option: number): boolean {
    if (option === TelnetOption.TN3270E) return this.opts.tn3270e !== false;
    return option === TelnetOption.BINARY || option === TelnetOption.EOR || option === TelnetOption.TERMINAL_TYPE;
  }

  private onDo(option: number): void {
    if (!this.wantsLocal(option)) return this.reply(Telnet.WONT, option);
    if (this.localOn.has(option)) return;
    this.localOn.add(option);
    this.reply(Telnet.WILL, option);
  }

  private onDont(option: number): void {
    if (!this.localOn.delete(option)) return;
    if (option === TelnetOption.TN3270E) this.extended = false;
    this.reply(Telnet.WONT, option);
  }

  private onWill(option: number): void {
    if (option !== TelnetOption.BINARY && option !== TelnetOption.EOR) return this.reply(Telnet.DONT, option);
    if (this.remoteOn.has(option)) return;
    this.remoteOn.add(option);
    this.reply(Telnet.DO, option);
  }

  private onWont(option: number): void {
    if (!this.remoteOn.delete(option)) return;
    this.reply(Telnet.DONT, option);
  }

  private onSubnegotiation(data: number[]): void {
    const [option, ...rest] = data;
    if (option === TelnetOption.TERMINAL_TYPE && rest[0] === TType.SEND) {
      // Plain TN3270 names the LU as TYPE@LU (RFC 1646).
      const name = this.requestedName ? `${this.opts.terminalType}@${this.requestedName}` : this.opts.terminalType;
      this.sendSub(TelnetOption.TERMINAL_TYPE, [TType.IS, ...ascii(name)]);
    } else if (option === TelnetOption.TN3270E && this.localOn.has(TelnetOption.TN3270E)) {
      this.onTn3270e(rest);
    }
  }

  private onTn3270e(data: number[]): void {
    const [word, verb, ...rest] = data;
    if (word === E.SEND && verb === E.DEVICE_TYPE) return this.requestDevice();
    if (word === E.DEVICE_TYPE && verb === E.IS) {
      const connect = rest.indexOf(E.CONNECT);
      if (connect >= 0) this.assignedName = String.fromCharCode(...rest.slice(connect + 1)) || undefined;
      return this.sendSub(TelnetOption.TN3270E, [E.FUNCTIONS, E.REQUEST, ...WANTED_FUNCTIONS]);
    }
    if (word === E.DEVICE_TYPE && verb === E.REJECT) {
      const reason = rest[0] === E.REASON ? rest[1] : undefined;
      return this.onReject(reason);
    }
    if (word === E.FUNCTIONS && verb === E.REQUEST) {
      // The host proposes a set: take the part we support, or propose that.
      const agreed = rest.filter((f) => (WANTED_FUNCTIONS as number[]).includes(f));
      if (agreed.length === rest.length) {
        this.functions = agreed;
        this.extended = true;
        return this.sendSub(TelnetOption.TN3270E, [E.FUNCTIONS, E.IS, ...agreed]);
      }
      return this.sendSub(TelnetOption.TN3270E, [E.FUNCTIONS, E.REQUEST, ...agreed]);
    }
    if (word === E.FUNCTIONS && verb === E.IS) {
      this.functions = rest.filter((f) => (WANTED_FUNCTIONS as number[]).includes(f));
      this.extended = true;
    }
  }

  private requestDevice(): void {
    const body = [E.DEVICE_TYPE, E.REQUEST, ...ascii(this.opts.terminalType)];
    if (this.requestedName) body.push(E.CONNECT, ...ascii(this.requestedName));
    this.sendSub(TelnetOption.TN3270E, body);
  }

  private onReject(reason: number | undefined): void {
    if (reason === RejectReason.DEVICE_IN_USE && this.requestedName) {
      const name = this.opts.onDeviceNameInUse?.(this.requestedName) || undefined;
      if (name) {
        this.requestedName = name;
        return this.requestDevice();
      }
      this.refused = this.requestedName;
      return this.opts.onFailure(new DeviceNameInUseError(this.requestedName));
    }
    if (reason === RejectReason.DEVICE_IN_USE) return this.opts.onFailure(new Error('The host has no free LU'));
    if (reason === RejectReason.INV_NAME || reason === RejectReason.CONN_PARTNER) {
      const what = this.requestedName ? `LU ${this.requestedName}` : 'The LU';
      return this.opts.onFailure(new Error(`${what} is not known to the host or cannot be used`));
    }
    // Some other objection (often the device type): try plain TN3270.
    this.localOn.delete(TelnetOption.TN3270E);
    this.reply(Telnet.WONT, TelnetOption.TN3270E);
  }

  private sendSub(option: number, body: number[]): void {
    const escaped = body.flatMap((b) => (b === Telnet.IAC ? [b, b] : [b]));
    this.opts.send(Buffer.from([Telnet.IAC, Telnet.SB, option, ...escaped, Telnet.IAC, Telnet.SE]));
  }
}

function ascii(s: string): number[] {
  return [...Buffer.from(s, 'ascii')];
}
