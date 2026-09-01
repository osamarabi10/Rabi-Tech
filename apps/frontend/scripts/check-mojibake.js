/**
 * Find Arabic and Hebrew text that was decoded as Latin-1 somewhere along the
 * way and written back as UTF-8.
 *
 * The result is a string like `Ø¬Ù‡Ø§Øª Ø§Ù„Ø§ØªØµØ§Ù„` — valid UTF-8, so no
 * tool complains, and completely unreadable to the person it is shown to. It
 * survives typecheck, lint and build, and the only way it gets caught is if
 * somebody happens to look at that exact screen in that exact language.
 *
 * The signature is one of the Arabic lead bytes (Ø, Ù, Ú) followed immediately
 * by another Latin-1 high character — a sequence that essentially never occurs
 * in real text. Hebrew mojibake leads with × instead.
 *
 * Run with `npm run check:mojibake`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '..', 'backend');

/** Frontend surfaces, plus the backend source that supplies their text. */
const SCAN_TARGETS = [
  path.join(ROOT, 'app'),
  path.join(ROOT, 'components'),
  path.join(ROOT, 'lib'),
  path.join(BACKEND, 'src'),
];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist']);

// Ø-Ú are Ø Ù Ú; × is × for Hebrew. The follower class is the
// Latin-1 supplement plus the handful of Windows-1252 characters that UTF-8
// continuation bytes map onto (Œ-ž, ‘-„, …, €).
// Two lead classes, because two things get corrupted and only one of them was
// being caught.
//
//   Ø Ù Ú  — Arabic text.   ×  — Hebrew text.   ð  — any 4-byte character,
//   which in this codebase means an emoji.
//
// The emoji case was found on 2026-09-01 in constants/keywords.ts and is
// cosmetic on its own: the corruption is in section comments. It is worth
// catching anyway, because it is evidence the FILE was mangled — and in that
// file the Arabic keyword arrays sit three lines below the corrupted comments.
// A checker that reports clean on a demonstrably mangled file teaches people
// to trust it exactly where it is blind.
const MOJIBAKE = /[×-Úð][-ÿŒ-ž‘-„…€]/;

const hits = [];

function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) walk(path.join(dir, item.name));
    } else if (/\.(tsx|ts)$/.test(item.name)) {
      const file = path.join(dir, item.name);
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (MOJIBAKE.test(line)) {
          hits.push({
            file: path.relative(ROOT, file),
            line: index + 1,
            text: line.trim().slice(0, 120),
          });
        }
      });
    }
  }
}

for (const dir of SCAN_TARGETS) walk(dir);

if (hits.length === 0) {
  console.log('mojibake: none found.');
} else {
  console.log(hits.length + ' line(s) contain mis-decoded text:');
  for (const hit of hits) {
    console.log('  ' + hit.file + ':' + hit.line);
    console.log('    ' + hit.text);
  }
  process.exitCode = 1;
}
