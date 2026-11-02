// Developer CLI: connect to an IBM i, print screens, fill fields, press keys.
//   npm run cli            (settings from the repo-root .env)
//   VENEER_TRACE=traces/signon.jsonl npm run cli   (record raw 5250 records)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { AidName, ScreenSnapshot } from '@veneer/terminal';
import { hostSettingsFromEnv } from './config.ts';
import { Session } from './session.ts';

const env = process.env;
let settings;
try {
  settings = hostSettingsFromEnv(env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

let trace: ((dir: 'in' | 'out', rec: Buffer) => void) | undefined;
if (env.VENEER_TRACE) {
  fs.mkdirSync(path.dirname(env.VENEER_TRACE), { recursive: true });
  const out = fs.createWriteStream(env.VENEER_TRACE, { flags: 'a' });
  trace = (dir, rec) => out.write(JSON.stringify({ t: Date.now(), dir, hex: rec.toString('hex') }) + '\n');
  console.error(`Tracing records to ${env.VENEER_TRACE} (contains everything you type, including passwords)`);
}

const session = new Session({ ...settings, trace });

session.on('warning', (msg) => console.error(`[warn] ${msg}`));
session.on('close', (err) => {
  console.error(err ? `Disconnected: ${err.message}` : 'Disconnected.');
  process.exit(err ? 1 : 0);
});

const AIDS: Record<string, AidName> = {
  enter: 'Enter', help: 'Help', pgup: 'PageUp', pgdn: 'PageDown', print: 'Print', clear: 'Clear',
};
for (let n = 1; n <= 24; n++) AIDS[`f${n}`] = `F${n}` as AidName;

function render(snap: ScreenSnapshot): void {
  const inputs = snap.fields.filter((f) => !f.bypass);
  const rule = '+' + '-'.repeat(snap.cols) + '+';
  console.log(rule);
  snap.lines.forEach((line, r) => console.log(`|${line}| ${String(r + 1).padStart(2)}`));
  console.log(rule);
  console.log(`cursor ${snap.cursor.row},${snap.cursor.col}` + (snap.error ? `  ERROR: ${snap.error}` : ''));
  inputs.forEach((f, k) => {
    const kind = f.attr.nonDisplay ? ' (hidden)' : '';
    console.log(`  [${k + 1}] ${f.id} len=${f.length} ${f.shift}${kind} "${f.value}"`);
  });
}

console.error(`Connecting to ${settings.host} (${settings.tls ? 'TLS' : 'plain Telnet'})...`);
await session.connect();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log('Commands: <n>=<value>, enter, f1-f24, pgup, pgdn, help, sysreq, attn, reset, show, quit');

let snap = await session.waitForInput();
render(snap);
const staged: Record<string, string> = {};

while (true) {
  const line = (await rl.question('veneer> ')).trim();
  if (!line) continue;
  const assign = /^(\d+)=(.*)$/.exec(line);
  if (assign) {
    const f = snap.fields.filter((x) => !x.bypass)[Number(assign[1]) - 1];
    if (!f) console.log('No such field.');
    else staged[f.id] = assign[2]!;
    continue;
  }
  const cmd = line.toLowerCase();
  if (cmd === 'quit') { session.close(); break; }
  if (cmd === 'show') { render(session.snapshot()); continue; }
  if (cmd === 'reset') { session.reset(); render(session.snapshot()); continue; }
  if (cmd === 'sysreq') { session.systemRequest(); continue; }
  if (cmd === 'attn') { session.attention(); continue; }
  const aid = AIDS[cmd];
  if (!aid) { console.log('Unknown command.'); continue; }
  try {
    session.submit({ aid, fields: { ...staged } });
    for (const k of Object.keys(staged)) delete staged[k];
    snap = await session.waitForInput();
    render(snap);
  } catch (err) {
    console.log(`Error: ${(err as Error).message}`);
  }
}
