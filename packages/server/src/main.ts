// Entry point.
//   node packages/server/dist/main.js --config /path/to/veneer.env   (production)
//   npm start / npm run dev                                          (uses the repo's .env)
// VENEER_CONFIG can name the config file instead of --config.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ServerConfig } from './config.ts';
import { defaultPort, hostTypeOf } from './host.ts';
import { configureLog, log } from './log.ts';
import { createServer } from './server.ts';
import { VERSION } from './version.ts';

function configPath(argv: string[]): string | undefined {
  const i = argv.indexOf('--config');
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith('--config='))?.slice('--config='.length) ?? process.env.VENEER_CONFIG;
}

let config: ServerConfig;
const configFile = configPath(process.argv.slice(2));
try {
  if (configFile) {
    if (!fs.existsSync(configFile)) throw new Error(`config file not found: ${configFile}`);
    // Values already in the environment win, as with node --env-file.
    process.loadEnvFile(configFile);
  }
  config = loadConfig();
  configureLog(config.log);
} catch (err) {
  log.error('invalid configuration', { error: (err as Error).message });
  process.exit(1);
}

const server = createServer(config);
let addr;
try {
  addr = await server.listen();
} catch (err) {
  log.error('could not start', { error: (err as Error).message, port: config.listenPort });
  process.exit(1);
}
log.info('veneer listening', {
  version: VERSION,
  node: process.version,
  url: `${config.https ? 'https' : 'http'}://${addr.address}:${addr.port}`,
  host: `${config.host.host}:${defaultPort(config.host)}`,
  hostType: hostTypeOf(config.host),
  tls: Boolean(config.host.tls),
  screens: config.screensDir,
  designer: [config.designerLocal && 'local', config.designerToken && 'token'].filter(Boolean).join('+') || 'off',
});
// An install is replaced on upgrade (and its owner may not let the service write
// there), so a production server should keep what it writes somewhere else.
if (configFile || process.env.NODE_ENV === 'production') {
  const installDir = fileURLToPath(new URL('../../../', import.meta.url));
  const inside = (dir: string) => {
    const rel = path.relative(installDir, dir);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const dirs = [
    ['VENEER_SCREENS_DIR', config.screensDir],
    ['VENEER_DATA_DIR', config.dataDir],
    // Only a problem once someone has put components there.
    ...(config.componentsDir && fs.existsSync(config.componentsDir) ? [['VENEER_COMPONENTS_DIR', config.componentsDir]] : []),
  ].filter(([, dir]) => dir && inside(dir));
  for (const [name, dir] of dirs) {
    log.warn(`${name} is inside the install directory, which an upgrade replaces; set it to a directory outside it`, { dir, installDir });
  }
}
if (!config.https && config.listenHost !== '127.0.0.1' && config.listenHost !== 'localhost') {
  log.warn('serving plain HTTP on a network interface; sign-on passwords cross the network unencrypted. Set VENEER_HTTPS_CERT/KEY.');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info('shutting down', { signal });
    // Ending host sessions releases their IBM i devices; don't wait forever.
    setTimeout(() => process.exit(1), 10_000).unref();
    void server.close().then(() => process.exit(0));
  });
}
