'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock3, Loader2, Mail, MoonStar, Save, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleCard } from '@/components/ui/feedback-primitives';
import { ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import {
  fetchWorkspaceSettings,
  updateWorkspaceSettings,
  type WorkspaceSettings,
} from '@/lib/data';
import { useT } from '@/lib/i18n';

type TimeoutUnit = 'minutes' | 'hours' | 'days';

const UNIT_MINUTES: Record<TimeoutUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

const FALLBACK_TIMEZONES = [
  'Asia/Jerusalem',
  'Asia/Hebron',
  'Asia/Gaza',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'UTC',
];

function timeoutParts(minutes: number): { value: number; unit: TimeoutUnit } {
  if (minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

function timezoneOffset(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value || '';
  } catch {
    return '';
  }
}

function editableSnapshot(
  settings: WorkspaceSettings,
  timeoutValue: number,
  timeoutUnit: TimeoutUnit,
) {
  return JSON.stringify({
    name: settings.name.trim(),
    timezone: settings.timezone,
    userInactivityTimeoutMinutes: timeoutValue * UNIT_MINUTES[timeoutUnit],
    weeklyRecapEnabled: settings.weeklyRecapEnabled,
    weeklyRecapRecipientIds: [...settings.weeklyRecapRecipientIds].sort(),
    quietHoursEnabled: settings.quietHoursEnabled,
    quietHoursStart: settings.quietHoursStart,
    quietHoursEnd: settings.quietHoursEnd,
  });
}

export function OrganizationGeneral() {
  const { t } = useT();
  const router = useRouter();
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [timeoutValue, setTimeoutValue] = useState(20);
  const [timeoutUnit, setTimeoutUnit] = useState<TimeoutUnit>('minutes');
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [recipientToAdd, setRecipientToAdd] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const timezones = useMemo(() => {
    const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone');
    return supported?.length ? supported : FALLBACK_TIMEZONES;
  }, []);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const value = await fetchWorkspaceSettings();
      const timeout = timeoutParts(value.userInactivityTimeoutMinutes);
      setSettings(value);
      setTimeoutValue(timeout.value);
      setTimeoutUnit(timeout.unit);
      setSavedSnapshot(editableSnapshot(value, timeout.value, timeout.unit));
    } catch (error: any) {
      if (error?.response?.status === 403) {
        router.replace('/access-denied');
        return;
      }
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const currentSnapshot = settings ? editableSnapshot(settings, timeoutValue, timeoutUnit) : '';
  const dirty = Boolean(settings && currentSnapshot !== savedSnapshot);
  const timeoutMinutes = timeoutValue * UNIT_MINUTES[timeoutUnit];
  /*
    A zero-width quiet window is refused here as well as by the server.

    Saving 21:00–21:00 and being told nothing would read as "quiet hours are
    on", while the worker treats an equal start and end as no window at all and
    sends through the night. The server rejects it too — this is so the admin
    sees why before pressing save rather than after.
  */
  const quietWindowInvalid = Boolean(
    settings?.quietHoursEnabled && settings.quietHoursStart === settings.quietHoursEnd,
  );
  const invalid = !settings || settings.name.trim().length < 2 || timeoutMinutes < 5 || timeoutMinutes > 10080 || !settings.timezone || quietWindowInvalid;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const availableRecipients = useMemo(
    () => settings?.eligibleRecipients.filter((user) => !settings.weeklyRecapRecipientIds.includes(user.id)) ?? [],
    [settings],
  );

  const addRecipient = () => {
    if (!settings || !recipientToAdd) return;
    setSettings({
      ...settings,
      weeklyRecapRecipientIds: [...settings.weeklyRecapRecipientIds, recipientToAdd],
    });
    setRecipientToAdd('');
  };

  const removeRecipient = (userId: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      weeklyRecapRecipientIds: settings.weeklyRecapRecipientIds.filter((id) => id !== userId),
    });
  };

  const save = async () => {
    if (!settings || invalid) return;
    setSaving(true);
    try {
      const saved = await updateWorkspaceSettings({
        name: settings.name.trim(),
        timezone: settings.timezone,
        userInactivityTimeoutMinutes: timeoutMinutes,
        weeklyRecapEnabled: settings.weeklyRecapEnabled,
        weeklyRecapRecipientIds: settings.weeklyRecapRecipientIds,
        quietHoursEnabled: settings.quietHoursEnabled,
        quietHoursStart: settings.quietHoursStart,
        quietHoursEnd: settings.quietHoursEnd,
      });
      const timeout = timeoutParts(saved.userInactivityTimeoutMinutes);
      setSettings(saved);
      setTimeoutValue(timeout.value);
      setTimeoutUnit(timeout.unit);
      setSavedSnapshot(editableSnapshot(saved, timeout.value, timeout.unit));
      const stored = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
      if (stored.organization) {
        localStorage.setItem('rabitech_user', JSON.stringify({
          ...stored,
          organization: { ...stored.organization, name: saved.name },
        }));
      }
      toast.success(t('Organization settings saved'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not save organization settings'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex-1 overflow-y-auto p-5"><LayoutSkeleton label={t('Loading organization settings')} rows={6} /></div>;
  }
  if (loadError || !settings) {
    return <div className="flex-1 overflow-y-auto p-5"><ErrorState title={t('Could not load organization settings')} retryLabel={t('Try again')} onRetry={load} /></div>;
  }

  const selectedRecipients = settings.weeklyRecapRecipientIds
    .map((id) => settings.eligibleRecipients.find((user) => user.id === id))
    .filter((user): user is WorkspaceSettings['eligibleRecipients'][number] => Boolean(user));

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="border-b border-border px-5 py-4">
        <h1 className="text-base font-bold">{t('Organization information')}</h1>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-5">
        <section className="border-b border-border pb-6" aria-labelledby="organization-details-title">
          <h2 id="organization-details-title" className="text-sm font-semibold">{t('General information')}</h2>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="organization-name">{t('Organization name')}</Label>
            <Input
              id="organization-name"
              value={settings.name}
              maxLength={120}
              onChange={(event) => setSettings({ ...settings, name: event.target.value })}
              aria-invalid={settings.name.trim().length < 2}
            />
            <p className="text-caption text-muted-foreground">{t('This name appears to every member of the organization.')}</p>
          </div>
        </section>

        <section className="border-b border-border py-6" aria-labelledby="organization-session-title">
          <div className="flex gap-3">
            <Clock3 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 id="organization-session-title" className="text-sm font-semibold">{t('Session and timezone')}</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="inactivity-value">{t('Sign out after inactivity')}</Label>
                  <div className="grid grid-cols-[minmax(0,1fr)_132px] gap-2">
                    <Input
                      id="inactivity-value"
                      type="number"
                      min={1}
                      max={10080}
                      value={timeoutValue}
                      onChange={(event) => setTimeoutValue(Number(event.target.value))}
                    />
                    <Select value={timeoutUnit} onValueChange={(value) => setTimeoutUnit(value as TimeoutUnit)}>
                      <SelectTrigger aria-label={t('Inactivity timeout unit')}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutes">{t('Minutes')}</SelectItem>
                        <SelectItem value="hours">{t('Hours')}</SelectItem>
                        <SelectItem value="days">{t('Days')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-caption text-muted-foreground">{t('Active sessions are checked by the server, not only by this browser.')}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="organization-timezone">{t('Organization timezone')}</Label>
                  <Input
                    id="organization-timezone"
                    list="organization-timezones"
                    value={settings.timezone}
                    onChange={(event) => setSettings({ ...settings, timezone: event.target.value })}
                    dir="ltr"
                  />
                  <datalist id="organization-timezones">
                    {timezones.map((timezone) => <option key={timezone} value={timezone} />)}
                  </datalist>
                  <p className="text-caption text-muted-foreground" dir="ltr">
                    {timezoneOffset(settings.timezone)} {settings.timezone}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="py-6" aria-labelledby="quiet-hours-title">
          <div className="flex gap-3">
            <MoonStar className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 id="quiet-hours-title" className="sr-only">{t('Quiet hours')}</h2>
              <ToggleCard
                className="pt-0"
                title={t('Quiet hours')}
                /*
                  The description names the recipient's timezone explicitly,
                  because that is the surprising half. An owner reading "no
                  broadcasts after 21:00" will assume their own clock, and the
                  whole feature is that it is not.
                */
                description={t('Hold broadcasts outside these hours, measured in each recipient’s own local time rather than the organization’s. Nothing is dropped — held messages send when the window ends.')}
                checked={settings.quietHoursEnabled}
                onCheckedChange={(checked) => setSettings({ ...settings, quietHoursEnabled: checked })}
              />

              <div className="mt-4 grid gap-3 sm:grid-cols-2" aria-disabled={!settings.quietHoursEnabled}>
                <div className="space-y-1.5">
                  <Label htmlFor="quiet-start">{t('Hold from')}</Label>
                  <Input
                    id="quiet-start"
                    type="time"
                    dir="ltr"
                    className="numeric"
                    value={settings.quietHoursStart}
                    disabled={!settings.quietHoursEnabled}
                    onChange={(event) => setSettings({ ...settings, quietHoursStart: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="quiet-end">{t('Resume at')}</Label>
                  <Input
                    id="quiet-end"
                    type="time"
                    dir="ltr"
                    className="numeric"
                    value={settings.quietHoursEnd}
                    disabled={!settings.quietHoursEnabled}
                    onChange={(event) => setSettings({ ...settings, quietHoursEnd: event.target.value })}
                  />
                </div>
              </div>

              {/*
                Stated, not hidden. A window that wraps midnight is the normal
                case — 21:00 to 08:00 — and an owner who reads the two fields
                left to right could reasonably think it means nothing at all.
              */}
              {settings.quietHoursEnabled && !quietWindowInvalid && (
                <p className="mt-2 text-caption text-muted-foreground">
                  {settings.quietHoursStart > settings.quietHoursEnd
                    ? t('This window crosses midnight, so it covers the night.')
                    : t('This window sits inside one day.')}
                </p>
              )}
              {quietWindowInvalid && (
                <p className="mt-2 text-caption text-danger">
                  {t('Start and end cannot be the same time — that is not a window, and nothing would be held.')}
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="py-6" aria-labelledby="weekly-recap-title">
          <div className="flex gap-3">
            <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 id="weekly-recap-title" className="sr-only">{t('Weekly recap')}</h2>
              <ToggleCard
                className="pt-0"
                title={t('Weekly recap')}
                description={t('Send a seven-day activity summary every Monday at 8:00 AM in the organization timezone.')}
                checked={settings.weeklyRecapEnabled}
                onCheckedChange={(checked) => setSettings({ ...settings, weeklyRecapEnabled: checked })}
              />

              <div className="mt-4 space-y-3" aria-disabled={!settings.weeklyRecapEnabled}>
                <Label>{t('Recipients')}</Label>
                {selectedRecipients.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedRecipients.map((user) => (
                      <span key={user.id} className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/35 px-2 py-1.5">
                        <Avatar className="size-6">
                          {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
                          <AvatarFallback className="text-micro">{user.name.charAt(0)}</AvatarFallback>
                        </Avatar>
                        <span className="min-w-0">
                          <span className="block truncate text-caption font-medium">{user.name}</span>
                          <span className="block truncate text-micro text-muted-foreground" dir="ltr">{user.email}</span>
                        </span>
                        <Badge variant="outline" className="hidden sm:inline-flex">{user.role}</Badge>
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                          onClick={() => removeRecipient(user.id)}
                          disabled={!settings.weeklyRecapEnabled}
                          aria-label={`${t('Remove recipient')} ${user.name}`}
                        >
                          <X className="size-3.5" aria-hidden />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-caption text-muted-foreground">{t('No recap recipients selected.')}</p>
                )}

                <div className="flex max-w-lg gap-2">
                  <Select value={recipientToAdd} onValueChange={setRecipientToAdd} disabled={!settings.weeklyRecapEnabled || !availableRecipients.length}>
                    <SelectTrigger aria-label={t('Select an organization member')}><SelectValue placeholder={t('Select an organization member')} /></SelectTrigger>
                    <SelectContent>
                      {availableRecipients.map((user) => (
                        <SelectItem key={user.id} value={user.id}>{user.name} · {user.email}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" size="icon" onClick={addRecipient} disabled={!settings.weeklyRecapEnabled || !recipientToAdd} aria-label={t('Add recipient')}>
                    <UserPlus className="size-4" aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          {dirty && <span className="text-caption text-muted-foreground">{t('Unsaved changes')}</span>}
          <Button type="button" onClick={save} disabled={!dirty || invalid || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
            {t('Save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
