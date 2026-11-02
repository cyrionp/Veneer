import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AIDS_3270, AIDS_5250, COMMON_AIDS, DeviceNameInUseError, fieldId, hostHasAid, isAidName } from '../src/index.ts';

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('key names: Enter, Clear, F1-F24, the 5250 keys and the 3270 PA keys', () => {
  for (const k of ['Enter', 'Clear', 'F1', 'F9', 'F10', 'F19', 'F24', 'Help', 'PageUp', 'PageDown', 'Print', 'RecordBackspace', 'PA1', 'PA2', 'PA3']) {
    assert.ok(isAidName(k), k);
  }
  for (const k of ['F0', 'F25', 'F01', 'enter', 'PA0', 'PA4', 'pa1', '', ' Enter', 1, null, undefined]) {
    assert.ok(!isAidName(k), String(k));
  }
  const all = [...COMMON_AIDS, ...AIDS_5250, ...AIDS_3270];
  assert.equal(new Set(all).size, all.length, 'no key is in two lists');
});

test('each host type has the shared keys and its own', () => {
  for (const k of ['Enter', 'Clear', 'F1', 'F24'] as const) assert.ok(hostHasAid('5250', k) && hostHasAid('3270', k), k);
  assert.deepEqual(AIDS_5250.map((k) => [hostHasAid('5250', k), hostHasAid('3270', k)]), AIDS_5250.map(() => [true, false]));
  assert.deepEqual(AIDS_3270.map((k) => [hostHasAid('5250', k), hostHasAid('3270', k)]), AIDS_3270.map(() => [false, true]));
});

test('field ids are row:col', () => {
  assert.equal(fieldId(6, 53), '6:53');
});

test('a name in use says which name', () => {
  const err = new DeviceNameInUseError('VENEER01');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'DeviceNameInUseError');
  assert.equal(err.deviceName, 'VENEER01');
});

/** Every .ts/.tsx file under a directory. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

test('only the server code that starts a session imports a host package', () => {
  const allowed = new Set(['server/src/host.ts']);
  const found: string[] = [];
  for (const pkg of fs.readdirSync(packages)) {
    const src = path.join(packages, pkg, 'src');
    if (pkg === 'tn5250' || pkg === 'tn3270' || !fs.existsSync(src)) continue;
    for (const file of sources(src)) {
      if (/from '@veneer\/tn(5250|3270)'/.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(packages, file));
    }
  }
  assert.deepEqual(found.filter((f) => !allowed.has(f)), []);
});

test('the two host packages do not depend on each other', () => {
  for (const [pkg, other] of [['tn5250', 'tn3270'], ['tn3270', 'tn5250']] as const) {
    for (const file of sources(path.join(packages, pkg, 'src'))) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(`@veneer/${other}`), path.relative(packages, file));
    }
  }
});

test('the terminal model loads in a browser: no Node modules at run time', () => {
  for (const file of sources(path.join(packages, 'terminal/src'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^import (type )?.*from '([^']+)';$/gm)) {
      if (m[2]!.startsWith('node:')) assert.ok(m[1], `${path.basename(file)} imports ${m[2]} at run time`);
    }
  }
});
