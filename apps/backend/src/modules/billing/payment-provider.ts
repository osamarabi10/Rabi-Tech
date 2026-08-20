export type CheckoutStatus = 'pending' | 'paid' | 'failed' | 'canceled';

export type CheckoutResult = {
  checkoutUrl: string;
  externalRef: string;
};

export type CheckoutStatusResult = {
  status: CheckoutStatus;
  subscriptionRef?: string;
  customerRef?: string;
};

/**
 * Canonical billing outcomes. Providers name the same events differently —
 * Stripe says `checkout.session.completed`, the manual provider says
 * `manual.subscription_activated` — so each provider maps its own vocabulary
 * into these. Without this the billing service would need a branch per
 * provider, and adding one would silently do nothing until that branch existed.
 */
export type PaymentEventKind =
  | 'subscription_activated'
  | 'payment_failed'
  | 'subscription_canceled'
  | 'unknown';

export type VerifiedPaymentEvent = {
  valid: boolean;
  eventId: string;
  /** The provider's own event name, kept verbatim for the audit trail. */
  type: string;
  /** Normalized meaning the billing service acts on. */
  kind: PaymentEventKind;
  /** Which subscriber this concerns. Providers carry it in metadata. */
  organizationId?: string;
  planCode?: string;
  reason?: string;
  payload: unknown;
};

export type ProviderInvoice = {
  invoiceRef?: string;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  hostedInvoiceUrl?: string | null;
  dueAt?: Date | null;
  paidAt?: Date | null;
};

export interface PaymentProvider {
  readonly provider: string;
  createCheckout(organizationId: string, planCode: string): Promise<CheckoutResult>;
  getCheckoutStatus(externalRef: string): Promise<CheckoutStatusResult>;
  changeSubscription(subscriptionRef: string, newPlanCode: string): Promise<void>;
  cancelSubscription(subscriptionRef: string): Promise<void>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifiedPaymentEvent>;
  listInvoices(customerRef: string): Promise<ProviderInvoice[]>;
}

