#!/usr/bin/env node
/*
  No link may reach the legacy settings page by URL shape.

  ## The invariant

  `app/(dashboard)/settings/general/page.tsx` branches on the shape of the URL,
  not on a route:

      return searchParams.has('tab') || hash ? <LegacySettingsPage /> : <OrganizationGeneral />;

  So `/settings/general` renders the reskinned screen, and the *same path* with
  any fragment or any `?tab=` renders roughly a thousand lines of the
  pre-reskin implementation. Nothing about the href looks wrong at the call
  site; the destination is decided by punctuation.

  Six links were tripping it. Five had a reskinned route that already existed
  -- /automations, /settings/channels twice, /settings/users -- and were simply
  never swept when 6c611177 renamed 106 files.

  ## Why this is a gate and not a nav-entry resolver

  The obvious check walks the navigation arrays and asserts every href resolves
  to a real route. That check passes on all six. Every one of these hrefs
  resolves: /settings/general is a real page. And three of the six are not nav
  entries at all -- they live in inbox components (composer-readiness,
  conversation-list-states) and in lib/gateway-state, which a nav walker would
  never open.

  The invariant is about URL *shape* reaching a *page*, so the gate reads every
  source file and looks for the shape.

  ## Comments count

  A match inside a comment fails too. That is deliberate: a URL written in a
  comment is a pointer the next person copies, and exempting comments would
  mean parsing them, which is the "per-line guard cannot see what a paragraph
  is about" failure this repository has already paid for once. Cheaper to keep
  the rule literal and fix the comment.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['app', 'components', 'lib'];
const EXTS = new Set(['.ts', '.tsx']);

/*
  Exemptions carry the reason, not just the path.

  `/billing` is the one caller with nowhere else to go: there is no
  /settings/billing route, so the subscription and usage sections exist only on
  the legacy page. Repointing it would be a link to a 404, which is worse than
  a link to an old screen.

  It is scheduled: the billing surface is the next commit, and when it lands
  this entry must be deleted. Check 3 makes that non-optional -- an exemption
  whose link no longer exists fails the gate, so the annotation cannot outlive
  the thing it justified.
*/
const EXEMPTIONS = [
  {
    file: 'app/(dashboard)/billing/page.tsx',
    shape: '/settings/general?tab=billing',
    reason: 'No /settings/billing route exists yet; subscription and usage live only on the legacy page. Retired by the billing commit.',
  },
];

const LEGACY = /\/settings\/general(#[A-Za-z0-9_-]+|\?tab=[A-Za-z0-9_-]+)/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const d of DIRS) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walk(full, files);
}

const findings = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(LEGACY)) {
      findings.push({ rel, line: i + 1, shape: m[0], text: line.trim() });
    }
  });
}

const isExempt = (f) => EXEMPTIONS.some((e) => e.file === f.rel && e.shape === f.shape);
const violations = findings.filter((f) => !isExempt(f));
const exempted = findings.filter(isExempt);

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail ? ': ' + detail : '')); }
}

console.log('Scanned ' + files.length + ' source files under ' + DIRS.join(', ') + '.');
console.log('');

check('1 · no link reaches the legacy settings page by fragment',
  violations.filter((v) => v.shape.includes('#')).length === 0,
  violations.filter((v) => v.shape.includes('#')).map((v) => v.rel + ':' + v.line + ' -> ' + v.shape).join('; '));

check('2 · no link reaches the legacy settings page by ?tab=',
  violations.filter((v) => v.shape.includes('?tab=')).length === 0,
  violations.filter((v) => v.shape.includes('?tab=')).map((v) => v.rel + ':' + v.line + ' -> ' + v.shape).join('; '));

const orphaned = EXEMPTIONS.filter(
  (e) => !findings.some((f) => f.rel === e.file && f.shape === e.shape),
);
check('3 · no exemption outlives the link it justified',
  orphaned.length === 0,
  orphaned.map((e) => e.file + ' -> ' + e.shape + ' (delete this exemption)').join('; '));

check('4 · the scan is not vacuous',
  files.length > 100,
  'only ' + files.length + ' files scanned — the walk is not reaching the source tree');

/*
  If the branch is gone the legacy page is unreachable by any shape, this whole
  class no longer exists, and this gate should be deleted rather than left
  passing over nothing.
*/
const generalPage = path.join(ROOT, 'app/(dashboard)/settings/general/page.tsx');
const branchLives = fs.existsSync(generalPage)
  && /searchParams\.has\('tab'\)\s*\|\|\s*hash/.test(fs.readFileSync(generalPage, 'utf8'));
check('5 · the URL-shape branch this gate exists for is still present',
  branchLives,
  'settings/general no longer branches on tab/hash — the legacy page is gone, so delete this gate');

console.log('');
if (exempted.length) {
  console.log('Exempted, with reasons:');
  for (const e of EXEMPTIONS) console.log('  ' + e.file + ' -> ' + e.shape + '\n    ' + e.reason);
  console.log('');
}
console.log(passed + '/' + (passed + failed) + ' checks passed.');
if (failed > 0) process.exitCode = 1;
