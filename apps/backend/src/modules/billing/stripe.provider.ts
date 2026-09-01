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
  'customer.subscription.deleted': 'subscription_canceled',

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

/** A Stripe field that is either an id or an expanded object. */
function refOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  const id = (value as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * The provider's identifiers, read from whichever shape the event carries.
 *
 * `checkout.session.completed` carries a session, whose `subscription` and
 * `customer` point at the objects it created. `customer.subscription.*` carries
 * the subscription itself, so its own `id` is the reference. Reading the wrong
 * one yields a session id where a subscription id belongs, which fails only
 * later, at cancellation.
 */
function identifiersOf(type: string, object: unknown): { subscriptionRef?: string; customerRef?: string } {
  const record = (object ?? {}) as Record<string, unknown>;
  if (type.startsWith('customer.subscription.')) {
    return { subscriptionRef: refOf(record.id), customerRef: refOf(record.customer) };
  }
  return { subscriptionRef: refOf(record.subscription), customerRef: refOf(record.customer) };
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

  /**
   * What Stripe says about a checkout session, and the identifiers it produced.
   *
   * This is what makes reconcileBilling mean something. The manual provider's
   * version reads our own Subscription.status and so can only ever confirm what
   * the database already believes; this one asks Stripe, which is the only
   * party that knows whether money moved. It is the missed-webhook fallback:
   * if a delivery is dropped, the half-hourly pass repairs the row from here.
   *
   * `paid` requires the session to be both complete and paid. A session can be
   * `complete` with `payment_status: 'unpaid'` — a subscription with a trial, or
   * a payment still processing — and treating that as paid would activate a
   * subscriber who has not been charged.
   */
  async getCheckoutStatus(externalRef: string): Promise<CheckoutStatusResult> {
    const session = await this.client().checkout.sessions.retrieve(externalRef);

    const subscriptionRef = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
    const customerRef = typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;
    const identifiers = { subscriptionRef, customerRef };

    if (session.status === 'expired') return { status: 'canceled', ...identifiers };
    if (session.status === 'complete' && session.payment_status !== 'unpaid') {
      return { status: 'paid', ...identifiers };
    }
    // Stripe has no "failed session" state — a failed payment leaves the session
    // open for another attempt — so `failed` is reported from invoice events,
    // not from here. Everything unresolved is pending, which is what the
    // reconciliation pass and the return page both treat as "keep waiting".
    return { status: 'pending', ...identifiers };
  }

  async changeSubscription(_subscriptionRef: string, _newPlanCode: string): Promise<void> {
    // Never called by anything today; see D-18. Kept on the interface because
    // it is the correct home for the plan-change propagation that is missing.
    throw new Error('StripeProvider.changeSubscription is not implemented');
  }

  /**
   * Cancel immediately, not at period end.
   *
   * `cancelCurrentSubscription` already writes `cancelAtPeriodEnd: false` and
   * drops the organization to FREE limits in the same breath, so scheduling the
   * cancellation for later would leave Stripe still billing a subscriber this
   * system has already downgraded.
   *
   * Only ever reached with a Stripe reference: cancellation dispatches on the
   * row's own provider, so a subscription created under `manual` goes to the
   * manual provider and never arrives here with a synthetic `manual_*` string.
   */
  async cancelSubscription(subscriptionRef: string): Promise<void> {
    if (!subscriptionRef.startsWith('sub_')) {
      // Belt and braces behind the dispatch fix. A synthetic reference reaching
      // Stripe would 404, and the resulting error is far less legible than
      // saying which reference was wrong and where it came from.
      throw new Error(
        `Refusing to cancel with "${subscriptionRef}": not a Stripe subscription reference. `
        + 'This row was created by another provider and must be cancelled through it.',
      );
    }
    await this.client().subscriptions.cancel(subscriptionRef);
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
    const object = event.data?.object as unknown;
    const { organizationId, planCode } = metadataOf(object);
    const { subscriptionRef, customerRef } = identifiersOf(event.type, object);

    return {
      valid: true,
      eventId: event.id,
      type: event.type,
      kind: STRIPE_EVENT_KINDS[event.type] ?? 'unknown',
      organizationId,
      planCode,
      subscriptionRef,
      customerRef,
      payload: event,
    };
  }

  async listInvoices(_customerRef: string): Promise<ProviderInvoice[]> {
    // Never called; the tenant panel reads local Invoice rows. See D-18.
    throw new Error('StripeProvider.listInvoices is not implemented');
  }
}
