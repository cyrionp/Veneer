import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AIDS_5250, COMMON_AIDS, DeviceNameInUseError, fieldId, isAidName } from '../src/index.ts';

const packages = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('key names: Enter, Clear, F1-F24 and the 5250 keys', () => {
  for (const k of ['Enter', 'Clear', 'F1', 'F9', 'F10', 'F19', 'F24', 'Help', 'PageUp', 'PageDown', 'Print', 'RecordBackspace']) {
    assert.ok(isAidName(k), k);
  }
  for (const k of ['F0', 'F25', 'F01', 'enter', 'PA1', '', ' Enter', 1, null, undefined]) {
    assert.ok(!isAidName(k), String(k));
  }
  assert.deepEqual(COMMON_AIDS.filter((k) => (AIDS_5250 as readonly string[]).includes(k)), []);
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

test('only the server code that starts a 5250 session imports tn5250', () => {
  const allowed = new Set(['server/src/sessions.ts', 'server/src/config.ts']);
  const found: string[] = [];
  for (const pkg of fs.readdirSync(packages)) {
    const src = path.join(packages, pkg, 'src');
    if (pkg === 'tn5250' || !fs.existsSync(src)) continue;
    for (const file of sources(src)) {
      if (/from '@veneer\/tn5250'/.test(fs.readFileSync(file, 'utf8'))) found.push(path.relative(packages, file));
    }
  }
  assert.deepEqual(found.filter((f) => !allowed.has(f)), []);
});

test('the terminal model loads in a browser: no Node modules at run time', () => {
  for (const file of sources(path.join(packages, 'terminal/src'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/^import (type )?.*from '([^']+)';$/gm)) {
      if (m[2]!.startsWith('node:')) assert.ok(m[1], `${path.basename(file)} imports ${m[2]} at run time`);
    }
  }
});
