// The settings npm run demo runs with: the demo host on a local port, the demo
// screens and components, and the designer and admin page open to this machine.

import { fileURLToPath } from 'node:url';
import type { HostType } from '@veneer/terminal';

/** 3270 with --3270 or VENEER_HOST_TYPE=3270; otherwise the IBM i (5250) demo. */
export function demoHostType(argv: readonly string[], env: NodeJS.ProcessEnv): HostType {
  return argv.includes('--3270') || env.VENEER_HOST_TYPE === '3270' ? '3270' : '5250';
}

export function demoEnv(type: HostType, hostPort: number, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A terminal type for the other kind of host would not start, so it is dropped.
  const terminalType = env.VENEER_TERMINAL_TYPE ?? '';
  const fits = type === '3270' ? /^IBM-327[89]-/i.test(terminalType) : !/^IBM-327[89]-/i.test(terminalType);
  return {
    VENEER_SCREENS_DIR: fileURLToPath(new URL('./screens', import.meta.url)),
    VENEER_COMPONENTS_DIR: fileURLToPath(new URL('./components', import.meta.url)),
    VENEER_DESIGNER: 'local',
    VENEER_ADMIN: 'local',
    ...env,
    VENEER_HOST_TYPE: type,
    VENEER_TERMINAL_TYPE: fits ? terminalType : '',
    VENEER_TN3270E: type === '3270' ? env.VENEER_TN3270E ?? '' : '',
    // LU names are at most 8 characters: a longer 5250 device name prefix is dropped.
    VENEER_DEVNAME_PREFIX: type === '3270' && (env.VENEER_DEVNAME_PREFIX ?? '').length > 6 ? '' : env.VENEER_DEVNAME_PREFIX ?? '',
    VENEER_HOST: '127.0.0.1', VENEER_PORT: String(hostPort), VENEER_TLS: 'false',
  };
}
