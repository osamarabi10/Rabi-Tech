'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, MessageCircle, Cloud } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { RailGroup } from '@/components/ui/rail-group';

/**
 * P3 · ChannelRail — replaces the settings rail for channel-scoped configuration.
 *
 * ## Why this is a new component rather than a renamed settings rail
 *
 * `SettingsRail` is P2 and certified, and its data model is a compile-time list
 * of destinations. This one's model is *channels*: a runtime list that varies
 * per workspace, carries connection state, and differs in what it may offer
 * depending on which provider is behind each entry. Bending the certified
 * component into that shape would have meant P2 absorbing P3 and neither being
 * what it says it is. They share P4 `RailGroup`, which is the part that is
 * genuinely common.
 *
 * ## Provider awareness is a product boundary, not a nicety
 *
 * OpenWA and the Meta Cloud API do not expose the same configuration, and the
 * execution scope is explicit that OpenWA-only work must not invent Meta
 * template, quality, balance or 24-hour-window behaviour. So destinations are
 * derived from the channel's own capabilities: a Meta-only destination is
 * **absent** on an OpenWA channel, not present-and-disabled. A greyed entry
 * would be indistinguishable from a broken one, which is the same reasoning the
 * settings rail already records for screens we do not have.
 *
 * The one exception is a destination the workspace could have but this channel
 * has not finished setting up. That is disabled *with a stated reason*, because
 * it is a real destination in a temporary state rather than one that does not
 * apply.
 *
 * ## Status is never colour alone
 *
 * Each channel carries an icon with a distinct shape and a text label. A green
 * dot and a red dot are the same dot to a viewer who cannot distinguish them,
 * and connection state is exactly the kind of thing somebody scans rather than
 * reads.
 */
export type ChannelRailChannel = {
  id: string;
  name: string;
  /**
   * What this channel can be configured to do — capabilities, never identity.
   *
   * The tenancy gate refuses a frontend component that branches on which
   * provider a channel is, and it is right to. A rail keyed on the provider's
   * name assumes provider and feature move together, so the day a second
   * provider supports templates the rail is wrong everywhere at once. Asking
   * what the channel *can do* keeps the destination list correct without the
   * rail knowing who is behind it.
   *
   * The gate matches comments as well as code, on purpose — this docblock was
   * rewritten because its first draft quoted the very comparison it warns
   * against, which is the case that rule was written for.
   */
  capabilities: { supportsTemplates: boolean };
  status: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'INACTIVE';
  /** Bidi-isolated where rendered — a Latin-digit number inside RTL text. */
  phoneNumber?: string | null;
};

export type ChannelRailDestination = {
  key: 'overview' | 'capabilities' | 'templates';
  href: string;
  /** True when the destination exists but cannot be used yet; the reason is resolved at render. */
  disabledReason?: true;
};

const STATUS: Record<ChannelRailChannel['status'], { icon: typeof CheckCircle2; className: string }> = {
  CONNECTED: { icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-400' },
  CONNECTING: { icon: Loader2, className: 'text-amber-600 dark:text-amber-400' },
  DISCONNECTED: { icon: AlertTriangle, className: 'text-destructive' },
  INACTIVE: { icon: CircleSlash, className: 'text-muted-foreground' },
};

/*
  Status text resolved by a switch of literal t() calls rather than read from
  a table.

  A `label` field in STATUS is a string check:i18n cannot see: it follows
  literal arguments, so `t(state.label)` checks nothing and the translation
  can simply be absent. A switch costs four lines and puts every string back
  under the gate.
*/
function statusLabel(status: ChannelRailChannel['status'], t: (key: string) => string): string {
  switch (status) {
    case 'CONNECTED': return t('متصلة');
    case 'CONNECTING': return t('جارٍ الاتصال');
    case 'DISCONNECTED': return t('غير متصلة');
    case 'INACTIVE': return t('معطّلة');
  }
}

/**
 * Destinations for one channel, by transport.
 *
 * Exported so the reachability question — "is every declared destination
 * actually served?" — can be asked of a single function rather than of JSX.
 */
export function destinationsFor(channel: ChannelRailChannel, basePath: string): ChannelRailDestination[] {
  const q = `${basePath}?channel=${encodeURIComponent(channel.id)}`;
  const shared: ChannelRailDestination[] = [
    { key: 'overview', href: q },
    { key: 'capabilities', href: `${q}&section=capabilities` },
  ];

  if (channel.capabilities.supportsTemplates) {
    // Only meaningful once the channel is actually connected.
    shared.push({
      key: 'templates',
      href: `${q}&section=templates`,
      ...(channel.status === 'CONNECTED'
        ? {}
        : { disabledReason: true as const }),
    });
  }

  return shared;
}

/** Destination text, literal per case for the same reason as statusLabel. */
function destinationLabel(key: ChannelRailDestination['key'], t: (k: string) => string): string {
  switch (key) {
    case 'overview': return t('نظرة عامة');
    case 'capabilities': return t('القدرات');
    case 'templates': return t('قوالب Meta');
  }
}

export function ChannelRail({
  channels,
  selectedChannelId,
  basePath,
  onAddChannel,
  addDisabledReason,
}: {
  channels: ChannelRailChannel[];
  selectedChannelId: string | null;
  basePath: string;
  onAddChannel?: () => void;
  /** When present, the add control renders disabled with this as its reason. */
  addDisabledReason?: string;
}) {
  const { t } = useT();

  const selected = channels.find((c) => c.id === selectedChannelId) ?? null;

  const addAction = addDisabledReason
    ? { label: t('إضافة قناة'), disabledReason: addDisabledReason }
    : onAddChannel
      ? { label: t('إضافة قناة'), onClick: onAddChannel }
      : undefined;

  return (
    <aside
      className="w-full shrink-0 border-b border-border bg-background lg:w-[248px] lg:border-b-0 lg:border-e"
      aria-label={t('إعدادات القناة')}
    >
      <div className="flex gap-1 overflow-x-auto p-2 lg:block lg:h-full lg:overflow-y-auto lg:px-3 lg:py-5">
        {/*
          Counted, because how many channels a workspace has is the first thing
          somebody wants from this rail, and collapsible because a workspace
          with many channels should be able to get them out of the way while
          configuring one. Both are P4 capabilities the settings rail does not
          use — which is the point of extracting it.
        */}
        <RailGroup
          label={t('القنوات')}
          items={channels}
          count={channels.length}
          collapsible
          itemKey={(channel) => channel.id}
          addAction={addAction}
          renderItem={(channel) => {
            const state = STATUS[channel.status];
            const stateText = statusLabel(channel.status, t);
            const StateIcon = state.icon;
            const KindIcon = channel.capabilities.supportsTemplates ? Cloud : MessageCircle;
            const active = channel.id === selectedChannelId;
            return (
              <Link
                href={`${basePath}?channel=${encodeURIComponent(channel.id)}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-9 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-caption font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:mb-px lg:min-h-[34px]',
                  active && 'bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary',
                )}
              >
                <KindIcon className="size-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate">{channel.name}</span>
                {/*
                  Shape and text, never colour alone. The icon differs per state
                  and the label is real text in the accessible name, so the
                  status survives both a monochrome display and a screen reader.
                */}
                <StateIcon
                  className={cn('size-3.5 shrink-0', state.className, channel.status === 'CONNECTING' && 'animate-spin')}
                  aria-hidden
                />
                <span className="sr-only">{stateText}</span>
              </Link>
            );
          }}
        />

        {selected && (
          <RailGroup
            label={t('إعدادات القناة')}
            items={destinationsFor(selected, basePath)}
            itemKey={(destination) => destination.key}
            renderItem={(destination) => {
              const label = destinationLabel(destination.key, t);
              const reason = t('تتوفر القوالب بعد اكتمال اتصال القناة');
              if (destination.disabledReason) {
                /*
                  Present, disabled, and explained. This destination exists for
                  this transport and is simply not usable yet — unlike a
                  Meta-only destination on an OpenWA channel, which is absent
                  entirely rather than shown as a dead entry.
                */
                return (
                  <span
                    aria-disabled="true"
                    title={reason}
                    className="flex min-h-9 cursor-not-allowed items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-caption font-medium text-muted-foreground/60 lg:mb-px lg:min-h-[34px]"
                  >
                    <span>{label}</span>
                    <span className="sr-only">{reason}</span>
                  </span>
                );
              }
              return (
                <Link
                  href={destination.href}
                  className="flex min-h-9 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-caption font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:mb-px lg:min-h-[34px]"
                >
                  <span>{label}</span>
                </Link>
              );
            }}
          />
        )}
      </div>
    </aside>
  );
}
