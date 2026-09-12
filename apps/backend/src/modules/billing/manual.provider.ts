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

  /**
   * This provider has nowhere else to keep the purchase, so the reference is
   * the record: `manual_<organizationId>_v<planVersionId>_<when>_<random>`.
   *
   * The version is in there because a purchase is an agreement to particular
   * terms, and with this provider activation is a human act that can happen the
   * next day - after a new version has been published. Reading the version back
   * out is `versionOf` below, and a reference without one is refused rather
   * than resolved to whatever is current.
   */
  async createCheckout(organizationId: string, planCode: string, planVersionId: string) {
    const externalRef = `manual_${organizationId}_v${planVersionId}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    return {
      externalRef,
      checkoutUrl: `${appBaseUrl()}/contact-us-to-activate?externalRef=${encodeURIComponent(externalRef)}&plan=${encodeURIComponent(planCode)}`,
    };
  }

  /**
   * The version this reference was created for, or undefined.
   *
   * Undefined is a real answer and the caller must treat it as one: references
   * created before `createCheckout` carried a version look exactly like this,
   * and so does anything hand-made. Returning a guess here - today's version,
   * say - would move the refusal out of sight.
   */
  static versionOf(externalRef: string): string | undefined {
    const match = /^manual_[^_]+_v([A-Za-z0-9]+)_\d+_[0-9a-f]+$/.exec(externalRef);
    return match ? match[1] : undefined;
  }

  async getCheckoutStatus(externalRef: string) {
    return runAsPlatform(`billing-manual-status:${externalRef}`, async () => {
      const planVersionId = ManualProvider.versionOf(externalRef);
      const subscription = await prisma.subscription.findFirst({
        where: { provider: this.provider, externalRef },
        select: { status: true, subscriptionRef: true, customerRef: true },
      });
      if (!subscription) return { status: 'pending' as const, planVersionId };
      if (['ACTIVE', 'TRIALING'].includes(subscription.status)) {
        return {
          status: 'paid' as const,
          subscriptionRef: subscription.subscriptionRef ?? undefined,
          customerRef: subscription.customerRef ?? undefined,
          planVersionId,
        };
      }
      if (subscription.status === 'PAST_DUE') return { status: 'failed' as const, planVersionId };
      if (subscription.status === 'CANCELED') return { status: 'canceled' as const, planVersionId };
      return { status: 'pending' as const, subscriptionRef: subscription.subscriptionRef ?? undefined, planVersionId };
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

