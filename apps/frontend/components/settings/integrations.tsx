'use client';

import Link from 'next/link';
import { ArrowLeft, KeyRound, Webhook } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { Badge } from '@/components/ui/badge';
import { SettingsPage, SettingsSection } from './settings-primitives';

/**
 * Integrations — the hub Respond.io puts API and webhooks under.
 *
 * ## Why this page lists only what exists
 *
 * The obvious version of this screen is a grid of logos — Zapier, Make, Google
 * Sheets, Dialogflow — with three of them greyed out or wired to a "coming
 * soon" toast. That is the failure this codebase treats as a defect rather
 * than a polish item: a control that does nothing is indistinguishable from
 * one that is broken, and a logo grid implies a roadmap commitment nobody made.
 *
 * So the page carries the integrations that work, and one honest sentence about
 * the rest. When Zapier ships it gets a card; until then it does not exist here.
 *
 * The two cards below are links, not features — the screens they point at are
 * the real thing. This page exists because that is where Respond.io's users
 * look for them, and matching where people look is most of what an information
 * architecture is for.
 */

export function Integrations() {
  const { t } = useT();

  const cards = [
    {
      href: '/settings/api',
      icon: KeyRound,
      title: t('API keys'),
      body: t('Scoped, expiring keys so your own software can read and send on this workspace.'),
      badge: t('Active'),
    },
    {
      href: '/settings/webhooks',
      icon: Webhook,
      title: t('Webhooks'),
      body: t('We POST a signed event to your URL when something happens here, with a full delivery log.'),
      badge: t('Active'),
    },
  ];

  return (
    <SettingsPage
      title={t('Integrations')}
      description={t('Connect this workspace to your own software.')}
    >
      <SettingsSection
        title={t('Developer API')}
        description={t('Anything else you want to connect can be built on the API above — it is the same interface the ready-made connectors would use.')}
      >
        <div className="grid gap-3 sm:grid-cols-2">
            {cards.map((card) => {
              const Icon = card.icon;
              return (
                <Link
                  key={card.href}
                  href={card.href}
                  className="group flex flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-primary" aria-hidden />
                    <span className="text-small font-semibold">{card.title}</span>
                    <Badge variant="outline" className="ms-auto text-success">{card.badge}</Badge>
                  </div>
                  <p className="text-caption text-muted-foreground">{card.body}</p>
                  {/* Logical property: two of three languages are right-to-left,
                      so the arrow has to point back along the reading direction. */}
                  <span className="mt-auto flex items-center gap-1 pt-1 text-micro text-primary">
                    {t('Open')}
                    <ArrowLeft className="size-3 rtl:rotate-180" aria-hidden />
                  </span>
                </Link>
              );
            })}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
