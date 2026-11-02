// Server settings from VENEER_* environment variables (see .env.example).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brandFromEnv, type Brand } from './brand.ts';
import { DeviceNamePool } from './devices.ts';
import { deviceNameLength, hostSettingsFromEnv, hostTypeOf, type HostSettings } from './host.ts';

export interface ServerConfig {
  listenHost: string;
  listenPort: number;
  /** Serve HTTPS/WSS when set. */
  https?: { cert: Buffer; key: Buffer };
  /** The one host (IBM i or mainframe) every browser session connects to. */
  host: HostSettings;
  idleTimeoutMs: number;
  /** How long a host session survives with no browser attached (page reloads). */
  resumeGraceMs: number;
  maxSessions: number;
  /** Name devices (or 3270 LUs) PREFIX01, PREFIX02, ...; unset lets the host assign names. */
  deviceNamePrefix?: string;
  /** Log every host record (VENEER_TRACE=true), for diagnosing host behaviour. */
  trace?: boolean;
  /** Allowed browser origins; empty means same-origin only. */
  allowedOrigins: string[];
  /** Directory of client files to serve, if any. */
  staticDir?: string;
  /** Directory of screen definition JSON files. */
  screensDir: string;
  /** Directory of custom component modules (served at /components/); unset means none. */
  componentsDir?: string;
  /** Where the built-in themes are; tests use a copy. Default: packages/server/themes. */
  builtinThemesDir?: string;
  /** Directory for what Veneer records itself (the screen inventory); unset keeps it in memory. */
  dataDir?: string;
  /** Bearer token for saving definitions from the designer. */
  designerToken?: string;
  /** Let browsers on this machine use the designer without the token (VENEER_DESIGNER=local). */
  designerLocal?: boolean;
  /** Bearer token for the admin page (sessions, errors). */
  adminToken?: string;
  /** Let browsers on this machine use the admin page without the token (VENEER_ADMIN=local). */
  adminLocal?: boolean;
  log: { level: string; file?: string; maxBytes: number; keep: number };
  /** Product name, logo and accent colors (VENEER_BRAND_*). */
  brand?: Brand;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // A fixed device name (VENEER_DEVNAME) can only be used by one session at a
  // time, so the server ignores it; see VENEER_DEVNAME_PREFIX.
  const host = hostSettingsFromEnv(env);

  // Validate the device name prefix now rather than on the first connection.
  if (env.VENEER_DEVNAME_PREFIX) new DeviceNamePool(env.VENEER_DEVNAME_PREFIX, deviceNameLength(hostTypeOf(host)));

  if (env.VENEER_DESIGNER_TOKEN !== undefined && env.VENEER_DESIGNER_TOKEN !== '' && env.VENEER_DESIGNER_TOKEN.length < 12) {
    throw new Error('VENEER_DESIGNER_TOKEN must be at least 12 characters');
  }

  const designer = env.VENEER_DESIGNER ?? '';
  if (designer !== '' && designer !== 'local') throw new Error(`VENEER_DESIGNER must be "local" or empty, got "${designer}"`);

  const adminToken = env.VENEER_ADMIN_TOKEN ?? '';
  if (adminToken !== '' && adminToken.length < 12) throw new Error('VENEER_ADMIN_TOKEN must be at least 12 characters');
  // Designers must not be able to end sessions, so the two tokens must differ.
  if (adminToken !== '' && adminToken === env.VENEER_DESIGNER_TOKEN) throw new Error('VENEER_ADMIN_TOKEN must differ from VENEER_DESIGNER_TOKEN');
  const admin = env.VENEER_ADMIN ?? '';
  if (admin !== '' && admin !== 'local') throw new Error(`VENEER_ADMIN must be "local" or empty, got "${admin}"`);

  const cert = env.VENEER_HTTPS_CERT, key = env.VENEER_HTTPS_KEY;
  if (Boolean(cert) !== Boolean(key)) throw new Error('Set both VENEER_HTTPS_CERT and VENEER_HTTPS_KEY, or neither');

  return {
    listenHost: env.VENEER_LISTEN_HOST || '127.0.0.1',
    listenPort: int(env, 'VENEER_LISTEN_PORT', 8080),
    ...(cert && key ? { https: { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } } : {}),
    host,
    idleTimeoutMs: int(env, 'VENEER_IDLE_TIMEOUT_MINUTES', 30) * 60_000,
    resumeGraceMs: int(env, 'VENEER_RESUME_GRACE_SECONDS', 60) * 1000,
    maxSessions: int(env, 'VENEER_MAX_SESSIONS', 100),
    ...(env.VENEER_DEVNAME_PREFIX ? { deviceNamePrefix: env.VENEER_DEVNAME_PREFIX } : {}),
    trace: env.VENEER_TRACE === 'true',
    allowedOrigins: (env.VENEER_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ...(staticDir(env) ? { staticDir: staticDir(env)! } : {}),
    screensDir: env.VENEER_SCREENS_DIR || fileURLToPath(new URL('../../../screens', import.meta.url)),
    componentsDir: env.VENEER_COMPONENTS_DIR || fileURLToPath(new URL('../../../components', import.meta.url)),
    dataDir: env.VENEER_DATA_DIR || fileURLToPath(new URL('../../../data', import.meta.url)),
    ...(env.VENEER_DESIGNER_TOKEN ? { designerToken: env.VENEER_DESIGNER_TOKEN } : {}),
    designerLocal: designer === 'local',
    ...(adminToken ? { adminToken } : {}),
    adminLocal: admin === 'local',
    brand: brandFromEnv(env),
    log: {
      level: env.VENEER_LOG_LEVEL || 'info',
      ...(env.VENEER_LOG_FILE ? { file: env.VENEER_LOG_FILE } : {}),
      maxBytes: int(env, 'VENEER_LOG_MAX_MB', 10) * 1024 * 1024,
      keep: int(env, 'VENEER_LOG_KEEP', 5),
    },
  };
}

/** VENEER_STATIC_DIR, else the built client next to this package (packages/client/dist). */
function staticDir(env: NodeJS.ProcessEnv): string | undefined {
  if (env.VENEER_STATIC_DIR) return env.VENEER_STATIC_DIR;
  const bundled = fileURLToPath(new URL('../../client/dist', import.meta.url));
  return fs.existsSync(bundled) ? bundled : undefined;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}
