import Link from 'next/link';
import { ArrowLeft, Construction } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/operational-state';

/**
 * A console section that is navigable but not built yet.
 *
 * Built on the shared EmptyState rather than its own card: a placeholder is an
 * empty state with a known reason, and the app already has one too many ways to
 * say "there is nothing here" (see docs/KNOWN-DEFECTS.md, D-2).
 *
 * The route exists ahead of the feature so the navigation can be complete and
 * honest — the sidebar marks these Planned — rather than linking to a 404.
 */
export function PlatformPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <main className="min-h-full p-4 sm:p-6 lg:p-8">
      <div className="mx-auto flex min-h-[70vh] max-w-5xl items-center justify-center">
        <EmptyState
          icon={Construction}
          title={title}
          description={description}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/platform">
                <ArrowLeft className="me-1.5 h-3.5 w-3.5" aria-hidden />
                Back to overview
              </Link>
            </Button>
          }
        />
      </div>
    </main>
  );
}
