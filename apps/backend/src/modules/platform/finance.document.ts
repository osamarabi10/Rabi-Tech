import { formatMoney } from './finance.service';

/**
 * A finance document as a self-contained, printable HTML page.
 *
 * HTML rather than a generated PDF, on purpose. The obvious alternative is
 * pdfkit, and it does not shape Arabic or Hebrew without a text-shaping layer
 * bolted on — an Arabic receipt would come out as disconnected, reversed
 * glyphs, which is worse than no receipt at all. The browser already does this
 * correctly, and prints to PDF on every platform the owner might use. The
 * document downloads as a real file either way; nothing here is a button that
 * claims an export it does not perform.
 */

export type DocumentKind = 'invoice' | 'receipt';

export type DocumentData = {
  kind: DocumentKind;
  reference: string;
  issuerName: string;
  subscriberName: string;
  subscriberEmail: string | null;
  amountCents: number;
  currency: string;
  /** Issue date for an invoice, payment date for a receipt. */
  dateLabel: string;
  date: Date;
  /** Only on an invoice. */
  dueAt: Date | null;
  /** Only on a receipt. */
  method: string | null;
  externalRef: string | null;
  note: string | null;
  /** Only on an invoice: how much of it has been settled so far. */
  amountPaidCents: number | null;
};

/**
 * Escape before interpolation. Every value below is subscriber-controlled —
 * workspace names and payment notes are typed by people — and a document that
 * renders as HTML is a document that executes whatever is in them.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  card: 'Card',
  other: 'Other',
};

export function renderFinanceDocument(data: DocumentData): string {
  const isReceipt = data.kind === 'receipt';
  const title = isReceipt ? 'Payment receipt' : 'Invoice';
  const outstanding =
    data.amountPaidCents === null ? null : data.amountCents - data.amountPaidCents;

  const rows: Array<[string, string]> = [
    [data.dateLabel, formatDate(data.date)],
    ...(data.dueAt ? ([['Due', formatDate(data.dueAt)]] as Array<[string, string]>) : []),
    ...(data.method
      ? ([['Method', METHOD_LABEL[data.method] ?? data.method]] as Array<[string, string]>)
      : []),
    ...(data.externalRef
      ? ([['Payment reference', data.externalRef]] as Array<[string, string]>)
      : []),
    ...(outstanding !== null && outstanding > 0
      ? ([['Outstanding', formatMoney(outstanding, data.currency)]] as Array<[string, string]>)
      : []),
  ];

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} ${escapeHtml(data.reference)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px;
    font: 14px/1.6 -apple-system, "Segoe UI", system-ui, sans-serif;
    color: #111;
    background: #fff;
  }
  .sheet { max-width: 640px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
  .ref { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; color: #555; }
  .issuer { text-align: right; font-size: 13px; color: #555; }
  hr { border: 0; border-top: 1px solid #e3e3e3; margin: 24px 0; }
  .party-label, .row-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #777; }
  .party-name { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  td { padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
  td:last-child { text-align: right; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .total { margin-top: 24px; display: flex; justify-content: space-between; align-items: baseline; }
  .total-amount { font-size: 26px; font-weight: 700; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .note { margin-top: 24px; padding: 12px 14px; background: #f7f7f7; border-radius: 6px; font-size: 13px; }
  /* The disclaimer prints. It is the whole reason this document is safe to
     hand to anyone, so it must not be a screen-only nicety. */
  footer { margin-top: 40px; font-size: 11px; color: #777; line-height: 1.5; }
  @media print { body { padding: 24px; } }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="ref">${escapeHtml(data.reference)}</div>
      </div>
      <div class="issuer">
        <div class="party-name">${escapeHtml(data.issuerName)}</div>
      </div>
    </header>

    <hr>

    <div>
      <div class="party-label">${isReceipt ? 'Received from' : 'Billed to'}</div>
      <div class="party-name">${escapeHtml(data.subscriberName)}</div>
      ${data.subscriberEmail ? `<div>${escapeHtml(data.subscriberEmail)}</div>` : ''}
    </div>

    <table>
      ${rows
        .map(
          ([label, value]) =>
            `<tr><td class="row-label">${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`,
        )
        .join('\n      ')}
    </table>

    <div class="total">
      <span class="row-label">${isReceipt ? 'Amount paid' : 'Amount due'}</span>
      <span class="total-amount">${escapeHtml(formatMoney(data.amountCents, data.currency))}</span>
    </div>

    ${data.note ? `<div class="note">${escapeHtml(data.note)}</div>` : ''}

    <footer>
      This document is issued by ${escapeHtml(data.issuerName)} as a record of
      ${isReceipt ? 'a payment received' : 'an amount due'}.
      It is not a tax invoice and carries no fiscal numbering. For a tax-valid
      document, please refer to your accountant or tax authority.
    </footer>
  </div>
</body>
</html>`;
}

/**
 * The finance table as CSV.
 *
 * Excel is where a platform owner's accounting actually happens, so the export
 * has to open there without a conversion step. Values are quoted and embedded
 * quotes doubled — a workspace called `Ali "Abu" Trading` would otherwise split
 * into three columns.
 */
export function renderFinanceCsv(
  rows: Array<Record<string, string | number | null>>,
  columns: string[],
): string {
  const cell = (value: string | number | null | undefined) =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;

  const lines = [
    columns.map(cell).join(','),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join(',')),
  ];

  // BOM so Excel reads it as UTF-8. Without it, every Arabic and Hebrew name in
  // the file opens as mojibake, which is the single most common way a
  // working CSV export gets reported as broken.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
