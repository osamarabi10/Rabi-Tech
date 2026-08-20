import crypto from 'crypto';
import { prisma } from '../../prisma';
import { runAsPlatform } from '../../lib/tenant-context';
import { PaymentEventKind, PaymentProvider, ProviderInvoice, VerifiedPaymentEvent } from './payment-provider';

function appBaseUrl(): string {
  return (process.env.FRONTEND_PUBLIC_URL || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** This provider's event names mapped onto the canonical kinds. */
const MANUAL_EVENT_KINDS: Record<string, PaymentEventKind> = {
  'manual.subscription_activated': 'subscription_activated',
  'manual.payment_failed': 'payment_failed',
  'manual.subscription_canceled': 'subscription_canceled',
};

export class ManualProvider implements PaymentProvider {
  readonly provider = 'manual';

  async createCheckout(organizationId: string, planCode: string) {
    const externalRef = `manual_${organizationId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    return {
      externalRef,
      checkoutUrl: `${appBaseUrl()}/contact-us-to-activate?externalRef=${encodeURIComponent(externalRef)}&plan=${encodeURIComponent(planCode)}`,
    };
  }

  async getCheckoutStatus(externalRef: string) {
    return runAsPlatform(`billing-manual-status:${externalRef}`, async () => {
      const subscription = await prisma.subscription.findFirst({
        where: { provider: this.provider, externalRef },
        select: { status: true, subscriptionRef: true, customerRef: true },
      });
      if (!subscription) return { status: 'pending' as const };
      if (['ACTIVE', 'TRIALING'].includes(subscription.status)) {
        return {
          status: 'paid' as const,
          subscriptionRef: subscription.subscriptionRef ?? undefined,
          customerRef: subscription.customerRef ?? undefined,
        };
      }
      if (subscription.status === 'PAST_DUE') return { status: 'failed' as const };
      if (subscription.status === 'CANCELED') return { status: 'canceled' as const };
      return { status: 'pending' as const, subscriptionRef: subscription.subscriptionRef ?? undefined };
    });
  }

  async changeSubscription(subscriptionRef: string, _newPlanCode: string): Promise<void> {
    await runAsPlatform(`billing-manual-change:${subscriptionRef}`, async () => {
      const exists = await prisma.subscription.findUnique({ where: { subscriptionRef }, select: { id: true } });
      if (!exists) throw new Error('Manual subscription not found');
    });
  }

  async cancelSubscription(subscriptionRef: string): Promise<void> {
    await runAsPlatform(`billing-manual-cancel:${subscriptionRef}`, async () => {
      await prisma.subscription.update({
        where: { subscriptionRef },
        data: { status: 'CANCELED', canceledAt: new Date(), cancelAtPeriodEnd: false },
      });
    });
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifiedPaymentEvent> {
    const invalid = { valid: false, eventId: '', type: '', kind: 'unknown' as const, payload: null };
    const secret = process.env.MANUAL_PAYMENT_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET;
    if (!secret) return invalid;
    const provided = Array.isArray(headers['x-payment-signature'])
      ? headers['x-payment-signature'][0]
      : headers['x-payment-signature'];
    if (!provided) return invalid;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!timingSafeEquals(provided, expected)) return invalid;
    const payload = JSON.parse(rawBody.toString('utf8') || '{}');
    const type = String(payload.type || '');
    return {
      valid: true,
      eventId: String(payload.eventId || ''),
      type,
      kind: MANUAL_EVENT_KINDS[type] ?? 'unknown',
      organizationId: payload.organizationId ? String(payload.organizationId) : undefined,
      planCode: payload.planCode ? String(payload.planCode) : undefined,
      reason: payload.reason ? String(payload.reason) : undefined,
      payload,
    };
  }

  async listInvoices(customerRef: string): Promise<ProviderInvoice[]> {
    return runAsPlatform(`billing-manual-invoices:${customerRef}`, async () => {
      const invoices = await prisma.invoice.findMany({
        where: { provider: this.provider, customerRef },
        orderBy: { createdAt: 'desc' },
      });
      return invoices.map((invoice) => ({
        invoiceRef: invoice.invoiceRef ?? undefined,
        status: invoice.status,
        amountDueCents: invoice.amountDueCents,
        amountPaidCents: invoice.amountPaidCents,
        currency: invoice.currency,
        hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        dueAt: invoice.dueAt,
        paidAt: invoice.paidAt,
      }));
    });
  }
}

