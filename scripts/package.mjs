#!/usr/bin/env node
// Builds a self-contained release: release/veneer-<version>.tar.gz
// and the source code at the current commit: release/veneer-<version>-src.tar.gz
//
// The archive holds the compiled server, the built browser client and the
// production dependencies (pure JavaScript), so the target needs only Node.js:
// no compiler, no npm install, no internet access. Works for IBM i and Linux.
//
//   npm run package              build, then package
//   npm run package -- --skip-build
//   npm run package -- --no-archive  stop at release/veneer-<version>/ (the Docker build uses this)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `veneer-${version}`;
const releaseDir = path.join(root, 'release');
const stage = path.join(releaseDir, name);

function run(cmd, args, cwd = root) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function copy(from, to = from) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) throw new Error(`missing ${from}; run npm run build first`);
  fs.cpSync(src, path.join(stage, to), {
    recursive: true,
    filter: (p) => !p.endsWith('.tsbuildinfo'),
  });
}

if (!process.argv.includes('--skip-build')) run('npm', ['run', 'build']);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'deploy']) copy(f);
copy('.env.example', 'veneer.env.example');
// Ready-made components (map, bar chart, star rating): sites copy the ones they
// want into their components folder (README, "Custom components").
copy('packages/server/dev/components', 'examples/components');
// The built-in themes, which the server finds beside its dist/ folder.
copy('packages/server/themes');
for (const pkg of ['tn5250', 'screens', 'server', 'client']) {
  copy(`packages/${pkg}/package.json`);
  copy(`packages/${pkg}/dist`);
}

// Production dependencies only; workspace packages are linked from packages/.
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

if (process.argv.includes('--no-archive')) {
  console.log(`\n${path.relative(root, stage)}`);
  process.exit(0);
}

// Writes <archive>.sha256 and reports the archive's size and checksum.
function checksum(archive) {
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
  const mb = (fs.statSync(archive).size / 1024 / 1024).toFixed(1);
  console.log(`\n${path.relative(root, archive)} (${mb} MB)\nsha256 ${sha256}`);
}

const archive = path.join(releaseDir, `${name}.tar.gz`);
run('tar', ['-czf', archive, '-C', releaseDir, name]);

// The source as committed (uncommitted changes are not included), for people
// who build Veneer themselves or need the source alongside the release.
const source = path.join(releaseDir, `${name}-src.tar.gz`);
run('git', ['archive', '--format=tar.gz', `--prefix=${name}-src/`, '-o', source, 'HEAD']);

checksum(archive);
checksum(source);
