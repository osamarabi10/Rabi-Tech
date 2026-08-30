'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import type { ChannelCapabilities } from '@/lib/data';
import { useT } from '@/lib/i18n';

export function ChannelCapabilitiesPanel({ capabilities }: { capabilities: ChannelCapabilities }) {
  const { t } = useT();

  return (
    <section className="mb-6 border-y border-border py-4" aria-labelledby="active-channel-capabilities">
      <h2 id="active-channel-capabilities" className="text-small font-semibold">{t('Active sending channel capabilities')}</h2>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-caption sm:grid-cols-2 xl:grid-cols-4">
        <Capability label={t('Start new conversations')} available={capabilities.canInitiateConversations} />
        <Capability label={t('Approved message templates')} available={capabilities.supportsTemplates} />
        <Capability label={t('QR device pairing')} available={capabilities.supportsQrPairing} />
        <div>
          <dt className="text-muted-foreground">{t('Customer service window')}</dt>
          <dd className="mt-1 font-medium">
            {capabilities.requiresServiceWindow ? t('Required for replies') : t('No reply window restriction')}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('Unique recipients per 24 hours')}</dt>
          <dd className="mt-1 font-medium">
            {capabilities.maxUniqueRecipientsPer24h ?? t('No channel limit reported')}
          </dd>
        </div>
      </dl>

      {!capabilities.canInitiateConversations && (
        <p role="alert" className="mt-4 border-s-2 border-warning bg-warning/5 px-3 py-2 text-caption text-warning">
          {t('This channel can only reply within 24 hours of a customer message. It cannot start a conversation, so broadcasts and first-contact messages will be refused.')}
        </p>
      )}
    </section>
  );
}

function Capability({ label, available }: { label: string; available: boolean }) {
  const { t } = useT();
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={available ? 'mt-1 flex items-center gap-1.5 font-medium text-success' : 'mt-1 flex items-center gap-1.5 font-medium text-muted-foreground'}>
        {available ? <CheckCircle2 className="size-4" aria-hidden /> : <XCircle className="size-4" aria-hidden />}
        {available ? t('Available') : t('Unavailable')}
      </dd>
    </div>
  );
}
