'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Team } from '@/lib/data';

/**
 * A channel, as the filter matches it.
 *
 * Deliberately the stored session (id + label), not the live gateway session:
 * conversations are stored against this id, so it is the only value a filter
 * can actually match on. The gateway list is keyed by session *name* and
 * carries connectivity, which belongs on the health tab rather than here.
 */
export type ChannelOption = { id: string; label: string };

/**
 * The one filter bar every report reads from.
 *
 * Previously each surface carried its own controls — a range picker on the page
 * header, a team filter buried inside the team table — so changing the period
 * meant finding the control that happened to own it, and the team filter
 * applied to exactly one of five views. One bar at the top, applying to
 * everything below it, is the shape that makes a report page navigable: pick
 * the slice once, then move between questions about that slice.
 *
 * Channel sits alongside Date and Team even though this deployment has one
 * channel type. It filters by WhatsApp session, which is already how a tenant
 * separates support from marketing traffic, and it is the control that becomes
 * load-bearing the moment a second channel exists.
 */

export type ReportFilters = {
  days: number;
  teamId: string;
  sessionId: string;
};

const RANGES = [
  { days: 7, label: 'آخر ٧ أيام' },
  { days: 30, label: 'آخر ٣٠ يوم' },
  { days: 90, label: 'آخر ٩٠ يوم' },
];

export function ReportFilterBar({
  filters,
  onChange,
  teams,
  sessions,
  loading,
  onRefresh,
}: {
  filters: ReportFilters;
  onChange: (next: ReportFilters) => void;
  teams: Team[];
  sessions: ChannelOption[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const { t } = useT();

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
      <div className="flex rounded-md border border-border p-0.5">
        {RANGES.map((range) => (
          <button
            key={range.days}
            type="button"
            onClick={() => onChange({ ...filters, days: range.days })}
            className={cn(
              'rounded px-2.5 py-1 text-caption font-medium transition-colors motion-micro',
              filters.days === range.days
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            {t(range.label)}
          </button>
        ))}
      </div>

      <select
        value={filters.teamId}
        onChange={(e) => onChange({ ...filters, teamId: e.target.value })}
        className="select-field-sm"
        aria-label={t('الفريق')}
      >
        <option value="">{t('كل الفرق')}</option>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>

      <select
        value={filters.sessionId}
        onChange={(e) => onChange({ ...filters, sessionId: e.target.value })}
        className="select-field-sm"
        aria-label={t('القناة')}
      >
        <option value="">{t('كل القنوات')}</option>
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.label}
          </option>
        ))}
      </select>

      <div className="ms-auto">
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
    </div>
  );
}
