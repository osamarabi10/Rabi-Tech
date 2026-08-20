import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function CheckoutCancelPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-foreground">
      <h1 className="text-2xl font-bold">Activation paused</h1>
      <Button asChild><Link href="/pricing">Return to pricing</Link></Button>
    </main>
  );
}

