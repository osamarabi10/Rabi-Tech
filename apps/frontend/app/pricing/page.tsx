import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const plans = [
  { code: 'FREE', name: 'Free', price: '$0', mac: '100 MAC', cta: 'Start free', note: 'Dashboard access after email verification. WhatsApp gateway is not auto-provisioned on Free.' },
  { code: 'GROWTH', name: 'Growth', price: '$49', mac: '2,500 MAC', cta: 'Request activation', note: 'Manual activation by the RabiTech owner after verification and payment arrangement.' },
  { code: 'BUSINESS', name: 'Business', price: '$199', mac: '10,000 MAC', cta: 'Request activation', note: 'Includes custom domain and white-label controls.' },
  { code: 'ENTERPRISE', name: 'Enterprise', price: 'Custom', mac: 'Custom MAC', cta: 'Talk to us', note: 'Manual contract and limits for larger deployments.' },
];

export default function PricingPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto max-w-6xl px-6 py-14">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-primary">RabiTech plans</p>
            <h1 className="mt-2 text-3xl font-bold">Choose a starting point</h1>
          </div>
          <Button asChild variant="outline"><Link href="/login">Sign in</Link></Button>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          {plans.map((plan) => (
            <div key={plan.code} className="rounded-md border border-border bg-card p-5">
              <h2 className="text-lg font-bold">{plan.name}</h2>
              <p className="mt-3 text-3xl font-bold">{plan.price}</p>
              <p className="mt-1 text-sm text-muted-foreground">per month</p>
              <div className="mt-5 flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-primary" />{plan.mac}</div>
              <p className="mt-4 min-h-20 text-sm leading-6 text-muted-foreground">{plan.note}</p>
              <Button asChild className="mt-5 w-full">
                <Link href={`/signup?plan=${plan.code}`}>{plan.cta}</Link>
              </Button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

