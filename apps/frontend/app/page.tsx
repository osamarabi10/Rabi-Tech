import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <section className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16">
        <p className="mb-3 text-sm font-semibold text-primary">RabiTech</p>
        <h1 className="max-w-3xl text-4xl font-bold leading-tight md:text-6xl">
          WhatsApp operations for growing local service teams
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          Start with a verified dashboard, then activate a managed WhatsApp gateway when your team is ready for a paid plan or approved manual onboarding.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild><Link href="/pricing">View pricing</Link></Button>
          <Button asChild variant="outline"><Link href="/login">Sign in</Link></Button>
        </div>
      </section>
    </main>
  );
}

