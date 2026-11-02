// Host connection settings from VENEER_* environment variables (see .env.example),
// for the developer CLI. The server reads its own, for either host type
// (packages/server/src/host.ts).

import fs from 'node:fs';
import type { SessionOptions } from './session.ts';

export type HostSettings = Omit<SessionOptions, 'trace'>;

export function hostSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): HostSettings {
  if (!env.VENEER_HOST) throw new Error('VENEER_HOST is not set (see .env.example)');
  const useTls = (env.VENEER_TLS ?? 'true') !== 'false';
  const port = env.VENEER_PORT ? Number(env.VENEER_PORT) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error(`VENEER_PORT is not a valid port: ${env.VENEER_PORT}`);
  }
  return {
    host: env.VENEER_HOST,
    port,
    tls: useTls && {
      rejectUnauthorized: env.VENEER_TLS_REJECT_UNAUTHORIZED !== 'false',
      ...(env.VENEER_TLS_CA ? { ca: fs.readFileSync(env.VENEER_TLS_CA) } : {}),
    },
    terminalType: env.VENEER_TERMINAL_TYPE || undefined,
    deviceName: env.VENEER_DEVNAME || undefined,
  };
}
