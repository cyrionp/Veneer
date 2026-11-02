// npm run demo: the demo IBM i plus the Veneer server, on http://127.0.0.1:8080.

import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { log } from '../src/log.ts';
import { createServer } from '../src/server.ts';
import { DemoHost } from './demoHost.ts';

const hostPort = await new DemoHost().listen();
const config = loadConfig({
  VENEER_SCREENS_DIR: fileURLToPath(new URL('./screens', import.meta.url)),
  VENEER_COMPONENTS_DIR: fileURLToPath(new URL('./components', import.meta.url)),
  VENEER_DESIGNER: 'local',
  VENEER_ADMIN: 'local',
  ...process.env,
  // The demo host is an IBM i (5250), whatever .env says.
  VENEER_HOST_TYPE: '5250', VENEER_TN3270E: '',
  VENEER_HOST: '127.0.0.1', VENEER_PORT: String(hostPort), VENEER_TLS: 'false',
});
const server = createServer(config);
const addr = await server.listen();
log.info('demo ready', {
  url: `http://${addr.address}:${addr.port}`,
  client: config.staticDir ?? 'not built (npm run build)',
  screens: config.screensDir,
  designer: config.designerLocal ? 'no token needed from this machine' : 'off',
  admin: config.adminLocal ? `http://${addr.address}:${addr.port}/admin` : 'off',
});
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
