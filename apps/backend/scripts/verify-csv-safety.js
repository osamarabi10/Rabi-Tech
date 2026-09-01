/**
 * CSV injection: the exports must not hand a spreadsheet a formula to run.
 *
 * ## The attack, and why it is live here rather than theoretical
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab, CR, `;`, a backtick or `|` is read
 * by Excel, LibreOffice and Sheets as a **formula**. What makes that reachable
 * in this product is where the data comes from: a contact's name is their
 * **WhatsApp display name**, which the contact sets. Anyone who can message a
 * subscriber can put `=cmd|'/c calc'!A1` in that field, wait for somebody to
 * export contacts, and have it execute on an admin's machine. Nothing has to be
 * compromised first.
 *
 * The finance export is the same shape with a worse target: workspace names are
 * chosen by subscribers at signup, and that file is opened by the platform
 * owner.
 *
 * Quoting alone does not defend it — `"=cmd|..."` is still a formula once CSV
 * quoting is stripped. Only the leading apostrophe does.
 *
 * Hermetic: pure string functions, no database, no network.
 */
const fs = require('fs');
const path = require('path');
const { csvCell, csvRow, csvDocument } = require('../dist/lib/csv');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : ''));
  }
}

const LEADERS = ['=', '+', '-', '@', '\t', '\r', ';', '`', '|'];

function main() {
  // ── every formula leader is neutralised ───────────────────────────────────
  for (const leader of LEADERS) {
    const shown = JSON.stringify(leader);
    const cell = csvCell(`${leader}cmd|'/c calc'!A1`);
    check(`a cell starting ${shown} is prefixed with an apostrophe`,
      cell.startsWith(`"'${leader}`), cell.slice(0, 12));
  }

  // The real-world payload, end to end.
  const payload = "=cmd|'/c calc'!A1";
  check('the classic Excel payload is neutralised', csvCell(payload) === `"'${payload}"`, csvCell(payload));

  // ── ordinary values are untouched ────────────────────────────────────────
  check('a plain name is not mangled', csvCell('Sara') === '"Sara"');
  check('an Arabic name is not mangled', csvCell('أحمد') === '"أحمد"');
  check('a Hebrew name is not mangled', csvCell('דוד') === '"דוד"');
  // A phone number in + form starts with a leader, so it IS prefixed — correct,
  // and worth asserting so nobody "fixes" it later by exempting +.
  check('a +phone is prefixed too, because + is a formula leader',
    csvCell('+972501234567') === `"'+972501234567"`, csvCell('+972501234567'));
  check('an apostrophe is only added at the start',
    csvCell('a=b') === '"a=b"', csvCell('a=b'));
  check('an empty cell stays empty', csvCell('') === '""');
  check('null becomes an empty cell', csvCell(null) === '""');
  check('undefined becomes an empty cell', csvCell(undefined) === '""');

  // ── quoting still works ──────────────────────────────────────────────────
  check('embedded quotes are doubled',
    csvCell('Ali "Abu" Trading') === '"Ali ""Abu"" Trading"', csvCell('Ali "Abu" Trading'));
  check('a comma cannot split a column', csvCell('Doe, Jane') === '"Doe, Jane"');
  check('a newline stays inside the quoted field', csvCell('a\nb') === '"a\nb"');

  /*
    The apostrophe goes INSIDE the quotes.

    Order is the whole trick: prefixing after quoting would put it outside and
    produce malformed CSV that some parsers reject and others read as a stray
    column. This asserts it survives as part of the value.
  */
  const guarded = csvCell('=1+1');
  check('the apostrophe sits inside the quoting, not outside',
    guarded[0] === '"' && guarded[1] === "'", guarded);

  // ── rows and documents ───────────────────────────────────────────────────
  check('a row joins with commas', csvRow(['a', 'b']) === '"a","b"');
  check('a row neutralises every cell, not just the first',
    csvRow(['ok', '=evil']) === '"ok","\'=evil"', csvRow(['ok', '=evil']));

  const doc = csvDocument(['name'], [['=evil'], ['fine']]);
  check('a document starts with the UTF-8 BOM', doc.charCodeAt(0) === 0xfeff);
  check('  …without which Arabic and Hebrew open as mojibake in Excel', doc.startsWith('﻿'));
  check('a document uses CRLF, per RFC 4180', doc.includes('\r\n'));
  check('a document neutralises its rows', doc.includes(`"'=evil"`), doc.slice(0, 40));
  check('a document ends with a line break', doc.endsWith('\r\n'));

  // ── nothing still writes its own escaper ─────────────────────────────────
  /*
    The defect was not that the escaper was wrong — it was that each export
    wrote its own, and neither neutralised formulas. A third one written next
    year would repeat it, so this asserts the pattern is gone from src/ rather
    than only that today's two callers were fixed.
  */
  const srcRoot = path.join(__dirname, '..', 'src');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      // lib/csv.ts is the one place allowed to build a quoted cell by hand.
      if (full.endsWith(path.join('lib', 'csv.ts'))) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/replace\(\/"\/g,\s*'""'\)/.test(text)) offenders.push(path.relative(srcRoot, full));
    }
  })(srcRoot);
  check('no module writes its own CSV escaper any more', offenders.length === 0, offenders.join(', '));

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main();
