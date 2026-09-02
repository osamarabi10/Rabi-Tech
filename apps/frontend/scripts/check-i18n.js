/**
 * Every t() key must exist in the dictionary in Hebrew and English. Newer
 * English-keyed entries may also carry an explicit Arabic translation.
 *
 * The i18n helper falls back to its key when a string is missing, which keeps
 * the UI from breaking — and hides the failure. What the user sees is one
 * Arabic sentence sitting inside an otherwise English or Hebrew screen, which
 * looks like a bug in the translation rather than a missing entry, and nobody
 * reports it because it is only ever one line.
 *
 * This finds them before they ship. Run with `npm run check:i18n`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DICT_FILE = path.join(ROOT, 'lib', 'i18n.tsx');
const SCAN_DIRS = ['app', 'components', 'lib'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'scripts']);

/** Dictionary keys, read from the `const D: Dict = {` block. */
function dictionaryKeys() {
  const source = fs.readFileSync(DICT_FILE, 'utf8');
  const start = source.indexOf('const D: Dict = {');
  if (start < 0) throw new Error('Dictionary block not found in lib/i18n.tsx');

  const keys = new Map();
  const duplicates = [];

  /*
   * Parsed over the whole block, not line by line.
   *
   * A per-line regex missed every entry a formatter had wrapped across two or
   * three lines, and reported those keys as untranslated — which sends whoever
   * is fixing them to add a second copy of a translation that already exists.
   */
  const block = source.slice(start);

  /*
   * Both quote styles, and a trailing comma before the closing brace.
   *
   * Keys containing an escaped newline are written with double quotes, and
   * a formatter puts a trailing comma on any entry it wraps. A regex that
   * assumed single quotes and no trailing comma called four translated
   * strings untranslated — which is how a checker teaches people to ignore
   * it.
   */
  const STR = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
  const entry = new RegExp(
    '(' + STR + ')\\s*:\\s*\\{\\s*(?:ar:\\s*' + STR + '\\s*,\\s*)?he:\\s*(' + STR + ')\\s*,\\s*en:\\s*(' + STR + ')\\s*,?\\s*\\}',
    'g',
  );

  /**
   * The string the literal denotes, escapes resolved.
   *
   * Comparing raw literal text treats `"a \\"b\\""` and `'a "b"'` as two
   * different keys. They are one property as far as TypeScript is concerned,
   * and three duplicates written that way went unreported here and were
   * caught by tsc instead.
   */
  const unquote = (literal) =>
    literal.slice(1, -1).replace(/\\(.)/g, (_, ch) =>
      ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch,
    );

  let match;
  while ((match = entry.exec(block)) !== null) {
    const key = unquote(match[1]);
    if (keys.has(key)) duplicates.push(key);
    keys.set(key, { he: unquote(match[2]), en: unquote(match[3]) });
  }
  return { keys, duplicates };
}

function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) walk(path.join(dir, item.name));
      } else if (/\.(tsx|ts)$/.test(item.name)) {
        found.push(path.join(dir, item.name));
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir));
  return found;
}

const STR = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;

/** Resolve a literal's escapes so it can be compared with a dictionary key. */
function unquote(literal) {
  return literal.slice(1, -1).replace(/\\(.)/g, (_, ch) =>
    ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch);
}

/**
 * Blank out comments so prose cannot be mistaken for code.
 *
 * A docblock explaining `t(label)` is not a call, and counting it as one makes
 * the ratchet below report holes that do not exist — the same false-positive
 * class the dictionary parser already had to solve.
 */
function stripComments(source) {
  let out = '';
  for (let i = 0; i < source.length;) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
    } else if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  '; i += 2;
    } else {
      out += source[i]; i += 1;
    }
  }
  return out;
}

/** The balanced argument text of a call whose '(' is at `open`. */
function argumentAt(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return source.slice(open + 1, i); }
  }
  return null;
}

/**
 * Every t() call in a file, classified.
 *
 * ## Why the classification exists
 *
 * This checker follows **literal** arguments. That is correct, and it is aimed
 * correctly — and its coverage is contingent on code structure, which is the
 * part nobody notices. Move a literal into a constant, pass the constant to
 * `t()`, and the string leaves the checker's view entirely. Nothing fails. The
 * gate still prints green, over a smaller set.
 *
 * That is how thirty-seven strings shipped untranslated: an extraction moved
 * labels into a data array and translated them with `t(item.label)`, and this
 * checker had nothing to say about any of them. The refactor was a good one,
 * which is exactly why nobody looked.
 *
 * So a non-literal call is now a hole that must be **visible**: resolved,
 * listed as backlog, or exempted with a reason.
 *
 * ## Three kinds
 *
 * - **literal** — `t('…')`. Checked, as always.
 * - **partial** — not a literal, but contains one: a ternary, an
 *   `|| 'fallback'`. Every literal inside is followed and checked.
 * - **dynamic** — no literal anywhere. Nothing to check, so it needs a backlog
 *   entry or an exemption.
 */
function scanCalls(file) {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  const keys = new Set();
  const dynamic = [];
  let partial = 0;

  const re = /\bt\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const arg = argumentAt(source, match.index + 1);
    if (arg === null) continue;
    const trimmed = arg.trim();
    if (trimmed === '') continue;

    if (new RegExp('^' + STR + '$').test(trimmed)) {
      keys.add(unquote(trimmed));
      continue;
    }

    /*
      Only literals in *value* position, never comparison operands.

      `t(theme === 'light' ? 'فاتح' : 'داكن')` contains three literals and only
      two of them are keys — 'light' is what the variable is compared against.
      Taking every literal reported it as an untranslated string and would have
      had somebody add a dictionary entry for a value that is never displayed.
      A checker that manufactures work is one people learn to distrust.

      Value position is: the whole argument, or immediately after ? : || ?? or
      an opening parenthesis.
    */
    const valuePos = new RegExp(String.raw`(^|[?:(]|\|\||\?\?)\s*(` + STR + ')', 'g');
    let found = null;
    let any = false;
    while ((found = valuePos.exec(trimmed)) !== null) {
      keys.add(unquote(found[2]));
      any = true;
    }
    if (any) { partial += 1; continue; }
    if (new RegExp(STR).test(trimmed)) {
      // Contains a literal, but only as an operand. Nothing to check here.
      partial += 1;
      continue;
    }

    dynamic.push({
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      line: source.slice(0, match.index).split('\n').length,
      arg: trimmed.replace(/\s+/g, ' ').slice(0, 80),
    });
  }
  return { keys, dynamic, partial };
}

function usedKeys(file) {
  return scanCalls(file).keys;
}

const { keys: dictionary, duplicates } = dictionaryKeys();
const missing = new Map();
const blank = [];

for (const file of sourceFiles()) {
  for (const key of usedKeys(file)) {
    // An Arabic key IS the Arabic string; only he/en have to be supplied.
    const entry = dictionary.get(key);
    if (!entry) {
      if (!missing.has(key)) missing.set(key, []);
      missing.get(key).push(path.relative(ROOT, file));
    } else if (!entry.he.trim() || !entry.en.trim()) {
      blank.push(key);
    }
  }
}

let failed = false;

if (duplicates.length) {
  failed = true;
  console.log('Duplicate dictionary keys (the later one silently wins):');
  for (const key of [...new Set(duplicates)]) console.log('  ' + key);
  console.log('');
}

if (blank.length) {
  failed = true;
  console.log('Dictionary entries with an empty translation:');
  for (const key of [...new Set(blank)]) console.log('  ' + key);
  console.log('');
}


/*
  ── The ratchet ─────────────────────────────────────────────────────────────

  Every dynamic call site must be accounted for, in exactly one of two lists,
  and the two are counted separately because they mean different things. A
  backlog going down is progress; a pile of exemptions is a graveyard that reads
  as a decision.

  Three ways to fail, and the third is the one that keeps the lists honest:

  1. A site in neither list — a new hole, which is what the ratchet exists to
     stop. This is the check that pays for itself on the day somebody extracts a
     literal into a constant.
  2. A listed site that no longer exists, or now has fewer calls than recorded —
     a stale entry. Progress that has not been written down looks identical to a
     list nobody maintains, and the next reader cannot tell them apart.
  3. An exemption with no reason, or a reason too short to be one.
*/
const { BACKLOG, EXEMPT } = require('./i18n-dynamic-calls.js');

const dynamicFound = new Map();
let partialCalls = 0;
for (const file of sourceFiles()) {
  const { dynamic, partial } = scanCalls(file);
  partialCalls += partial;
  for (const row of dynamic) {
    const key = `${row.file} :: ${row.arg}`;
    if (!dynamicFound.has(key)) dynamicFound.set(key, { count: 0, line: row.line });
    dynamicFound.get(key).count += 1;
  }
}

const unlisted = [];
for (const [key, seen] of dynamicFound) {
  const allowed = (BACKLOG[key] || 0) + (EXEMPT[key] ? EXEMPT[key].count : 0);
  if (seen.count > allowed) unlisted.push(`${key}  (${seen.count} call(s), ${allowed} accounted for)`);
}

const stale = [];
for (const [key, count] of Object.entries(BACKLOG)) {
  const seen = dynamicFound.get(key);
  if (!seen) stale.push(`${key}  — backlog entry for a call that no longer exists`);
  else if (seen.count < count) stale.push(`${key}  — backlog says ${count}, found ${seen.count}`);
}
for (const [key, entry] of Object.entries(EXEMPT)) {
  const seen = dynamicFound.get(key);
  if (!seen) stale.push(`${key}  — exemption for a call that no longer exists`);
  else if (seen.count < entry.count) stale.push(`${key}  — exemption says ${entry.count}, found ${seen.count}`);
}

const unreasoned = Object.entries(EXEMPT)
  .filter(([, e]) => !e.reason || e.reason.trim().length < 30)
  .map(([key]) => key);

/*
  How many of the backlog are the shape a constant-follower could resolve:
  `something.field`, where the data almost always comes from a same-file const.

  Counted and not acted on. Following a `const X = [...] as const` into a call
  is real static analysis with its own failure modes, and this session has found
  six checks that were quietly wrong — sophistication buys more ways to be wrong
  while looking right. It ships separately, where it can be mutation-proved on
  its own terms, and this number says whether it would pay for itself.
*/
const followableShape = [...dynamicFound.keys()]
  .filter((key) => /:: [A-Za-z_$][\w$]*\.[\w$]+$/.test(key)).length;

if (unlisted.length) {
  failed = true;
  console.log('Dynamic t() calls that are neither backlog nor exempt:');
  for (const row of unlisted) console.log('  ' + row);
  console.log('');
  console.log('  A t() call whose argument is not a literal is checked by nothing.');
  console.log('  Make it a literal, or record it in scripts/i18n-dynamic-calls.js.');
  console.log('');
}

if (stale.length) {
  failed = true;
  console.log('Stale entries in scripts/i18n-dynamic-calls.js:');
  for (const row of stale) console.log('  ' + row);
  console.log('');
}

if (unreasoned.length) {
  failed = true;
  console.log('Exemptions with no real reason:');
  for (const row of unreasoned) console.log('  ' + row);
  console.log('');
}

const backlogCalls = Object.values(BACKLOG).reduce((a, b) => a + b, 0);
const exemptCalls = Object.values(EXEMPT).reduce((a, e) => a + e.count, 0);
const coverage = `${backlogCalls} backlog, ${exemptCalls} exempt, ${partialCalls} partially covered`
  + ` (${followableShape} backlog sites are the obj.field shape)`;

if (missing.size) {
  failed = true;
  console.log('Strings used with t() but absent from the dictionary:');
  for (const [key, files] of missing) {
    console.log('  ' + key);
    console.log('    ' + [...new Set(files)].slice(0, 3).join(', '));
  }
  console.log('');
}

if (failed) {
  console.log(missing.size + ' missing, ' + new Set(blank).size + ' blank, ' + new Set(duplicates).size + ' duplicated; ' + coverage + '.');
  process.exitCode = 1;
} else {
  console.log('i18n: every literal t() key is translated in Hebrew and English; ' + coverage + '.');
}
