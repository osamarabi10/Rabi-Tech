/**
 * Is a compromised credential sitting in the public repository?
 *
 * ## Why this gate exists
 *
 * `.claude/settings.local.json` was tracked. Inside its recorded permission
 * entries were the literal `dev-admin-key` and a live OpenWA webhook secret —
 * in a repository that is deliberately public. Nobody decided to publish them;
 * a broad `git add` swept the file in, exactly as `9a458795` swept in a
 * migration. Nothing was watching, so it stayed for as long as nobody looked.
 *
 * `verify-secrets.ts` already refuses to boot on a weak credential. It reads
 * `process.env`, which is the running machine — it cannot see the repository,
 * so it could never have caught this. That is the gap: the guard checked the
 * process, and the leak was in the tree.
 *
 * ## The question this asks
 *
 * Not "does this machine have good secrets" — that is the other guard's job.
 * This asks: **is a compromised credential in the public repository?** So the
 * file list comes from `git ls-files`, never a filesystem walk. A local `.env`
 * is not the repository and must not trip this; a tracked `.env.example` is.
 *
 * ## Three checks, deliberately different in scope
 *
 * 1. **Compromised values, repo-wide, no exceptions.** High-entropy strings
 *    known to have leaked. A real secret has no legitimate reason to appear in
 *    any tracked file, prose included, so this check has no allowlist.
 *
 * 2. **Known-weak values in credential assignments, configuration files only.**
 *    The denylist is `KNOWN_WEAK` in `verify-secrets.ts` — parsed, not copied.
 *    Scoped to config because the same words appear legitimately everywhere
 *    else: `rabitech` is the project name, `password` is a parameter name in
 *    `backup.service.ts`, and `verify-secrets.ts` names every weak value in its
 *    own declaration. A gate that flagged those would be noise, and noise is
 *    how a security check gets ignored.
 *
 * 3. **`ALLOW_INSECURE_SECRETS` must not ship as `1`.** It is the escape hatch
 *    that turns check 2's runtime twin off. A shipped default disabling the
 *    secrets guard is how the guard ends up off everywhere.
 *
 * ## The secret is stored as a hash, and that is not decoration
 *
 * Writing the leaked webhook secret into this file would move it from one
 * tracked file to another and leave it just as public — untracking it in the
 * same commit that re-commits it. So check 1 matches SHA-256 digests. The gate
 * can recognise a secret it does not contain.
 *
 * ## What this check cannot see
 *
 * It reads the working tree for paths `git ls-files` reports, so it describes
 * the commit you are about to make, not the one you already made. **Untracking
 * removes nothing from history.** Every value named here is permanently public
 * and must be rotated, not deleted.
 *
 * And a denylist only knows what it has been told. A brand-new secret pasted
 * into a tracked file passes cleanly. This gate stops known values recurring;
 * it is not a general secret detector.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/*
  Known-compromised values, by digest. The value itself is deliberately absent.

  Adding one: hash it somewhere that is not a tracked file, paste the digest,
  and write down where it leaked and that it needs rotating. Never paste the
  value, or this gate becomes the leak.
*/
const COMPROMISED = {
  '55e7e870157725e8108598ef649985b8d94302ebcd11e1dd740fcd4ea0ac2511':
    'OpenWA webhook secret — was in .claude/settings.local.json while tracked; public in history, must be rotated',
};

/*
  A control value with no secret meaning, used to prove the detector works on
  every run. Without it, an empty COMPROMISED table or a broken tokeniser would
  read as "nothing found" — the failure mode where a security gate reports
  green because it is looking at nothing.
*/
const CONTROL_DIGEST = 'fe6339c3d789d2b1fcc62a6aa96a200d0dced7f781eaf3e1880290a7b90f546b';
const CONTROL_VALUE = ['canary', 'secret', 'scan', 'self', 'test', 'do', 'not', 'use'].join('-');

/** Configuration, where a weak credential value is a shipped default rather than prose. */
function isConfigFile(rel) {
  return /(^|\/)\.env(\.|$)/.test(rel)
    || /(^|\/)docker-compose[^/]*\.ya?ml$/.test(rel)
    || /\.compose\.ya?ml$/.test(rel)
    || /^\.github\/workflows\/.+\.ya?ml$/.test(rel)
    || /(^|\/)Dockerfile[^/]*$/.test(rel)
    || /\.(toml|ini|conf|cfg)$/.test(rel)
    || /^\.claude\//.test(rel);
}

/**
 * Weak values that are correct where they sit. Each is a decision, not an
 * oversight, and each is checked below for still being true.
 */
const WEAK_VALUE_EXCEPTIONS = {
  '.env.example': {
    values: ['password'],
    reason: 'placeholder in DATABASE_URL=postgresql://USER:PASSWORD@... — the template that tells you what to replace',
  },
  '.github/workflows/tenancy-bleed.yml': {
    values: ['secret'],
    reason: 'password of a throwaway CI service container that exists for one job and is reachable by nothing',
  },
};

const CREDENTIAL_KEY = /(KEY|SECRET|PASSWORD|PASSWD|PWD|TOKEN|CREDENTIAL|AUTH|APIKEY|PASS)$/i;

// ── the denylist, parsed from the runtime guard so there is one copy ──────────
const guardPath = path.join(ROOT, 'apps', 'backend', 'src', 'lib', 'verify-secrets.ts');
const guardSource = fs.existsSync(guardPath) ? fs.readFileSync(guardPath, 'utf8') : '';
const weakMatch = guardSource.match(/const KNOWN_WEAK = new Set\(\[([\s\S]*?)\]\)/);
const KNOWN_WEAK = weakMatch
  ? [...weakMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1].toLowerCase())
  : [];

/*
  The parse is the weakest link in this file, so it is asserted rather than
  trusted. If `verify-secrets.ts` is renamed, restructured, or its Set switched
  to another literal form, an unguarded parse would return `[]` and every check
  below would pass while looking at nothing. These three turn that into a
  failure that names itself.
*/
check('denylist: KNOWN_WEAK was found in verify-secrets.ts',
  weakMatch !== null,
  'the Set literal did not parse — reuse is broken, fix the parse before trusting this gate');
check('denylist: it parsed to a plausible number of entries',
  KNOWN_WEAK.length >= 8,
  'parsed ' + KNOWN_WEAK.length + ' entries');
check('denylist: it still contains its anchors',
  ['dev-admin-key', 'secret', 'changeme'].every((a) => KNOWN_WEAK.includes(a)),
  'parsed: ' + KNOWN_WEAK.join(', '));

const weakSet = new Set(KNOWN_WEAK);

// ── the tracked file list ────────────────────────────────────────────────────
const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28,
}).split('\0').filter(Boolean);

check('scope: the tracked file list is non-empty', tracked.length > 0);

/** Every token that could be a credential. */
function tokensOf(text) {
  return text.match(/[A-Za-z0-9_\-]{8,160}/g) || [];
}

function scanForDigests(text, digests) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const token of tokensOf(lines[i])) {
      const digest = sha256(token);
      if (digests[digest] !== undefined) hits.push({ line: i + 1, digest });
    }
  }
  return hits;
}

/*
  Self-test. Proves tokenisation, hashing and matching all work on a value that
  is not a secret, before any of it is trusted on values that are. A gate that
  has never been seen to fire is indistinguishable from one that cannot.
*/
const controlHits = scanForDigests(
  'some noise\nAPI_KEY="' + CONTROL_VALUE + '"\nmore noise\n',
  { [CONTROL_DIGEST]: 'control' },
);
check('self-test: the detector finds a planted control value', controlHits.length === 1,
  'found ' + controlHits.length);
check('self-test: and finds nothing in clean text',
  scanForDigests('nothing to see here\nAPI_KEY="fine"\n', { [CONTROL_DIGEST]: 'control' }).length === 0);
check('self-test: the compromised table is not empty',
  Object.keys(COMPROMISED).length > 0,
  'an empty table would make check 1 pass by looking at nothing');

// ── the scan ─────────────────────────────────────────────────────────────────
const compromisedFindings = [];
const weakFindings = [];
const flagFindings = [];
const exceptionsHit = new Set();
let scanned = 0;
const unreadable = [];

for (const rel of tracked) {
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { unreadable.push(rel); continue; }
  if (buf.includes(0)) continue;   // binary; no credential is stored this way here
  const text = buf.toString('utf8');
  scanned += 1;

  for (const hit of scanForDigests(text, COMPROMISED)) {
    compromisedFindings.push({ rel, line: hit.line, reason: COMPROMISED[hit.digest] });
  }

  if (!isConfigFile(rel)) continue;
  const exception = WEAK_VALUE_EXCEPTIONS[rel];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const note = (key, value) => {
      if (exception && exception.values.includes(value)) { exceptionsHit.add(rel + '::' + value); return; }
      weakFindings.push({ rel, line: i + 1, key, value });
    };

    // KEY=value / KEY: value, where the key names a credential.
    for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]{2,40})\s*[:=]\s*["']?([A-Za-z0-9_\-]{3,64})["']?/g)) {
      if (CREDENTIAL_KEY.test(m[1]) && weakSet.has(m[2].toLowerCase())) note(m[1], m[2].toLowerCase());
    }
    // A password embedded in a connection string — the same shape verify-secrets.ts checks.
    for (const m of line.matchAll(/:\/\/[^:\s/]+:([^@\s]+)@/g)) {
      if (weakSet.has(m[1].toLowerCase())) note('url-embedded', m[1].toLowerCase());
    }
    // The escape hatch. `${VAR:-0}` resolves to its default; a bare value is itself.
    for (const m of line.matchAll(/(?<![\w${])ALLOW_INSECURE_SECRETS\s*[:=]\s*([^\s#]*)/g)) {
      const raw = m[1] || '';
      const shellDefault = raw.match(/^\$\{[^:}]*:-([^}]*)\}$/);
      const value = (shellDefault ? shellDefault[1] : raw).replace(/^["']|["']$/g, '').trim();
      if (value !== '' && value !== '0') flagFindings.push({ rel, line: i + 1, value });
    }
  }
}

console.log('');
check('scan: read every tracked file it needed to',
  unreadable.length === 0,
  unreadable.join(', '));

check('1 · no known-compromised credential appears in any tracked file',
  compromisedFindings.length === 0,
  compromisedFindings.map((f) => f.rel + ':' + f.line + ' — ' + f.reason).join('; '));

check('2 · no known-weak credential value is assigned in a tracked config file',
  weakFindings.length === 0,
  weakFindings.map((f) => f.rel + ':' + f.line + ' ' + f.key + '=' + f.value).join('; '));

check('3 · ALLOW_INSECURE_SECRETS does not ship enabled in any tracked file',
  flagFindings.length === 0,
  flagFindings.map((f) => f.rel + ':' + f.line + ' =' + f.value).join('; '));

/*
  The exception list has to stay honest too. An entry for a file that no longer
  exists, or for a value that no longer appears in it, is a stale excuse — and
  the next reader takes a stale excuse as a current decision.
*/
const staleExceptions = [];
for (const [rel, entry] of Object.entries(WEAK_VALUE_EXCEPTIONS)) {
  if (!tracked.includes(rel)) { staleExceptions.push(rel + ' (not tracked)'); continue; }
  for (const value of entry.values) {
    if (!exceptionsHit.has(rel + '::' + value)) staleExceptions.push(rel + '::' + value + ' (no longer present)');
  }
}
check('exceptions: every documented exception is still real',
  staleExceptions.length === 0,
  staleExceptions.join(', '));

console.log('');
console.log('Scanned ' + scanned + ' of ' + tracked.length + ' tracked files ('
  + (tracked.length - scanned) + ' binary or unreadable).');
console.log(passed + '/' + (passed + failed) + ' checks passed.');
if (failed > 0) {
  console.log('');
  console.log('A finding here is public. Untracking does not undo it — rotate the value.');
  process.exitCode = 1;
}
