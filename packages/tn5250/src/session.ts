// A TN5250 session: socket + Telnet + 5250 terminal, with a small API for
// reading screens and submitting input.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import {
  DeviceNameInUseError, fieldId,
  type ConnectionSettings, type ScreenSnapshot, type SubmitInput, type TerminalSession, type TerminalSessionEvents,
} from '@veneer/terminal';
import { aidByte } from './constants.ts';
import { getCodepage, type Codepage } from '@veneer/terminal';
import { snapshot } from './screen.ts';
import { TelnetCodec } from './telnet.ts';
import { ProtocolError, Terminal } from './terminal.ts';

export interface SessionOptions extends ConnectionSettings {
  terminalType?: string;
  deviceName?: string;
  /** The device name is in use: return another to try, or undefined to give up. */
  onDeviceNameInUse?: (name: string) => string | undefined;
  ccsid?: number;
  connectTimeoutMs?: number;
  /** Receives every 5250 record in both directions, for debugging and fixtures. */
  trace?: (direction: 'in' | 'out', record: Buffer) => void;
}

export class Session extends EventEmitter<TerminalSessionEvents> implements TerminalSession {
  private readonly opts: SessionOptions;
  private readonly codepage: Codepage;
  private readonly terminal: Terminal;
  private readonly telnet: TelnetCodec;
  private socket: net.Socket | null = null;
  private closed = false;

  constructor(opts: SessionOptions) {
    super();
    this.opts = opts;
    this.codepage = getCodepage(opts.ccsid ?? 37);
    const terminalType = opts.terminalType ?? 'IBM-3179-2';
    this.terminal = new Terminal({
      codepage: this.codepage,
      terminalType,
      sendRecord: (rec) => {
        opts.trace?.('out', rec);
        this.telnet.sendRecord(rec);
      },
      onWarning: (msg) => this.emit('warning', msg),
    });
    this.telnet = new TelnetCodec({
      terminalType,
      deviceName: opts.deviceName,
      onDeviceNameInUse: opts.onDeviceNameInUse,
      send: (bytes) => this.socket?.write(bytes),
      onRecord: (rec) => this.onRecord(rec),
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

  /** The device name requested from the host; changes if a name was in use. */
  get deviceName(): string | undefined {
    return this.telnet.deviceName;
  }

  /**
   * The screen as the user sees it. Input is inhibited, as on a 5250, until the
   * host has a Read outstanding: after Cancel Invite (SysReq), or between a
   * screen and the Read that follows it. A key sent then can be taken as the
   * reply to the host's next Save Screen, and replayed later as a screen.
   */
  snapshot(): ScreenSnapshot {
    const snap = snapshot(this.terminal.screen, this.codepage);
    return this.terminal.readPending ? snap : { ...snap, keyboardLocked: true };
  }

  /** Resolve with the next screen awaiting the user: keyboard unlocked or an error shown. */
  waitForInput(timeoutMs = 30_000): Promise<ScreenSnapshot> {
    const ready = (snap: ScreenSnapshot) => !snap.keyboardLocked || snap.error !== null;
    const now = this.snapshot();
    if (ready(now)) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for host')); }, timeoutMs);
      const onScreen = (snap: ScreenSnapshot) => {
        if (ready(snap)) { cleanup(); resolve(snap); }
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

  /** Fill fields and press an AID key. */
  submit(input: SubmitInput): void {
    // Check the key first, so a key the 5250 doesn't have changes nothing.
    const aid = aidByte(input.aid);
    const screen = this.terminal.screen;
    if (screen.error) this.terminal.reset();
    if (screen.keyboardLocked || !this.terminal.readPending) throw new ProtocolError('Keyboard is locked');
    for (const [id, value] of Object.entries(input.fields ?? {})) {
      const field = screen.fields.find((f) => {
        const { row, col } = screen.rowCol(f.start);
        return fieldId(row, col) === id;
      });
      if (!field) throw new ProtocolError(`No field ${id} on this screen`);
      this.terminal.setFieldValue(field, value);
    }
    if (input.cursor) screen.cursor = screen.address(input.cursor.row, input.cursor.col);
    this.terminal.sendAid(aid);
  }

  systemRequest(): void { this.terminal.sendSystemRequest(); }
  attention(): void { this.terminal.sendAttention(); }
  reset(): void {
    this.terminal.reset();
    this.emit('screen', this.snapshot());
  }

  close(): void {
    this.socket?.end();
    this.shutdown();
  }

  private onRecord(rec: Buffer): void {
    this.opts.trace?.('in', rec);
    try {
      this.terminal.processRecord(rec);
    } catch (err) {
      this.emit('warning', `Failed to process record: ${(err as Error).message}`);
    }
    this.emit('screen', this.snapshot());
  }

  private shutdown(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const refused = this.telnet.refusedDeviceName;
    if (!err && refused) err = new DeviceNameInUseError(refused);
    this.socket?.destroy();
    this.emit('close', err);
  }
}
