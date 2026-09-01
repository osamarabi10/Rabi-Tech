import { ManualProvider } from './manual.provider';
import { StripeProvider } from './stripe.provider';
import { PaymentProvider } from './payment-provider';

let testProvider: PaymentProvider | null = null;

/**
 * The provider a **named** row belongs to, rather than the one configured now.
 *
 * A subscription is a relationship with the provider that created it, and that
 * outlives the environment variable. Cancelling a row created under `manual`
 * has to go to the manual provider even when Stripe is the active one —
 * otherwise Stripe is handed a `manual_subscription_*` reference that means
 * nothing to it, and the local row reads CANCELED while nothing was cancelled
 * anywhere.
 *
 * Unregistered names **throw**. A row naming a provider this build no longer
 * carries is a real problem — the code that could honour that relationship is
 * gone — and the failure belongs at the point of the attempt, loudly, rather
 * than as a silent no-op that lets the caller believe it succeeded.
 *
 * The test override wins here exactly as it does for `getPaymentProvider`. The
 * harness installs a provider named `fake`, which is registered nowhere; making
 * this resolve by name first would break the seam and, worse, would make the
 * gate exercise a different provider from the one it installed.
 */
export function paymentProviderFor(name: string): PaymentProvider {
  if (testProvider) return testProvider;
  const provider = (name || '').trim().toLowerCase();
  if (provider === 'manual') return new ManualProvider();
  if (provider === 'stripe') return new StripeProvider();
  throw new Error(
    `Unsupported payment provider "${provider}". A record names it, but this build has no implementation for it.`,
  );
}

export function getPaymentProvider(): PaymentProvider {
  if (testProvider) return testProvider;
  return paymentProviderFor(process.env.PAYMENT_PROVIDER || 'manual');
}

export function assertKnownPaymentProvider(): void {
  getPaymentProvider();
}

export function setPaymentProviderForTests(provider: PaymentProvider | null): void {
  testProvider = provider;
}

