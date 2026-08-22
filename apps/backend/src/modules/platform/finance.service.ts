import { prisma } from '../../prisma';

/**
 * Platform finance documents: what a subscriber owes, and what they have paid.
 *
 * Two document kinds, deliberately distinct. An **invoice** records an amount
 * due; a **receipt** confirms money was taken. The platform could produce the
 * first and had nothing for the second, so "has this subscriber paid?" was
 * answerable only from a status field on the invoice, with no record of how,
 * when, or on whose authority.
 *
 * Neither is a tax document. There is no fiscal numbering sequence, no VAT
 * breakdown and no jurisdiction, and the rendered output says so. Issuing
 * anything tax-valid requires a real accounting provider behind it; implying
 * otherwise would put the platform owner on the wrong side of their own tax
 * authority, which is a worse outcome than not offering the feature.
 */

export type FinanceDocument = {
  kind: 'invoice' | 'receipt';
  id: string;
  reference: string;
  status: string;
  amountCents: number;
  /** Only meaningful on an invoice; a receipt is paid by definition. */
  amountPaidCents: number;
  currency: string;
  issuedAt: string;
  /** Due date on an invoice, payment date on a receipt. */
  effectiveAt: string | null;
  method: string | null;
  note: string | null;
};

/** Cents to a display string. Money is never held as a float anywhere here. */
export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return `${amount} ${currency}`;
}

/**
 * Reference for a new document.
 *
 * Sequential *per organization and kind*, which is what makes it useful to
 * quote back — and explicitly not a fiscal sequence: the platform makes no
 * claim that these are gapless, immutable, or acceptable to any tax authority.
 * A gap here means a draft was abandoned, nothing more.
 */
async function nextReference(
  kind: 'INV' | 'RCPT',
  organizationId: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const count =
    kind === 'INV'
      ? await prisma.invoice.count({ where: { organizationId } })
      : await prisma.paymentReceipt.count({ where: { organizationId } });
  const seq = String(count + 1).padStart(4, '0');
  // The org id tail keeps references from colliding across subscribers, which
  // a per-org counter alone would not prevent in a shared table.
  return `${kind}-${year}-${organizationId.slice(-4).toUpperCase()}-${seq}`;
}

export async function listFinanceDocuments(organizationId: string): Promise<FinanceDocument[]> {
  const [invoices, receipts] = await Promise.all([
    prisma.invoice.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' } }),
    prisma.paymentReceipt.findMany({ where: { organizationId }, orderBy: { paidAt: 'desc' } }),
  ]);

  const documents: FinanceDocument[] = [
    ...invoices.map((invoice): FinanceDocument => ({
      kind: 'invoice',
      id: invoice.id,
      reference: invoice.invoiceRef || invoice.id,
      status: invoice.status,
      amountCents: invoice.amountDueCents,
      amountPaidCents: invoice.amountPaidCents,
      currency: invoice.currency,
      issuedAt: invoice.createdAt.toISOString(),
      effectiveAt: invoice.dueAt?.toISOString() ?? null,
      method: null,
      note: null,
    })),
    ...receipts.map((receipt): FinanceDocument => ({
      kind: 'receipt',
      id: receipt.id,
      reference: receipt.reference,
      status: 'PAID',
      amountCents: receipt.amountCents,
      amountPaidCents: receipt.amountCents,
      currency: receipt.currency,
      issuedAt: receipt.createdAt.toISOString(),
      effectiveAt: receipt.paidAt.toISOString(),
      method: receipt.method,
      note: receipt.note,
    })),
  ];

  // Newest first across both kinds: a receipt and the invoice it settles belong
  // next to each other in time, not in two separate lists the reader has to
  // interleave themselves.
  return documents.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

export async function createInvoice(input: {
  organizationId: string;
  amountCents: number;
  currency: string;
  dueAt: Date | null;
  subscriptionId: string | null;
}) {
  return prisma.invoice.create({
    data: {
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId,
      provider: 'manual',
      invoiceRef: await nextReference('INV', input.organizationId),
      status: 'OPEN',
      amountDueCents: input.amountCents,
      amountPaidCents: 0,
      currency: input.currency,
      dueAt: input.dueAt,
    },
  });
}

export class PaymentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Record a payment against an invoice, and issue the receipt for it.
 *
 * Both writes happen in one transaction. A receipt without the matching
 * invoice update would claim money the invoice still shows as owed; an invoice
 * marked paid without a receipt loses the record of how it was settled. Either
 * half alone is worse than neither.
 */
export async function recordPayment(input: {
  organizationId: string;
  invoiceId: string;
  amountCents: number;
  method: string;
  externalRef: string | null;
  note: string | null;
  paidAt: Date;
  issuedByEmail: string | null;
}) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, organizationId: input.organizationId },
  });
  if (!invoice) throw new PaymentError('Invoice not found for this subscriber', 404);

  const outstanding = invoice.amountDueCents - invoice.amountPaidCents;
  if (outstanding <= 0) {
    throw new PaymentError('This invoice is already settled', 409);
  }
  if (input.amountCents <= 0) {
    throw new PaymentError('Payment amount must be greater than zero', 400);
  }
  // Overpayment is refused rather than silently absorbed. A number larger than
  // the balance is nearly always a typo, and recording it would leave the
  // ledger claiming a credit nobody granted.
  if (input.amountCents > outstanding) {
    throw new PaymentError(
      `Payment exceeds the outstanding balance of ${formatMoney(outstanding, invoice.currency)}`,
      400,
    );
  }

  const reference = await nextReference('RCPT', input.organizationId);
  const amountPaidCents = invoice.amountPaidCents + input.amountCents;
  const fullySettled = amountPaidCents >= invoice.amountDueCents;

  return prisma.$transaction(async (tx) => {
    const receipt = await tx.paymentReceipt.create({
      data: {
        organizationId: input.organizationId,
        invoiceId: invoice.id,
        reference,
        amountCents: input.amountCents,
        currency: invoice.currency,
        method: input.method,
        externalRef: input.externalRef,
        note: input.note,
        paidAt: input.paidAt,
        issuedByEmail: input.issuedByEmail,
      },
    });

    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountPaidCents,
        // PARTIAL is not a status the rest of the system reads, so a part
        // payment leaves the invoice OPEN with a paid amount on it rather than
        // inventing a state nothing else understands.
        status: fullySettled ? 'PAID' : invoice.status,
        paidAt: fullySettled ? input.paidAt : invoice.paidAt,
      },
    });

    return { receipt, invoice: updated };
  });
}
