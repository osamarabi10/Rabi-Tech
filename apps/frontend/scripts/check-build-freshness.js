#!/usr/bin/env node
/*
  The production build must be newer than the source it is built from.

  ## Why this runs inside test:e2e and not beside it

  playwright.config.ts starts the suite with `npx next start`, which serves
  whatever .next already holds. There is no build in that path and no pretest
  hook, so a frontend source change that was not rebuilt is tested as the
  PREVIOUS build -- silently, and with every assertion still green, because the
  tests are correct about a product that is one edit out of date.

  That is a precondition, and this gate is wired in front of playwright rather
  than listed next to it deliberately. test:e2e already carries three
  preconditions nobody wrote down -- a running backend, Redis, and
  RABITECH_E2E_SESSION -- and each of them cost a full misdiagnosis before it
  was found. A fourth that depends on somebody remembering it is a fourth
  outage waiting. Preconditions belong in the command, not in the prose.

  ## What is compared

  .next/BUILD_ID against the newest mtime under the compiled source tree.

  BUILD_ID rather than a JavaScript chunk because it is one file with a stable
  path. If next writes it before the last chunk, this reference is slightly
  OLD, which biases the check toward complaining when it did not need to --
  the safe direction for a gate whose failure mode is a false green.

  tests/ is excluded on purpose: Playwright reads spec files off disk at run
  time, so a spec change needs no rebuild. Excluding it is what keeps this from
  demanding a four-minute build every time an assertion is edited, which is how
  a checker teaches people to skip it. scripts/ is excluded for the same
  reason -- gate scripts are not compiled into the app.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILD_ID = path.join(ROOT, '.next', 'BUILD_ID');

const SOURCE_DIRS = ['app', 'components', 'lib'];
const SOURCE_FILES = ['next.config.js', 'tailwind.config.ts', 'postcss.config.js', 'proxy.ts'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css']);

function fail(message, detail) {
  console.error('');
  console.error('  BUILD IS STALE — ' + message);
  if (detail) console.error(detail);
  console.error('');
  console.error('  test:e2e serves .next through `next start`. Running it now would');
  console.error('  test the previous build and report a green that means nothing.');
  console.error('');
  console.error('  Fix:  npm run build');
  console.error('');
  process.exit(1);
}

if (!fs.existsSync(BUILD_ID)) {
  fail('there is no production build at all (.next/BUILD_ID is missing).');
}

const builtAt = fs.statSync(BUILD_ID).mtimeMs;

let newest = { file: null, mtime: 0 };
function consider(file) {
  const m = fs.statSync(file).mtimeMs;
  if (m > newest.mtime) newest = { file, mtime: m };
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (SOURCE_EXTS.has(path.extname(entry.name))) consider(full);
  }
}

for (const d of SOURCE_DIRS) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walk(full);
}
for (const f of SOURCE_FILES) {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full)) consider(full);
}

if (!newest.file) {
  fail('no source files were found — this check is not looking where it thinks it is.');
}

if (newest.mtime > builtAt) {
  const rel = path.relative(ROOT, newest.file).split(path.sep).join('/');
  const drift = Math.round((newest.mtime - builtAt) / 1000);
  fail(
    'source is newer than the build.',
    '\n  newest source : ' + rel + '\n'
      + '                  ' + new Date(newest.mtime).toISOString() + '\n'
      + '  built         : ' + new Date(builtAt).toISOString() + '\n'
      + '  drift         : ' + drift + 's',
  );
}

const rel = path.relative(ROOT, newest.file).split(path.sep).join('/');
console.log('build freshness: .next is newer than every compiled source file (newest: ' + rel + ').');
