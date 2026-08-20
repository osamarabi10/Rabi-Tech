import { ManualProvider } from './manual.provider';
import { PaymentProvider } from './payment-provider';

let testProvider: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (testProvider) return testProvider;
  const provider = (process.env.PAYMENT_PROVIDER || 'manual').trim().toLowerCase();
  if (provider === 'manual') return new ManualProvider();
  throw new Error(`Unsupported PAYMENT_PROVIDER "${provider}"`);
}

export function assertKnownPaymentProvider(): void {
  getPaymentProvider();
}

export function setPaymentProviderForTests(provider: PaymentProvider | null): void {
  testProvider = provider;
}

