/**
 * Exemption from the auth middleware must never mean exemption from tenant scope.
 *
 * ## Why this gate exists
 *
 * `index.ts` exempts paths from authentication by string comparison, and until
 * now nothing asserted that list was what it should be. It was found while
 * designing Growth Widgets, which needs a public redirect endpoint — so the
 * list was about to grow by one, through a mechanism no gate was watching.
 * Gating it afterwards would have meant the first thing this gate certified was
 * a surface that had never been checked.
 *
 * ## Why this is not a snapshot test
 *
 * "These are the nine paths" would go red on every legitimate edit, which
 * teaches people that the fix for a red gate is to update the expected value.
 * Worse, it cannot tell a safe addition from a dangerous one: both are one `if`
 * and one `return next()`, and the difference between them is not in the diff.
 *
 * The difference is *why*. The exempt paths are three kinds:
 *
 *   Category 1 — genuinely public. There is no tenant to scope to. `/auth`
 *   runs before a session exists; `/billing/plans` before an account does.
 *
 *   Category 2 — scoped somewhere else. `/api/v1` authenticates with a bearer
 *   token and enters `runAsOrganization` inside `apiTokenAuth`. It is exempt
 *   from *this* middleware, not from being authenticated — the code comment has
 *   said so for as long as the branch has existed.
 *
 *   Category 3 — public, tenant-derived. The growth-widget redirect: its token
 *   is printed on posters and authenticates nobody, yet it writes a tenant-owned
 *   row. Public like category 1, scoped like category 2, and neither. Because
 *   its caller is anonymous AND it writes, it carries three obligations the
 *   others do not: rate-limited, append-only, and never taking a tenant id from
 *   the request. Check 9 asserts all three.
 *
 * The dangerous edit is a path added in the belief that it is category 2 when
 * nothing downstream scopes it. So each branch declares its category, and for
 * category 2 the chain that establishes scope — which is checked to exist and
 * to end in a real `runAsOrganization` or `runAsPlatform` call.
 *
 * ## What each check is for
 *
 * Every exempt branch has an annotation, and every annotation has a branch.
 * The first half catches a new exemption slipped in without justification. The
 * second is the stale-excuse rule this repository already applies to the
 * analytics allowlist: a justification must not outlive the thing it justified,
 * because the next reader takes a leftover comment as a current decision.
 *
 * The category-2/3 chain check is the one that covers the actual invariant, and
 * check 9 covers what category 3 adds. The rest is bookkeeping.
 *
 * ## What this check cannot see
 *
 * It reads source, so it can prove a scope call exists on the path and cannot
 * prove it runs on every request through it. And **category 1 is unverifiable
 * by construction** — "genuinely public, nothing to scope to" is a claim about
 * intent. The gate can force that claim to be written down and attached to the
 * branch making it; it cannot check that it is true. So a wrong category-1
 * annotation still passes here. What it costs the author is the sentence, which
 * is the point at which most people notice they cannot write one.
 */
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const SRC = path.join(__dirname, '..', 'src');
const INDEX = path.join(SRC, 'index.ts');
const lines = fs.readFileSync(INDEX, 'utf8').split(/\r?\n/);

/** The primitives that put a request inside a scope. Nothing else counts. */
const SCOPE_PRIMITIVES = ['runAsOrganization', 'runAsPlatform'];

// ── locate the middleware ────────────────────────────────────────────────────
const startIndex = lines.findIndex((l) => /^app\.use\('\/api',\s*\(req,\s*res,\s*next\)\s*=>\s*\{/.test(l));
let endIndex = -1;
if (startIndex !== -1) {
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (/^\}\);\s*$/.test(lines[i])) { endIndex = i; break; }
  }
}

check('locate: the /api auth middleware was found in index.ts',
  startIndex !== -1 && endIndex !== -1,
  'start=' + startIndex + ' end=' + endIndex + ' — the parser is looking at nothing, fix it before trusting anything below');

if (startIndex === -1 || endIndex === -1) {
  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  process.exitCode = 1;
  return;
}

const body = lines.slice(startIndex + 1, endIndex);
const bodyOffset = startIndex + 2;           // 1-based line number of body[0]
const lineNo = (i) => bodyOffset + i;

// ── find every branch that lets a request past ───────────────────────────────
/** A branch is an exemption if it returns next(), or hands off without verifyToken. */
const EXEMPTING = /^\s*return (next\(\)|verifyPlatformToken\()/;

const sites = [];
for (let i = 0; i < body.length; i++) {
  if (!/^ {2}if \(/.test(body[i])) continue;
  let close = -1;
  for (let j = i + 1; j < body.length; j++) {
    if (/^ {2}\}/.test(body[j])) { close = j; break; }
  }
  if (close === -1) continue;
  const block = body.slice(i, close + 1);
  if (block.some((l) => EXEMPTING.test(l))) sites.push({ ifIndex: i, close });
}

check('scan: found the exempting branches',
  sites.length >= 5,
  'found ' + sites.length + ' — too few to be the real middleware; the parser has drifted');

// ── each branch must carry an annotation directly above it ───────────────────
function annotationAbove(ifIndex) {
  let i = ifIndex - 1;
  while (i >= 0 && body[i].trim() === '') i -= 1;
  if (i < 0 || !/^\s*\*\/\s*$/.test(body[i])) return null;   // must close a block comment
  const end = i;
  while (i >= 0 && !/^\s*\/\*\*\s*$/.test(body[i])) i -= 1;
  if (i < 0) return null;
  return { start: i, end, text: body.slice(i, end + 1) };
}

/** Tag values, with continuation lines folded in. */
function parseAnnotation(text) {
  const out = {};
  let current = null;
  for (const raw of text) {
    const line = raw.replace(/^\s*\/?\*+\/?\s?/, '').replace(/\s+$/, '');
    const tag = line.match(/^@([a-z-]+)\s*(.*)$/);
    if (tag) { current = tag[1]; out[current] = tag[2].trim(); continue; }
    if (current && line.trim()) out[current] = (out[current] + ' ' + line.trim()).trim();
  }
  return out;
}

const annotated = [];
const missing = [];

for (const site of sites) {
  const found = annotationAbove(site.ifIndex);
  if (!found) { missing.push('index.ts:' + lineNo(site.ifIndex) + '  ' + body[site.ifIndex].trim()); continue; }
  annotated.push({ ...site, ...found, tags: parseAnnotation(found.text) });
}

check('1 · every exempting branch carries an @auth-exempt annotation',
  missing.length === 0,
  missing.join('; '));

// ── the annotation has to say something ──────────────────────────────────────
const badCategory = [];
const badReason = [];
const badPath = [];

for (const entry of annotated) {
  const at = 'index.ts:' + lineNo(entry.ifIndex);
  const declaredPath = entry.tags['auth-exempt'];
  const category = entry.tags.category;
  const reason = entry.tags.reason || '';

  if (!/^[123]$/.test(category || '')) badCategory.push(at + ' category=' + JSON.stringify(category || null));
  if (reason.trim().length < 40) badReason.push(at + ' reason is ' + reason.trim().length + ' chars');

  // The declared path must actually appear in the condition it sits above,
  // or the annotation is describing a branch that no longer matches it.
  const condition = body.slice(entry.ifIndex, entry.close + 1).join(' ');
  if (!declaredPath || !condition.includes("'" + declaredPath)) {
    badPath.push(at + ' declares ' + JSON.stringify(declaredPath || null) + ', which is not in its own condition');
  }
}

check('2 · every annotation declares category 1, 2 or 3', badCategory.length === 0, badCategory.join('; '));
check('3 · every annotation gives a real reason', badReason.length === 0, badReason.join('; '));
check('4 · every declared path appears in the condition below it', badPath.length === 0, badPath.join('; '));

// ── category 2: the scope chain must exist and end in a scope call ───────────
const chainProblems = [];
const category1WithScope = [];
let category2Count = 0;

for (const entry of annotated) {
  const at = 'index.ts:' + lineNo(entry.ifIndex) + ' (' + entry.tags['auth-exempt'] + ')';
  const scope = entry.tags.scope;

  if (entry.tags.category === '1') {
    if (scope) category1WithScope.push(at + ' is category 1 but declares a scope chain');
    continue;
  }
  if (entry.tags.category !== '2' && entry.tags.category !== '3') continue;
  category2Count += 1;

  if (!scope) { chainProblems.push(at + ' is category 2 and declares no @scope chain'); continue; }

  const links = scope.split('->').map((s) => s.trim()).filter(Boolean);
  if (links.length === 0) { chainProblems.push(at + ' has an empty @scope chain'); continue; }

  links.forEach((link, index) => {
    const parts = link.split('::');
    if (parts.length !== 2) { chainProblems.push(at + ' malformed link ' + JSON.stringify(link)); return; }
    const [rel, symbol] = parts.map((s) => s.trim());
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) { chainProblems.push(at + ' names ' + rel + ', which does not exist'); return; }
    const source = fs.readFileSync(abs, 'utf8');

    const isLast = index === links.length - 1;
    if (isLast) {
      // The end of the chain is the whole point: it must be a scope primitive,
      // and it must be *called*, not merely mentioned in a comment.
      if (!SCOPE_PRIMITIVES.includes(symbol)) {
        chainProblems.push(at + ' chain ends in ' + symbol + ', which is not one of ' + SCOPE_PRIMITIVES.join('/'));
        return;
      }
      if (!new RegExp('\\b' + symbol + '\\s*\\(').test(source)) {
        chainProblems.push(at + ' declares scope via ' + symbol + ' in ' + rel + ', but nothing there calls it');
      }
      return;
    }
    if (!new RegExp('\\b' + symbol + '\\b').test(source)) {
      chainProblems.push(at + ' names ' + symbol + ' in ' + rel + ', which does not reference it');
    }
  });
}

check('5 · every category-2/3 path reaches a scope-establishing call',
  chainProblems.length === 0,
  chainProblems.join('; '));

/*
  Category 3 — public, tenant-derived — carries three obligations the other two
  do not, because its caller is anonymous *and* it writes. Nothing else exempt
  from this middleware does both.

  The invariants: the tenant must come from a server-side lookup rather than
  from the request; the endpoint must be rate-limited; and it must only append.
  The third is why a category-3 handler lives in a file of its own — this check
  reads the whole file, so anything else in it would make the assertion
  meaningless.
*/
const PRISMA_MUTATIONS = /\.(update|updateMany|delete|deleteMany|upsert)\s*\(/;
const TENANT_FROM_REQUEST = /req\.(params|query|body)[^\n]{0,40}organizationId|organizationId[^\n]{0,20}req\.(params|query|body)/;

const category3Problems = [];
let category3Count = 0;

for (const entry of annotated) {
  if (entry.tags.category !== '3') continue;
  category3Count += 1;
  const at = 'index.ts:' + lineNo(entry.ifIndex) + ' (' + entry.tags['auth-exempt'] + ')';

  // The rate limit must be declared, must exist in the LIMITS table, and must
  // actually be mounted. A key that exists and is never applied is the
  // declared-but-unreachable defect wearing a rate limiter.
  const limitKey = entry.tags.ratelimit;
  if (!limitKey) {
    category3Problems.push(at + ' is category 3 and declares no @ratelimit');
  } else {
    const limitsSource = fs.readFileSync(path.join(SRC, 'middleware', 'rate-limit.middleware.ts'), 'utf8');
    if (!new RegExp('\\b' + limitKey + '\\s*:\\s*rateLimit\\s*\\(').test(limitsSource)) {
      category3Problems.push(at + ' declares @ratelimit ' + limitKey + ', which is not in the LIMITS table');
    }
    if (!new RegExp('app\\.use\\([^)]*LIMITS\\.' + limitKey + '\\b').test(lines.join('\n'))) {
      category3Problems.push(at + ' declares @ratelimit ' + limitKey + ', which is never mounted');
    }
  }

  // The handler files named by the scope chain are the ones that must behave.
  const files = (entry.tags.scope || '').split('->')
    .map((l) => l.split('::')[0].trim()).filter(Boolean);
  for (const rel of [...new Set(files)]) {
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) continue;                  // already reported by check 5
    const source = fs.readFileSync(abs, 'utf8');
    if (PRISMA_MUTATIONS.test(source)) {
      category3Problems.push(at + ' handler ' + rel + ' updates or deletes; category 3 may only append');
    }
    if (TENANT_FROM_REQUEST.test(source)) {
      category3Problems.push(at + ' handler ' + rel + ' takes an organizationId from the request');
    }
  }
}

check('9 · every category-3 path is rate-limited, append-only, and never takes a tenant from the caller',
  category3Problems.length === 0,
  category3Problems.join('; '));
check('6 · no category-1 path claims a scope chain it does not need',
  category1WithScope.length === 0,
  category1WithScope.join('; '));
check('   …and category 2 is not empty, which would make check 5 vacuous',
  category2Count > 0,
  'no category-2 entries were parsed');

// ── stale excuses: an annotation whose branch is gone ────────────────────────
const declaredCount = body.filter((l) => /@auth-exempt\b/.test(l)).length;
check('7 · no annotation outlives the branch it justified',
  declaredCount === annotated.length,
  declaredCount + ' @auth-exempt annotations for ' + annotated.length
    + ' annotated branches — the difference is orphaned justification');

// ── the default path still authenticates ─────────────────────────────────────
const tail = body.slice(sites.length ? sites[sites.length - 1].close : 0).join('\n');
check('8 · everything not exempted still goes through verifyToken into a tenant scope',
  /verifyToken\s*\(/.test(tail) && /runAsOrganization\s*\(/.test(tail),
  'the fallback branch no longer authenticates — every unlisted route would be open');

console.log('');
console.log('Checked ' + annotated.length + ' exempt paths ('
  + annotated.filter((e) => e.tags.category === '1').length + ' public, '
  + (category2Count - category3Count) + ' scoped elsewhere, '
  + category3Count + ' public tenant-derived) in index.ts.');
console.log(passed + '/' + (passed + failed) + ' checks passed.');
if (failed > 0) process.exitCode = 1;
