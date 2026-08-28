'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  Circle,
  ContactRound,
  GitBranch,
  Loader2,
  MessageSquareText,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { GateBanner, UpgradeBadge } from '@/components/ui/feedback-primitives';
import {
  fetchCurrentProfile,
  fetchLifecycleStages,
  fetchSessions,
  fetchWorkspaceUsers,
  updateCurrentProfile,
  type CurrentProfile,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ChecklistStep = {
  id: string;
  title: string;
  description: string;
  detail: string;
  complete: boolean;
  icon: typeof Circle;
  href?: string;
  action: string;
  gated?: boolean;
};

const RESOURCES = [
  { title: 'Connect a channel', description: 'Pair and monitor a WhatsApp workspace number.', href: '/settings/channels', icon: MessageSquareText },
  { title: 'Design your lifecycle', description: 'Define the stages used by sales and reporting.', href: '/settings/lifecycle', icon: GitBranch },
  { title: 'Invite and organize teammates', description: 'Create users, permissions, and teams.', href: '/settings/users', icon: Users },
  { title: 'Set your personal preferences', description: 'Choose language, theme, security, and presence.', href: '/settings', icon: Settings },
  { title: 'Review contact operations', description: 'Search, filter, tag, merge, and update contacts.', href: '/contacts', icon: ContactRound },
  { title: 'Explore workspace reports', description: 'Track conversations, response work, and outcomes.', href: '/reports', icon: Sparkles },
];

export default function OnboardingPage() {
  const { t } = useT();
  const [profile, setProfile] = useState<CurrentProfile | null>(null);
  const [channelConnected, setChannelConnected] = useState(false);
  const [hasLifecycle, setHasLifecycle] = useState(false);
  const [hasTeammate, setHasTeammate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [nextProfile, sessions, stages, users] = await Promise.all([
        fetchCurrentProfile(),
        fetchSessions(),
        fetchLifecycleStages(),
        fetchWorkspaceUsers(),
      ]);
      setProfile(nextProfile);
      setChannelConnected(sessions.some((session) => session.connected));
      setHasLifecycle(stages.some((stage) => stage.kind === 'ACTIVE'));
      setHasTeammate(users.users.some((user) => user.isActive && user.id !== nextProfile.id));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const steps = useMemo<ChecklistStep[]>(() => [
    {
      id: 'channels', title: 'Connect channels', description: 'Bring customer conversations into one workspace.',
      detail: channelConnected ? 'A live messaging channel is connected.' : 'Pair a WhatsApp device and confirm its live connection.',
      complete: channelConnected, icon: MessageSquareText, href: '/settings/channels', action: 'Open channels',
    },
    {
      id: 'lifecycle', title: 'Learn lifecycle', description: 'Track contacts from first conversation to an outcome.',
      detail: hasLifecycle ? 'Review your primary, Won, and Lost stages, then mark this guide complete.' : 'Create the primary stages that match your customer journey.',
      complete: Boolean(profile?.onboardingLifecycleComplete), icon: GitBranch, href: '/settings/lifecycle', action: 'Open lifecycle',
    },
    {
      id: 'ai', title: 'Set up AI agents', description: 'Prepare automated assistance with a controlled human handoff.',
      detail: 'AI agents remain unavailable until tenant-isolated knowledge, token metering, and spend caps are enabled.',
      complete: false, icon: Bot, action: 'Infrastructure required', gated: true,
    },
    {
      id: 'teammates', title: 'Invite teammates', description: 'Give the right people access to conversations and workspace tools.',
      detail: hasTeammate ? 'At least one teammate is active in this workspace.' : 'Invite a teammate and assign the correct access level and team.',
      complete: hasTeammate, icon: Users, href: '/settings/users', action: 'Manage users',
    },
  ], [channelConnected, hasLifecycle, hasTeammate, profile?.onboardingLifecycleComplete]);

  const completeCount = steps.filter((step) => step.complete).length;
  const nextIncomplete = steps.find((step) => !step.complete && !step.gated)?.id;

  const toggleLifecycleComplete = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const next = await updateCurrentProfile({ onboardingLifecycleComplete: !profile.onboardingLifecycleComplete });
      setProfile((current) => current ? { ...current, onboardingLifecycleComplete: next.onboardingLifecycleComplete } : current);
      toast.success(t(next.onboardingLifecycleComplete ? 'Lifecycle guide completed' : 'Lifecycle guide reopened'));
    } catch {
      toast.error(t('Could not update onboarding progress'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex-1 overflow-y-auto p-5"><LayoutSkeleton label={t('Loading onboarding checklist')} rows={6} /></div>;
  if (loadError || !profile) return <div className="flex-1 overflow-y-auto p-5"><ErrorState title={t('Could not load onboarding checklist')} retryLabel={t('Try again')} onRetry={load} /></div>;

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <header className="border-b border-border pb-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-caption font-semibold text-primary">{t('Workspace onboarding')}</p>
              <h1 className="mt-1 text-xl font-bold sm:text-2xl">{t('Get your workspace ready')}</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t('Complete the operational setup that gets a team from account creation to its first managed conversation.')}</p>
            </div>
            <bdi dir="ltr" className="numeric shrink-0 text-sm font-semibold">{completeCount} / {steps.length} {t('complete')}</bdi>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('Onboarding progress')} aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={completeCount}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${(completeCount / steps.length) * 100}%` }} />
          </div>
        </header>

        <div className="grid gap-8 py-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(16rem,.75fr)]">
          <section aria-labelledby="checklist-heading" className="min-w-0">
            <h2 id="checklist-heading" className="text-sm font-semibold">{t('Setup checklist')}</h2>
            <div className="mt-3 border-y border-border">
              {steps.map((step) => {
                const Icon = step.icon;
                return (
                  <details key={step.id} open={step.id === nextIncomplete} className="group border-b border-border last:border-b-0">
                    <summary className="flex cursor-pointer list-none items-start gap-3 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border', step.complete ? 'border-success bg-success/10 text-success' : step.gated ? 'border-border bg-muted text-muted-foreground' : 'border-primary/35 bg-primary/5 text-primary')}>
                        {step.complete ? <Check className="size-4" aria-hidden /> : <Icon className="size-4" aria-hidden />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">{t(step.title)}</span>
                          <Badge
                            variant="outline"
                            className={cn(
                              'border-transparent text-micro',
                              step.complete && 'bg-success/10 text-success',
                              step.gated && 'bg-muted text-muted-foreground',
                              !step.complete && !step.gated && 'bg-warning/10 text-warning',
                            )}
                          >
                            {t(step.complete ? 'Complete' : step.gated ? 'Unavailable' : 'Not complete')}
                          </Badge>
                        </span>
                        <span className="mt-1 block text-caption leading-5 text-muted-foreground">{t(step.description)}</span>
                      </span>
                      <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
                    </summary>
                    <div className="pb-5 ps-10 sm:ps-12">
                      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t(step.detail)}</p>
                      {step.gated ? (
                        <GateBanner className="mt-4" title={t('AI infrastructure required')} description={t('This task unlocks after AI isolation, knowledge sources, metering, and hard spend caps are production-ready.')} action={<UpgradeBadge label={t('Not available')} />} />
                      ) : (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {step.href && <Button asChild size="sm"><Link href={step.href}>{t(step.action)}<ArrowUpRight aria-hidden /></Link></Button>}
                          {step.id === 'lifecycle' && (
                            <Button type="button" size="sm" variant="outline" onClick={toggleLifecycleComplete} disabled={saving || !hasLifecycle}>
                              {saving && <Loader2 className="animate-spin" aria-hidden />}
                              {t(step.complete ? 'Mark as incomplete' : 'Mark guide complete')}
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          </section>

          <aside id="resources" aria-labelledby="resources-heading" className="min-w-0 border-t border-border pt-6 lg:border-s lg:border-t-0 lg:ps-7 lg:pt-0">
            <h2 id="resources-heading" className="text-sm font-semibold">{t('Resources')}</h2>
            <p className="mt-1 text-caption leading-5 text-muted-foreground">{t('Open the workspace tools behind each setup step.')}</p>
            <nav className="mt-3 divide-y divide-border border-y border-border" aria-label={t('Onboarding resources')}>
              {RESOURCES.map((resource) => {
                const Icon = resource.icon;
                return (
                  <Link key={resource.href} href={resource.href} className="group flex items-start gap-3 py-3.5 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold">{t(resource.title)}</span>
                      <span className="mt-0.5 block text-micro leading-4 text-muted-foreground">{t(resource.description)}</span>
                    </span>
                    <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                );
              })}
            </nav>
          </aside>
        </div>
      </div>
    </div>
  );
}
