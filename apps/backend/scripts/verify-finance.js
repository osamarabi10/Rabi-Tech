/**
 * End-to-end check of the platform finance ledger, against the real database.
 *
 * Exercises the service the HTTP routes call, so what is proven here is the
 * behaviour the console gets: sequential references, a receipt issued in the
 * same transaction as the invoice update, part payments leaving a balance, and
 * an overpayment refused rather than absorbed.
 *
 * Everything it creates is deleted again on the way out, including on failure.
 * A verification script that leaves invoices behind in a live ledger is worse
 * than no verification script.
 */
const { runAsPlatform } = require('../dist/lib/tenant-context');
const { prisma } = require('../dist/prisma');
const {
  listFinanceDocuments,
  createInvoice,
  recordPayment,
  formatMoney,
} = require('../dist/modules/platform/finance.service');
const {
  renderFinanceDocument,
  renderFinanceCsv,
} = require('../dist/modules/platform/finance.document');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail ? ' — ' + detail : ''));
  }
}

async function main() {
  const created = { invoices: [], receipts: [] };

  const organization = await prisma.organization.findFirst({ select: { id: true, name: true } });
  if (!organization) throw new Error('No organization to test against');

  try {
    // ── issuing ───────────────────────────────────────────────────────────
    const invoice = await createInvoice({
      organizationId: organization.id,
      amountCents: 4900,
      currency: 'USD',
      dueAt: new Date('2026-09-30'),
      subscriptionId: null,
    });
    created.invoices.push(invoice.id);

    check('invoice is issued OPEN with nothing paid',
      invoice.status === 'OPEN' && invoice.amountPaidCents === 0);
    check('invoice reference is namespaced and sequential',
      /^INV-\d{4}-[A-Z0-9]{4}-\d{4}$/.test(invoice.invoiceRef || ''), invoice.invoiceRef);

    // ── part payment ──────────────────────────────────────────────────────
    const part = await recordPayment({
      organizationId: organization.id,
      invoiceId: invoice.id,
      amountCents: 2000,
      method: 'bank_transfer',
      externalRef: 'TEST-TRANSFER-1',
      note: null,
      paidAt: new Date(),
      issuedByEmail: 'verify@example.test',
    });
    created.receipts.push(part.receipt.id);

    check('part payment leaves the invoice open',
      part.invoice.status === 'OPEN' && part.invoice.amountPaidCents === 2000,
      part.invoice.status + ' / ' + part.invoice.amountPaidCents);
    check('part payment issues a receipt for its own amount',
      part.receipt.amountCents === 2000 && /^RCPT-/.test(part.receipt.reference));

    // ── overpayment is refused, not absorbed ──────────────────────────────
    let overpayRefused = false;
    let overpayMessage = '';
    try {
      await recordPayment({
        organizationId: organization.id,
        invoiceId: invoice.id,
        amountCents: 9900,
        method: 'cash',
        externalRef: null,
        note: null,
        paidAt: new Date(),
        issuedByEmail: 'verify@example.test',
      });
    } catch (error) {
      overpayRefused = error.status === 400;
      overpayMessage = error.message;
    }
    check('overpayment is refused with the balance named',
      overpayRefused && overpayMessage.includes('29.00'), overpayMessage);

    // ── settling ──────────────────────────────────────────────────────────
    const rest = await recordPayment({
      organizationId: organization.id,
      invoiceId: invoice.id,
      amountCents: 2900,
      method: 'cash',
      externalRef: null,
      note: 'settled in full',
      paidAt: new Date(),
      issuedByEmail: 'verify@example.test',
    });
    created.receipts.push(rest.receipt.id);

    check('final payment marks the invoice PAID',
      rest.invoice.status === 'PAID' && rest.invoice.amountPaidCents === 4900,
      rest.invoice.status + ' / ' + rest.invoice.amountPaidCents);
    check('a settled invoice refuses further payment', await (async () => {
      try {
        await recordPayment({
          organizationId: organization.id,
          invoiceId: invoice.id,
          amountCents: 100,
          method: 'cash',
          externalRef: null,
          note: null,
          paidAt: new Date(),
          issuedByEmail: 'verify@example.test',
        });
        return false;
      } catch (error) {
        return error.status === 409;
      }
    })());

    // ── the ledger ────────────────────────────────────────────────────────
    const documents = await listFinanceDocuments(organization.id);
    const mine = documents.filter(
      (doc) => created.invoices.includes(doc.id) || created.receipts.includes(doc.id),
    );
    check('ledger returns the invoice and both receipts', mine.length === 3, String(mine.length));
    check('ledger is newest first',
      documents.every((doc, i) => i === 0 || documents[i - 1].issuedAt >= doc.issuedAt));

    // ── documents ─────────────────────────────────────────────────────────
    const html = renderFinanceDocument({
      kind: 'receipt',
      reference: rest.receipt.reference,
      issuerName: 'RabiTech',
      subscriberName: 'Ali "Abu" <script>alert(1)</script> Trading',
      subscriberEmail: 'owner@example.test',
      amountCents: 2900,
      currency: 'USD',
      dateLabel: 'Paid',
      date: new Date(),
      dueAt: null,
      method: 'cash',
      externalRef: null,
      note: 'settled in full',
      amountPaidCents: null,
    });
    check('document escapes subscriber-controlled text',
      !html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'));
    check('document states it is not a tax invoice',
      html.includes('not a tax invoice'));
    check('document carries no tax-document labelling',
      !/חשבונית מס|فاتورة ضريبية/.test(html));
    check('document shows the amount', html.includes('29.00 USD'));

    const csv = renderFinanceCsv(
      [{ kind: 'receipt', note: 'Ali "Abu" Trading' }],
      ['kind', 'note'],
    );
    check('csv doubles embedded quotes', csv.includes('"Ali ""Abu"" Trading"'), csv.trim());
    check('csv starts with a UTF-8 BOM', csv.charCodeAt(0) === 0xfeff);

    check('money formats from cents', formatMoney(4900, 'USD') === '49.00 USD');
  } finally {
    // Reverse order: receipts hold a RESTRICT foreign key onto the invoice.
    await prisma.paymentReceipt.deleteMany({ where: { id: { in: created.receipts } } });
    await prisma.invoice.deleteMany({ where: { id: { in: created.invoices } } });
    await prisma.$disconnect();
  }

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

runAsPlatform('verify-finance', main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
