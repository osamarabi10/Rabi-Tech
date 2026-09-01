import Stripe from 'stripe';
import {
  CheckoutStatusResult,
  PaymentEventKind,
  PaymentProvider,
  ProviderInvoice,
  VerifiedPaymentEvent,
} from './payment-provider';

/**
 * Stripe, against **test mode**.
 *
 * Test mode needs no verified business and moves no money, so the whole
 * signup-to-active path can be built and proven now; going live later is a key
 * swap plus whatever Stripe requires of the account.
 *
 * ## Stage 1 only
 *
 * `provider`, `createCheckout` and `verifyWebhook` are the three members that
 * make a paid signup reach ACTIVE without a human. The rest throw rather than
 * returning something plausible: a `getCheckoutStatus` that always answered
 * "pending" would silently disable reconcileBilling's missed-webhook fallback,
 * and a `cancelSubscription` that did nothing would let the local row say
 * CANCELED while Stripe kept charging. A method that is not implemented should
 * fail where it is called, not where the consequence surfaces.
 *
 * ## Subscriptions rather than one-off charges
 *
 * Nothing in this codebase reads `currentPeriodEnd`, and nothing renews — so
 * the *code* would be satisfied by a one-time Checkout Session. The business
 * would not: with one-time charges and no local renewal logic, a customer pays
 * once and keeps the product forever. Stripe performs the recurrence on its
 * side, which leaves the missing-renewal gap (D-22) an open gap rather than a
 * standing revenue loss.
 */

/** Stripe's event names mapped onto our canonical kinds. */
const STRIPE_EVENT_KINDS: Record<string, PaymentEventKind> = {
  'checkout.session.completed': 'subscription_activated',

  /*
    Deliberately absent, and this is not an oversight:

    - `invoice.payment_succeeded` is the renewal event, and mapping it to
      `subscription_activated` would call activateManualSubscription on every
      monthly renewal. That runs applyPlanLimits, which **overwrites
      OrganizationConfig** — so a subscriber's negotiated quota adjustment would
      be silently reset to the edition's values once a month, for as long as
      they keep paying. See D-14 and D-20. Stripe still collects the money; we
      simply take no action until renewal is designed properly.

    - `invoice.payment_failed` routes to markPaymentFailed, which suspends the
      organization **immediately, with no grace period**, while Stripe retries a
      failed invoice over several days. Reacting to the first failure would
      suspend a customer whose card succeeds on the retry. If it is ever mapped
      it must be the terminal failure only (`next_payment_attempt === null`),
      and choosing that is a product decision about grace rather than an
      adapter detail.

    Both arrive, are recorded in PaymentEvent, resolve to `unknown`, and are
    logged by the caller. Nothing is lost; nothing acts.
  */
};

function requiredEnv(name: string): string {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not set; the Stripe provider cannot be used without it`);
  return value;
}

/**
 * Our plan code to a Stripe price id.
 *
 * Read from the environment because Stripe price ids are **per-environment** —
 * a test-mode `price_…` is not the live one — so anything committed to the
 * repository would be wrong in one mode or the other. The shape is
 * `STRIPE_PRICE_<PLANCODE>`.
 *
 * **Never falls back to another edition's price.** An unmapped edition throws,
 * and the signup fails visibly, because the alternative is charging somebody
 * the wrong amount for the wrong thing and finding out from their bank
 * statement. A loud failure at checkout costs one signup; a silent wrong price
 * costs trust and a refund.
 *
 * This is also why the closed plan-code space matters operationally rather than
 * only philosophically: an edition created from the console today would have no
 * Stripe price, so it could be sold from the pricing page and refuse at
 * checkout. When CREATABLE_PLAN_CODES is widened, this map has to become a
 * column on Plan that the console can set.
 */
function priceIdFor(planCode: string): string {
  const key = `STRIPE_PRICE_${planCode.trim().toUpperCase()}`;
  const priceId = (process.env[key] || '').trim();
  if (!priceId) {
    throw Object.assign(
      new Error(
        `No Stripe price is configured for edition ${planCode}. Set ${key}. `
        + 'Refusing rather than charging against another edition\'s price.',
      ),
      { status: 500 },
    );
  }
  return priceId;
}

function appBaseUrl(): string {
  return (process.env.FRONTEND_PUBLIC_URL || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Read our metadata back off whatever object the event carries.
 *
 * Two places, and both are needed. `checkout.session.completed` carries the
 * *session's* metadata; `customer.subscription.*` and `invoice.*` carry the
 * *subscription's*. Writing only one of them is the single most likely way to
 * break this integration — activation would work and every later event would
 * park, which looks like an intermittent fault rather than a missing field.
 */
function metadataOf(object: unknown): { organizationId?: string; planCode?: string } {
  const record = (object ?? {}) as Record<string, unknown>;
  const direct = (record.metadata ?? {}) as Record<string, unknown>;
  const nested = ((record.subscription_details as Record<string, unknown> | undefined)?.metadata ?? {}) as Record<string, unknown>;
  const organizationId = String(direct.organizationId || nested.organizationId || '').trim();
  const planCode = String(direct.planCode || nested.planCode || '').trim();
  return {
    organizationId: organizationId || undefined,
    planCode: planCode || undefined,
  };
}

export class StripeProvider implements PaymentProvider {
  readonly provider = 'stripe';

  private client(): Stripe {
    return new Stripe(requiredEnv('STRIPE_SECRET_KEY'));
  }

  async createCheckout(organizationId: string, planCode: string) {
    // Resolved before the session is created, so an unmapped edition fails
    // before anything exists on Stripe's side to clean up.
    const price = priceIdFor(planCode);

    const session = await this.client().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      // Stripe substitutes the real session id into this template, which is
      // what the return page polls checkout-status with.
      success_url: `${appBaseUrl()}/checkout-success?externalRef={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl()}/signup?checkout=cancelled`,
      // Written twice, on purpose. See metadataOf() above: the session's
      // metadata reaches checkout.session.completed, and the subscription's
      // reaches every later event about that subscription.
      metadata: { organizationId, planCode },
      subscription_data: { metadata: { organizationId, planCode } },
    });

    if (!session.url) {
      throw new Error('Stripe returned a checkout session with no URL');
    }
    return { checkoutUrl: session.url, externalRef: session.id };
  }

  async getCheckoutStatus(_externalRef: string): Promise<CheckoutStatusResult> {
    throw new Error('StripeProvider.getCheckoutStatus is not implemented yet (Stage 2)');
  }

  async changeSubscription(_subscriptionRef: string, _newPlanCode: string): Promise<void> {
    // Never called by anything today; see D-18. Kept on the interface because
    // it is the correct home for the plan-change propagation that is missing.
    throw new Error('StripeProvider.changeSubscription is not implemented');
  }

  async cancelSubscription(_subscriptionRef: string): Promise<void> {
    throw new Error('StripeProvider.cancelSubscription is not implemented yet (Stage 2)');
  }

  async verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<VerifiedPaymentEvent> {
    const invalid: VerifiedPaymentEvent = {
      valid: false, eventId: '', type: '', kind: 'unknown', payload: null,
    };

    const header = Array.isArray(headers['stripe-signature'])
      ? headers['stripe-signature'][0]
      : headers['stripe-signature'];
    if (!header) return invalid;

    const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!secret) return invalid;

    let event: Stripe.Event;
    try {
      // The exact bytes, handed to Stripe's own verifier. express.raw() runs
      // ahead of express.json() in index.ts so this is a Buffer; parsing and
      // re-serialising anywhere in between would change the payload and every
      // signature would fail. Nothing about the failure is logged here — the
      // header and body are attacker-supplied and one of them is a credential.
      event = this.client().webhooks.constructEvent(rawBody, header, secret);
    } catch {
      return invalid;
    }

    // Through `unknown`: Stripe types data.object as a union of every resource
    // it can send, and only some of them carry `metadata`. metadataOf reads
    // defensively rather than narrowing on event type, because the set of
    // events that reach here is decided by the dashboard subscription, not by
    // this file.
    const { organizationId, planCode } = metadataOf(event.data?.object as unknown);

    return {
      valid: true,
      eventId: event.id,
      type: event.type,
      kind: STRIPE_EVENT_KINDS[event.type] ?? 'unknown',
      organizationId,
      planCode,
      payload: event,
    };
  }

  async listInvoices(_customerRef: string): Promise<ProviderInvoice[]> {
    // Never called; the tenant panel reads local Invoice rows. See D-18.
    throw new Error('StripeProvider.listInvoices is not implemented');
  }
}
