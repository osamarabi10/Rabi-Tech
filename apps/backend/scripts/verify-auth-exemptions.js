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
 * ## Coverage, and how it was wrong
 *
 * This gate originally read only the `/api` auth middleware and reported "7
 * exempt paths" as though that were the unauthenticated surface. It was not.
 * `app.use('/', webhookRouter)` is mounted outside `/api`, so the middleware
 * never runs for it and the gate had no opinion about it — a coverage claim
 * that was quietly incomplete, which is worse than one that is openly partial.
 *
 * Checks 10 to 12 close that. Every route registered where the middleware
 * cannot reach it needs the same annotation, and **the annotated set must equal
 * the found set, both ways** — that equality is what makes this a coverage
 * guarantee rather than one more list somebody has to remember to update.
 *
 * Two ways a route escapes, and the second is nastier: its path may simply not
 * begin with `/api`, or it may begin with `/api` and be registered *above* the
 * middleware, which answers first because Express runs handlers in registration
 * order. `/api/billing/webhook` and `/api/network` are both the second kind and
 * read as protected precisely because of their prefix.
 *
 * **Category 4 — authenticated, no tenant data — currently has no members, and
 * that is the intended steady state.** It was created for `/api/network`, a
 * development helper returning this machine's LAN addresses behind
 * `verifyToken`. Nothing called it; its frontend caller had already been deleted
 * as a dead flow. It was removed rather than guarded, because guarding
 * preserves an endpoint with no consumer and leaves one more thing to reason
 * about on every audit of this list.
 *
 * The category is kept because the *rule* is the point. A category-4 surface
 * must not be **registered** in production at all — not registered and
 * refusing, which still announces that it exists — so it must sit inside a
 * `NODE_ENV` guard or carry a loud `@env-exempt` with a real reason. The guard
 * is read from the code, never from the annotation: a comment claiming
 * "development only" proves nothing. The handler must also name an auth
 * primitive and must not reach the database, so the moment it touches a table
 * the annotation is a lie and the gate says so.
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

/*
  ── Surfaces that never reach the middleware at all ──────────────────────────

  The gate above reads the /api auth middleware and reports on its exemptions.
  Until now that was presented as full coverage of the unauthenticated surface,
  and it was not: `app.use('/', webhookRouter)` is mounted outside /api, so the
  middleware never runs for it and the gate had no opinion about it. The
  previous commit's "7 exempt paths" was a coverage claim about a set that
  excluded, silently, every route registered elsewhere.

  Two ways a route escapes the middleware, and the second is the nastier:

    1. Its path does not begin with /api, so the middleware never matches.
    2. Its path *does* begin with /api, but it is registered **above** the
       middleware — Express runs handlers in registration order, so it answers
       first. `/api/billing/webhook` and `/api/network` are both like this, and
       they read as protected precisely because of their prefix.

  So the rule is not "outside the /api prefix". It is "never reaches the
  middleware", which is what the two clauses below compute.

  Rate-limiter mounts are excluded, and only those whose arguments are nothing
  but LIMITS entries. They register no handler and always call next().
*/
/*
  Leading whitespace is allowed on purpose. Category 4 requires a route to sit
  inside a `NODE_ENV` guard, which indents it — so an anchor of `^app\.` would
  make the gate mandate a guard that then hides the route from the gate. The
  rule and the parser have to agree about what a registration looks like.

  A quoted path is required, which is what keeps `app.use(helmet())` and
  `app.use(express.json(...))` out: they mount middleware, not routes.
*/
const REGISTRATION = /^\s*app\.(use|get|post|put|patch|delete|all)\(\s*'([^']+)'\s*(.*)$/;
const ONLY_LIMITERS = /^(?:LIMITS\.\w+\s*,\s*)*LIMITS\.\w+\s*\)\s*;?\s*$/;

const outsideSites = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(REGISTRATION);
  if (!m) continue;
  const [, , routePath, rest] = m;
  // The path is followed by ", handler..." — drop the separator before deciding
  // whether what remains is only rate limiters.
  const args = rest.trim().replace(/^,\s*/, '');
  if (ONLY_LIMITERS.test(args)) continue;                // a limiter, not a handler
  const beforeMiddleware = i < startIndex;
  const outsideApiPrefix = !routePath.startsWith('/api');
  if (!outsideApiPrefix && !beforeMiddleware) continue;   // the middleware covers it
  if (i === startIndex) continue;                        // the middleware itself
  outsideSites.push({ index: i, routePath });
}

check('scan: found the registrations that bypass the middleware',
  outsideSites.length >= 5,
  'found ' + outsideSites.length + ' — too few to be this file; the parser has drifted');

/** Same adjacency rule as the middleware branches: the annotation sits directly above. */
function annotationAboveLine(lineIndex) {
  let i = lineIndex - 1;
  // A one-line // comment may sit between the block and the route.
  while (i >= 0 && (lines[i].trim() === '' || /^\s*\/\/ /.test(lines[i]))) i -= 1;
  if (i < 0 || !/^\s*\*\/\s*$/.test(lines[i])) return null;
  const end = i;
  while (i >= 0 && !/^\s*\/\*\*\s*$/.test(lines[i])) i -= 1;
  if (i < 0) return null;
  return { text: lines.slice(i, end + 1) };
}

const outsideAnnotated = [];
const outsideMissing = [];
for (const site of outsideSites) {
  const found = annotationAboveLine(site.index);
  if (!found) { outsideMissing.push('index.ts:' + (site.index + 1) + '  ' + site.routePath); continue; }
  outsideAnnotated.push({ ...site, tags: parseAnnotation(found.text) });
}

check('10 · every route that bypasses the middleware carries an annotation',
  outsideMissing.length === 0,
  outsideMissing.join('; '));

/*
  The coverage guarantee, and the reason this is not simply another list to
  maintain: the annotated set must equal the found set, checked both ways. A new
  router mounted outside /api fails because nothing annotates it; an annotation
  whose route was deleted fails because nothing matches it.
*/
const matchedAnnotationLines = new Set(outsideAnnotated.map((e) => e.index));
const orphanAnnotations = [];
for (let i = 0; i < startIndex; i++) {
  // Only `/** */` blocks count. The middleware's own header is a `/* */` block
  // that documents the vocabulary and names @auth-exempt without being one.
  if (!/^\s*\/\*\*\s*$/.test(lines[i])) continue;
  let end = i;
  while (end < startIndex && !/^\s*\*\/\s*$/.test(lines[end])) end += 1;
  const block = lines.slice(i, end + 1);
  if (!block.some((l) => /@auth-exempt\b/.test(l))) { i = end; continue; }

  let next = end + 1;
  while (next < lines.length && (lines[next].trim() === '' || /^\s*\/\/ /.test(lines[next]))) next += 1;
  if (!matchedAnnotationLines.has(next)) {
    orphanAnnotations.push('index.ts:' + (i + 1) + ' annotates ' + (lines[next] || '').trim().slice(0, 50));
  }
  i = end;
}

/*
  Deliberately the orphan direction only. Check 10 already covers a route with
  no annotation; folding both into one condition made a single fault report as
  two failures, which pads the count and misleads anyone reading the mutation
  that produced it. Together the two checks are the equality — separately each
  names one side of it.
*/
check('11 · no annotation is left above a route that no longer bypasses the middleware',
  orphanAnnotations.length === 0,
  orphanAnnotations.join('; '));

const outsideProblems = [];
for (const entry of outsideAnnotated) {
  const at = 'index.ts:' + (entry.index + 1) + ' (' + entry.routePath + ')';
  const category = entry.tags.category;
  const reason = (entry.tags.reason || '').trim();

  if (!/^[1234]$/.test(category || '')) {
    outsideProblems.push(at + ' category=' + JSON.stringify(category || null));
    continue;
  }
  if (reason.length < 40) outsideProblems.push(at + ' reason is ' + reason.length + ' chars');
  if (entry.tags['auth-exempt'] !== entry.routePath) {
    outsideProblems.push(at + ' declares ' + JSON.stringify(entry.tags['auth-exempt'] || null));
  }

  if (category === '2' || category === '3') {
    const scope = entry.tags.scope || '';
    const links = scope.split('->').map((s) => s.trim()).filter(Boolean);
    if (links.length === 0) { outsideProblems.push(at + ' is category ' + category + ' and declares no @scope'); continue; }
    const last = links[links.length - 1].split('::').map((s) => s.trim());
    if (!SCOPE_PRIMITIVES.includes(last[1])) {
      outsideProblems.push(at + ' chain ends in ' + last[1] + ', not a scope primitive');
      continue;
    }
    const abs = path.join(SRC, last[0]);
    if (!fs.existsSync(abs)) { outsideProblems.push(at + ' names ' + last[0] + ', which does not exist'); continue; }
    if (!new RegExp('\\b' + last[1] + '\\s*\\(').test(fs.readFileSync(abs, 'utf8'))) {
      outsideProblems.push(at + ' declares scope via ' + last[1] + ' in ' + last[0] + ', but nothing there calls it');
    }
  }

  /*
    Category 4 — authenticated, but touching no tenant-owned data, so there is
    no scope to enter. The claim is only honest while it stays true, so it is
    checked rather than accepted: the handler must name an auth primitive, and
    must not reach the database. The moment it reads a table the annotation is
    a lie and this goes red.
  */
  if (category === '4') {
    if (!entry.tags.auth) { outsideProblems.push(at + ' is category 4 and declares no @auth'); continue; }
    // The handler's own body, not a fixed window. A fixed window ran past the
    // end of this route into the next one and reported its database access as
    // this route's — the check was reading the wrong handler.
    let bodyEnd = entry.index + 1;
    while (bodyEnd < lines.length
      && !/^\s*app\./.test(lines[bodyEnd])
      && !/^\s*\/\*\*/.test(lines[bodyEnd])) bodyEnd += 1;
    const body = lines.slice(entry.index, bodyEnd).join('\n');
    if (!new RegExp('\\b' + entry.tags.auth + '\\b').test(body)) {
      outsideProblems.push(at + ' declares @auth ' + entry.tags.auth + ', which the handler does not use');
    }
    if (/\bprisma\./.test(body) || /runAsOrganization|runAsPlatform/.test(body)) {
      outsideProblems.push(at + ' is category 4 but touches tenant data — it needs a scope, and a different category');
    }

    /*
      Category 4 must stay expensive to join.

      It is the one category that describes a surface kept for its own sake:
      authenticated, but outside the middleware and touching nothing the
      middleware protects. That is a reasonable description of a development
      helper and a terrible description of anything shipped, so the rule is that
      a category-4 surface is **not registered in production at all** — not
      registered and refusing, which still announces that it exists.

      The guard is read from the code rather than taken from the annotation.
      An annotation saying "development only" proves nothing; a route sitting
      inside `NODE_ENV !== 'production'` does. The predicate is the literal
      comparison the rest of this codebase already uses (logger.ts, index.ts) —
      there is no isProduction helper here and inventing a second one would give
      the next reader two things to keep in step.

      The escape hatch is deliberately narrow and deliberately loud: @env-exempt
      with a reason of real length, which shows up in review as a decision
      somebody made rather than a default somebody accepted.
    */
    const guardWindow = lines.slice(Math.max(0, entry.index - 12), entry.index + 1).join('\n');
    const guarded = /NODE_ENV\s*!==\s*'production'/.test(guardWindow)
      || /NODE_ENV\s*===\s*'development'/.test(guardWindow);
    const exemptReason = (entry.tags['env-exempt'] || '').trim();

    if (!guarded && exemptReason.length < 40) {
      outsideProblems.push(at + ' is category 4 and is neither guarded by NODE_ENV nor '
        + '@env-exempt with a reason — an authenticated surface outside the middleware must not '
        + 'be registered in production without one');
    }
  }
}

check('12 · every bypassing route declares a category the code supports',
  outsideProblems.length === 0,
  outsideProblems.join('; '));

const byCategory = (set, c) => set.filter((e) => e.tags.category === c).length;

console.log('');
console.log('Checked ' + (annotated.length + outsideAnnotated.length)
  + ' surfaces reachable without the /api auth middleware, in index.ts:');
console.log('  ' + annotated.length + ' exemptions inside it ('
  + byCategory(annotated, '1') + ' public, '
  + (category2Count - category3Count) + ' scoped elsewhere, '
  + category3Count + ' public tenant-derived)');
console.log('  ' + outsideAnnotated.length + ' registered outside it ('
  + byCategory(outsideAnnotated, '1') + ' public, '
  + byCategory(outsideAnnotated, '2') + ' scoped elsewhere, '
  + byCategory(outsideAnnotated, '3') + ' public tenant-derived, '
  + byCategory(outsideAnnotated, '4') + ' authenticated without tenant data)');
console.log(passed + '/' + (passed + failed) + ' checks passed.');
if (failed > 0) process.exitCode = 1;
