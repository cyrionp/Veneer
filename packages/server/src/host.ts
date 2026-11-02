// The host every browser session connects to: its settings, from VENEER_*
// environment variables, and the session that speaks its protocol. This is
// the only server code that knows there are two host types.

import fs from 'node:fs';
import { getCodepage, type ConnectionSettings, type HostType, type TerminalSession } from '@veneer/terminal';
import { Session as Session3270, modelOf } from '@veneer/tn3270';
import { Session as Session5250 } from '@veneer/tn5250';

export const HOST_TYPES: readonly HostType[] = ['5250', '3270'];

export interface HostSettings extends ConnectionSettings {
  /** IBM i (5250, the default) or mainframe (3270). */
  type?: HostType;
  /** Defaults: IBM-3179-2 (5250), IBM-3278-2-E (3270). */
  terminalType?: string;
  /** Host code page; default 37. */
  ccsid?: number;
  /** 3270 only: use TN3270E when the host offers it (default true). */
  tn3270e?: boolean;
}

/** What each session adds to the shared settings. */
export interface SessionExtras {
  /** Device (5250) or LU (3270) name to ask for. */
  deviceName?: string;
  onDeviceNameInUse?: (name: string) => string | undefined;
  trace?: (direction: 'in' | 'out', record: Buffer) => void;
}

export const hostTypeOf = (settings: HostSettings): HostType => settings.type ?? '5250';

/** The longest device name a host takes: 10 on IBM i, 8 for a VTAM LU. */
export const deviceNameLength = (type: HostType): number => (type === '3270' ? 8 : 10);

/** What people call the host in messages. */
export const hostLabel = (type: HostType): string => (type === '3270' ? 'the mainframe' : 'the IBM i');

export function defaultPort(settings: HostSettings): number {
  return settings.port ?? (settings.tls ? 992 : 23);
}

export function hostSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): HostSettings {
  if (!env.VENEER_HOST) throw new Error('VENEER_HOST is not set (see .env.example)');
  const type = (env.VENEER_HOST_TYPE || '5250') as HostType;
  if (!HOST_TYPES.includes(type)) throw new Error(`VENEER_HOST_TYPE must be 5250 or 3270, got "${env.VENEER_HOST_TYPE}"`);

  const port = env.VENEER_PORT ? Number(env.VENEER_PORT) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error(`VENEER_PORT is not a valid port: ${env.VENEER_PORT}`);
  }
  const useTls = (env.VENEER_TLS ?? 'true') !== 'false';

  const terminalType = env.VENEER_TERMINAL_TYPE || undefined;
  if (type === '3270' && terminalType) modelOf(terminalType); // throws for a type we can't be

  const ccsid = env.VENEER_CCSID ? Number(env.VENEER_CCSID) : undefined;
  if (ccsid !== undefined) {
    try {
      getCodepage(ccsid);
    } catch {
      throw new Error(`VENEER_CCSID ${env.VENEER_CCSID} is not supported: use 37 or 1047`);
    }
  }

  const tn3270e = env.VENEER_TN3270E ?? '';
  if (tn3270e !== '' && tn3270e !== 'true' && tn3270e !== 'false') throw new Error(`VENEER_TN3270E must be true or false, got "${tn3270e}"`);
  if (tn3270e !== '' && type !== '3270') throw new Error('VENEER_TN3270E is for 3270 hosts (VENEER_HOST_TYPE=3270)');

  return {
    type,
    host: env.VENEER_HOST,
    ...(port !== undefined ? { port } : {}),
    tls: useTls && {
      rejectUnauthorized: env.VENEER_TLS_REJECT_UNAUTHORIZED !== 'false',
      ...(env.VENEER_TLS_CA ? { ca: fs.readFileSync(env.VENEER_TLS_CA) } : {}),
    },
    ...(terminalType ? { terminalType } : {}),
    ...(ccsid !== undefined ? { ccsid } : {}),
    ...(tn3270e === 'false' ? { tn3270e: false } : {}),
  };
}

/** A session to the host, speaking its protocol. */
export function createHostSession(settings: HostSettings, extras: SessionExtras = {}): TerminalSession {
  const { type, tn3270e, ...common } = settings;
  if ((type ?? '5250') === '3270') return new Session3270({ ...common, ...(tn3270e === false ? { tn3270e } : {}), ...extras });
  return new Session5250({ ...common, ...extras });
}
