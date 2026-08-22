'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Persistent settings sub-navigation.
 *
 * Settings was a single 1,155-line scroll with a horizontal strip of anchor
 * links across the top. That strip had two problems: it scrolled sideways on
 * narrow screens so half the sections were out of view, and nothing ever told
 * you which section you were currently looking at.
 *
 * This keeps the sections stacked and anchor-linked — deliberately, because the
 * alternative is turning eleven sections into eleven mounted/unmounted tabs and
 * restructuring seven hundred lines of working JSX to do it. Anchors also mean
 * a link to `#branding` still lands correctly, and the page still works with
 * JavaScript disabled.
 *
 * What is added is position: numbering, and an observer that marks the section
 * currently in view.
 */

export type SettingsSection = {
  id: string;
  label: string;
  adminOnly: boolean;
  /** Present when the section is a route of its own rather than an anchor. */
  href?: string;
};

export function SettingsSubNavigation({
  sections,
  className,
}: {
  sections: SettingsSection[];
  className?: string;
}) {
  const { t } = useT();
  const [active, setActive] = useState<string | null>(null);
  const sectionKey = sections.map(section => section.id).join(",");

  useEffect(() => {
    const anchored = sections.filter(section => !section.href);

    const nodes = () =>
      anchored
        .map(section => document.getElementById(section.id))
        .filter((node): node is HTMLElement => node !== null);

    const first = nodes()[0];
    if (!first) return;

    /**
     * The sections scroll inside a container, not the window.
     *
     * An IntersectionObserver against the viewport looked right and marked
     * nothing: jumping to a section puts it at the top of its scroll container,
     * which sits above any sensible viewport band. Reading positions from the
     * actual scroll parent is both correct and directly verifiable.
     */
    let scroller: HTMLElement | Window = window;
    let node: HTMLElement | null = first.parentElement;
    while (node) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }

    const recompute = () => {
      const top =
        scroller === window
          ? 0
          : (scroller as HTMLElement).getBoundingClientRect().top;

      // The last section whose heading has passed the reading line is the one
      // being read. Falling back to the first keeps something highlighted
      // before any scrolling has happened.
      const readingLine = top + 120;
      let current = anchored[0]?.id ?? null;

      for (const target of nodes()) {
        if (target.getBoundingClientRect().top <= readingLine) current = target.id;
      }
      setActive(current);
    };

    recompute();
    scroller.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);
    return () => {
      scroller.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
    };
    // Keyed on the section ids, not the array identity. The parent rebuilds
    // this list on every render, so depending on the array itself tore the
    // listener down and re-attached it constantly — and the scroll position
    // stopped updating after the first event.
  }, [sectionKey]);

  return (
    <nav
      className={cn(
        'flex flex-col gap-0.5 self-start rounded-lg border border-border bg-card p-2',
        className,
      )}
      aria-label={t('أقسام الإعدادات')}
    >
      {sections.map((section, index) => {
        const isActive = active === section.id;
        const number = String(index + 1).padStart(2, '0');

        const inner = (
          <>
            {/* Mono numbering, matching the operational grammar used across the
                product for anything positional. */}
            <span
              className={cn(
                'numeric shrink-0 font-mono text-micro tabular-nums',
                // Full strength, not /70. Faded to 70% these numbers sat at
                // 3.1:1 on the light theme, and a position marker nobody can
                // read is a position marker that is not there.
                isActive ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {number}
            </span>
            <span className="min-w-0 flex-1 truncate">{t(section.label)}</span>
            {section.href && (
              <ExternalLink className="h-3 w-3 shrink-0 opacity-50" aria-hidden />
            )}
          </>
        );

        const shared = cn(
          'flex items-center gap-2 rounded-md px-2 py-1.5 text-caption font-medium transition-colors motion-micro',
          isActive
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        );

        return section.href ? (
          <Link key={section.id} href={section.href} className={shared}>
            {inner}
          </Link>
        ) : (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={isActive ? 'true' : undefined}
            className={shared}
          >
            {inner}
          </a>
        );
      })}
    </nav>
  );
}
