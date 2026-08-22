'use client';

import Link from 'next/link';
import { AlertTriangle, Loader2, Wifi } from 'lucide-react';
import { type Session } from '@/lib/data';
import { useT } from '@/lib/i18n';

/**
 * Whether this conversation can actually be replied to, stated before the agent
 * types rather than after they press send.
 *
 * On an unofficial gateway a dropped session is silent. Without this strip the
 * failure sequence is: write a considered reply, press send, watch it fail, and
 * only then go looking for why. The brief's rule — "gateway loss makes affected
 * sends visibly unavailable and gives an available recovery path" — is really a
 * rule about *when* the agent finds out.
 *
 * Readiness is per session, not global. A tenant with a support number and a
 * marketing number can have one live and one down, and a strip that reported an
 * average would be wrong for both conversations.
 */

export type Readiness =
  | { state: 'checking' }
  | { state: 'ready'; label: string; phone: string | null }
  | { state: 'offline'; label: string; phone: string | null }
  | { state: 'unknown' };

/**
 * Resolve the conversation's own session against live gateway state.
 *
 * `sessions` is the live list from the gateway; `sessionName` is what the
 * conversation is stored against. When the two cannot be matched the state is
 * `unknown` rather than `offline` — claiming a channel is down when we simply
 * failed to identify it would send an agent to fix something that is not broken.
 */
export function resolveReadiness(
  sessionName: string | null,
  sessionPhone: string | null,
  sessions: Session[] | null,
): Readiness {
  if (sessions === null) return { state: 'checking' };
  if (!sessionName) return { state: 'unknown' };

  const match = sessions.find((session) => session.sessionName === sessionName);
  if (!match) return { state: 'unknown' };

  const label = match.label || match.sessionName;
  return match.connected
    ? { state: 'ready', label, phone: sessionPhone }
    : { state: 'offline', label, phone: sessionPhone };
}

export function ComposerReadinessStrip({
  readiness,
  showChannel,
}: {
  readiness: Readiness;
  /**
   * Only worth naming the channel when the tenant has more than one — on a
   * single-number workspace it is noise above every composer, all day.
   */
  showChannel: boolean;
}) {
  const { t } = useT();

  if (readiness.state === 'checking') {
    return (
      <div className="flex items-center gap-1.5 border-t border-border bg-secondary/30 px-3 py-1 text-micro text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('جاري التحقق من القناة')}
      </div>
    );
  }

  if (readiness.state === 'offline') {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-destructive/40 bg-destructive/10 px-3 py-1.5 text-micro text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          {showChannel
            ? `${readiness.label} — ${t('غير متصلة')}`
            : t('القناة غير متصلة')}
        </span>
        <span className="text-destructive/80">{t('لن تصل الردود حتى تعود')}</span>
        {/* A recovery path, not just a warning. The QR scan lives in settings. */}
        <Link
          href="/settings#channels"
          className="ms-auto shrink-0 font-medium underline underline-offset-2 hover:no-underline"
        >
          {t('إعادة الربط')}
        </Link>
      </div>
    );
  }

  if (readiness.state === 'unknown') {
    // Deliberately quiet. We could not identify the channel, which is not the
    // same as knowing it is down, and an alarming strip here would send an
    // agent to fix something that may be working.
    return null;
  }

  if (!showChannel) return null;

  return (
    <div className="flex items-center gap-1.5 border-t border-border bg-secondary/30 px-3 py-1 text-micro text-muted-foreground">
      <Wifi className="h-3 w-3 shrink-0 text-success" />
      <span className="truncate">
        {t('يُرسل من')} <span className="font-medium text-foreground">{readiness.label}</span>
      </span>
      {readiness.phone && (
        <span className="numeric shrink-0 font-mono opacity-70" dir="ltr">
          {readiness.phone}
        </span>
      )}
    </div>
  );
}

/** True when sending should be blocked outright. */
export function isSendBlocked(readiness: Readiness): boolean {
  return readiness.state === 'offline';
}

