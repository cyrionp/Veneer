// A TN3270 session: socket + Telnet (TN3270E or plain TN3270) + 3270
// terminal, with the same API as a TN5250 session.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import {
  DeviceNameInUseError, getCodepage,
  type Codepage, type ConnectionSettings, type ScreenSnapshot, type SubmitInput, type TerminalSession, type TerminalSessionEvents,
} from '@veneer/terminal';
import { aidByte } from './keys.ts';
import { snapshot } from './screen.ts';
import { TelnetCodec, type RecordKind } from './telnet.ts';
import { ProtocolError, Terminal } from './terminal.ts';

export interface SessionOptions extends ConnectionSettings {
  /** IBM-3278-2-E (24x80, the default), -3-E (32x80), -4-E (43x80) or -5-E (27x132). */
  terminalType?: string;
  /** LU name to ask for; omit to let the host pick one. */
  deviceName?: string;
  /** The LU is in use: return another to try, or undefined to give up. */
  onDeviceNameInUse?: (name: string) => string | undefined;
  /** Use TN3270E when the host offers it (default true). */
  tn3270e?: boolean;
  /** Host code page: 37 (default) or 1047, or one registered with registerCodepage. */
  ccsid?: number;
  connectTimeoutMs?: number;
  /** Receives every record in both directions (with the TN3270E header, if any), for debugging and fixtures. */
  trace?: (direction: 'in' | 'out', record: Buffer) => void;
}

/** The 3278 model a terminal type names: IBM-3278-4-E is a model 4. */
export function modelOf(terminalType: string): number {
  const m = /^IBM-327[89]-([2-5])(-E)?$/i.exec(terminalType);
  if (!m) throw new Error(`Terminal type ${terminalType} is not supported: use IBM-3278-2-E, -3-E, -4-E or -5-E`);
  return Number(m[1]);
}

export class Session extends EventEmitter<TerminalSessionEvents> implements TerminalSession {
  private readonly opts: SessionOptions;
  private readonly codepage: Codepage;
  private readonly terminal: Terminal;
  private readonly telnet: TelnetCodec;
  private socket: net.Socket | null = null;
  private closed = false;
  private failure: Error | undefined;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
    this.codepage = getCodepage(opts.ccsid ?? 37);
    const terminalType = opts.terminalType ?? 'IBM-3278-2-E';
    this.terminal = new Terminal({
      codepage: this.codepage,
      model: modelOf(terminalType),
      send3270: (data) => this.telnet.send3270(Uint8Array.from(data)),
      sendSscpLu: (data) => this.telnet.sendSscpLu(Uint8Array.from(data)),
      onWarning: (msg) => this.emit('warning', msg),
    });
    this.telnet = new TelnetCodec({
      terminalType,
      deviceName: opts.deviceName,
      tn3270e: opts.tn3270e,
      onDeviceNameInUse: opts.onDeviceNameInUse,
      send: (bytes) => this.socket?.write(bytes),
      onRecord: (kind, data) => this.onRecord(kind, data),
      onFailure: (err) => { this.failure = err; this.close(); },
      ...(opts.trace ? { trace: opts.trace } : {}),
    });
  }

  connect(): Promise<void> {
    const { host, connectTimeoutMs = 15_000 } = this.opts;
    const useTls = this.opts.tls !== undefined && this.opts.tls !== false;
    const port = this.opts.port ?? (useTls ? 992 : 23);
    return new Promise((resolve, reject) => {
      const tlsOpts = typeof this.opts.tls === 'object' ? this.opts.tls : {};
      const socket = useTls
        ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...tlsOpts })
        : net.connect({ host, port });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy(new Error(`Timed out connecting to ${host}:${port}`));
      }, connectTimeoutMs);
      const onError = (err: Error) => { clearTimeout(timer); reject(err); };
      socket.once('error', onError);
      socket.once(useTls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        socket.on('error', (err) => this.shutdown(err));
        resolve();
      });
      socket.on('data', (chunk) => this.telnet.receive(chunk));
      socket.on('close', () => this.shutdown());
    });
  }

  get connected(): boolean {
    return this.socket !== null && !this.closed;
  }

  /** The LU the host connected us to, or the one asked for. */
  get deviceName(): string | undefined {
    return this.telnet.deviceName;
  }

  /** True when TN3270E was agreed (false: plain TN3270). */
  get tn3270e(): boolean {
    return this.telnet.tn3270e;
  }

  snapshot(): ScreenSnapshot {
    return snapshot(this.terminal.screen, this.codepage);
  }

  /** Resolve with the next screen awaiting the user: keyboard unlocked. */
  waitForInput(timeoutMs = 30_000): Promise<ScreenSnapshot> {
    const now = this.snapshot();
    if (!now.keyboardLocked) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for host')); }, timeoutMs);
      const onScreen = (snap: ScreenSnapshot) => {
        if (!snap.keyboardLocked) { cleanup(); resolve(snap); }
      };
      const onClose = (err?: Error) => { cleanup(); reject(err ?? new Error('Session closed')); };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('screen', onScreen);
        this.off('close', onClose);
      };
      this.on('screen', onScreen);
      this.on('close', onClose);
    });
  }

  /**
   * Fill fields and press a key. On an unformatted screen (no fields, such as
   * a logon screen) a "row:col" id types the text at that position.
   */
  submit(input: SubmitInput): void {
    const aid = aidByte(input.aid);
    const screen = this.terminal.screen;
    if (screen.keyboardLocked) throw new ProtocolError('Keyboard is locked');
    const entries = Object.entries(input.fields ?? {});
    if (screen.formatted) {
      const fields = screen.fields();
      for (const [id, value] of entries) {
        const field = fields.find((f) => {
          const { row, col } = screen.rowCol(f.start);
          return `${row}:${col}` === id;
        });
        if (!field) throw new ProtocolError(`No field ${id} on this screen`);
        this.terminal.setFieldValue(field, value);
      }
    } else {
      for (const [id, value] of entries) {
        const m = /^(\d+):(\d+)$/.exec(id);
        const [row, col] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
        if (row < 1 || row > screen.rows || col < 1 || col > screen.cols) throw new ProtocolError(`No position ${id} on this screen`);
        this.terminal.writeText(screen.address(row, col), value);
      }
    }
    if (input.cursor) screen.cursor = screen.address(input.cursor.row, input.cursor.col);
    this.terminal.sendAid(aid);
    this.emit('screen', this.snapshot());
  }

  /** Not available yet: TN3270E's SYSREQ function is not negotiated. */
  systemRequest(): void {
    throw new ProtocolError('System Request is not supported on 3270 sessions yet');
  }

  /** The Attention key (Telnet Interrupt Process), which TSO uses to interrupt a command. */
  attention(): void {
    this.telnet.sendAttention();
  }

  /** A 3270 has no keyboard errors for Veneer to clear; this just clears the alarm. */
  reset(): void {
    this.terminal.screen.alarm = false;
    this.emit('screen', this.snapshot());
  }

  close(): void {
    this.socket?.end();
    this.shutdown();
  }

  private onRecord(kind: RecordKind, data: Buffer): void {
    try {
      if (kind === '3270') this.terminal.processRecord(data);
      else if (kind === 'sscp-lu') this.terminal.processSscpLu(data);
      else if (kind === 'bind') this.terminal.bind();
      else if (kind === 'unbind') this.terminal.unbind();
      else this.emit('warning', 'Ignored a record the 3270 session does not use');
    } catch (err) {
      this.emit('warning', `Failed to process record: ${(err as Error).message}`);
      throw err;
    } finally {
      this.emit('screen', this.snapshot());
    }
  }

  private shutdown(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    err ??= this.failure;
    const refused = this.telnet.refusedDeviceName;
    if (!err && refused) err = new DeviceNameInUseError(refused);
    this.socket?.destroy();
    this.emit('close', err);
  }
}
