// npm run demo: a demo host plus the Veneer server, on http://127.0.0.1:8080.
// The demo IBM i (5250) by default; npm run demo -- --3270 (or
// VENEER_HOST_TYPE=3270) for the demo mainframe.

import { loadConfig } from '../src/config.ts';
import { log } from '../src/log.ts';
import { createServer } from '../src/server.ts';
import { DemoHost } from './demoHost.ts';
import { DemoHost3270 } from './demoHost3270.ts';
import { demoEnv, demoHostType } from './demoEnv.ts';

const type = demoHostType(process.argv.slice(2), process.env);
const hostPort = await (type === '3270' ? new DemoHost3270() : new DemoHost()).listen();
const config = loadConfig(demoEnv(type, hostPort, process.env));
const server = createServer(config);
const addr = await server.listen();
log.info('demo ready', {
  url: `http://${addr.address}:${addr.port}`,
  host: type === '3270' ? 'demo mainframe (3270)' : 'demo IBM i (5250)',
  client: config.staticDir ?? 'not built (npm run build)',
  screens: config.screensDir,
  designer: config.designerLocal ? 'no token needed from this machine' : 'off',
  admin: config.adminLocal ? `http://${addr.address}:${addr.port}/admin` : 'off',
});
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
