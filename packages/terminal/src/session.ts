// What the server needs of a host session, whatever the host type: connect,
// screens as they arrive, and keys sent back.

import type { EventEmitter } from 'node:events';
import type tls from 'node:tls';
import type { AidName } from './keys.ts';
import type { ScreenSnapshot } from './screen.ts';

/** Where the host is, for every host type. */
export interface ConnectionSettings {
  host: string;
  /** Defaults to 992 with TLS, 23 without. */
  port?: number;
  /** true, or tls.connect options (ca, rejectUnauthorized, ...). */
  tls?: boolean | tls.ConnectionOptions;
}

export interface SubmitInput {
  aid: AidName;
  /** Field values by field id ("row:col"); unchanged values are not sent. */
  fields?: Record<string, string>;
  /** 1-based cursor position to report to the host. */
  cursor?: { row: number; col: number };
}

export interface TerminalSessionEvents {
  /** The host changed the screen. */
  screen: [ScreenSnapshot];
  warning: [string];
  close: [Error | undefined];
}

export interface TerminalSession extends EventEmitter<TerminalSessionEvents> {
  connect(): Promise<void>;
  readonly connected: boolean;
  /** The device (5250) or LU (3270) name asked for; changes if a name was in use. */
  readonly deviceName: string | undefined;
  /** The screen as the user sees it. */
  snapshot(): ScreenSnapshot;
  /** Resolve with the next screen awaiting the user. */
  waitForInput(timeoutMs?: number): Promise<ScreenSnapshot>;
  /** Fill fields and press a key. */
  submit(input: SubmitInput): void;
  systemRequest(): void;
  attention(): void;
  /** Clear a keyboard error. */
  reset(): void;
  close(): void;
}

/** The host closed the connection because the device or LU name is in use. */
export class DeviceNameInUseError extends Error {
  readonly deviceName: string;
  constructor(deviceName: string) {
    super(`Device name ${deviceName} is in use`);
    this.name = 'DeviceNameInUseError';
    this.deviceName = deviceName;
  }
}
