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

/**
 * Literal t('…') calls.
 *
 * Deliberately literals only. `t(someVariable)` is resolved at runtime — the
 * send-failure reasons arrive from the server that way — and a static check
 * cannot know what those will be without guessing.
 */
function usedKeys(file) {
  const source = fs.readFileSync(file, 'utf8');
  // Both quote styles here too: a string containing an apostrophe is written
  // with double quotes, and those are exactly the strings worth checking.
  const calls = /\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\)/g;
  const keys = new Set();
  let match;
  while ((match = calls.exec(source)) !== null) {
    keys.add(
      match[1].slice(1, -1).replace(/\\(.)/g, (_, ch) =>
        ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch,
      ),
    );
  }
  return keys;
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
  console.log(missing.size + ' missing, ' + new Set(blank).size + ' blank, ' + new Set(duplicates).size + ' duplicated.');
  process.exitCode = 1;
} else {
  console.log('i18n: every literal t() key is translated in Hebrew and English.');
}
