/**
 * Writing CSV that a spreadsheet cannot be tricked into executing.
 *
 * ## The attack this exists to stop
 *
 * A cell beginning `=`, `+`, `-`, `@`, a tab, a carriage return, `;`, a
 * backtick or `|` is treated by Excel, LibreOffice and Google Sheets as a
 * **formula**, not text. `=cmd|'/c calc'!A1` in a name column becomes a command
 * the moment somebody opens the file, and modern Excel will prompt rather than
 * run it — but the prompt is one a busy person clicks through.
 *
 * What makes this live rather than theoretical here is where the data comes
 * from. A contact's name is their **WhatsApp display name**, which the contact
 * sets themselves. Anyone who can message a subscriber can put a formula in
 * that field, wait for somebody to export contacts, and have it run on an
 * admin's machine. Nothing in the product needs to be compromised first.
 *
 * Quoting alone does not help: `"=cmd|..."` is still parsed as a formula once
 * the quotes are stripped as CSV syntax. The defence is a leading apostrophe,
 * which every spreadsheet reads as "the rest is literal text" and strips on
 * display.
 *
 * Respond.io does this and we did not — one of the few places their
 * implementation was ahead of ours.
 */

/**
 * Characters that begin a formula.
 *
 * Tab and carriage return are here because a leading one is stripped by some
 * parsers, exposing whatever follows: `\t=cmd` becomes `=cmd`. `;` and `|`
 * are separators in locales where the comma is a decimal point, and a cell
 * starting with one can break out of its column entirely.
 */
const FORMULA_LEADERS = ['=', '+', '-', '@', '\t', '\r', ';', '`', '|'];

/**
 * One CSV cell: neutralised, then quoted.
 *
 * Order matters. The apostrophe goes on **before** quoting, so it sits inside
 * the quotes and survives as part of the value. Prefixing after would put it
 * outside and produce malformed CSV.
 */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');

  if (text.length > 0 && FORMULA_LEADERS.includes(text[0])) {
    text = `'${text}`;
  }

  // Embedded quotes are doubled — the CSV escape. Newlines inside a value are
  // legal as long as the field is quoted, which it always is here.
  return `"${text.replace(/"/g, '""')}"`;
}

/** A whole row, already neutralised. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

/**
 * A complete document.
 *
 * CRLF because RFC 4180 says so and because Excel on Windows — the overwhelming
 * majority of who opens these — mis-renders lone LF in some locales.
 *
 * The BOM matters more than it looks: without it Excel opens a UTF-8 file as
 * the system codepage, and every Arabic and Hebrew name in the export becomes
 * mojibake. Two of this product's three languages are affected, so an export
 * without the BOM is broken for most of its users.
 */
export function csvDocument(headers: string[], rows: unknown[][]): string {
  const body = [csvRow(headers), ...rows.map(csvRow)].join('\r\n');
  return `﻿${body}\r\n`;
}
