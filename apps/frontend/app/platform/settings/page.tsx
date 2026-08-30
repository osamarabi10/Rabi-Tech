'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Clock, Loader2, Play, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState } from '@/components/ui/operational-state';

/**
 * The two automations that run without a person, and the settings behind them.
 *
 * Both existed and worked before this page. Neither had a control surface, so
 * the grace period that decides when a paying customer gets cut off, and the
 * length of the trial every new signup receives, were configurable in the
 * database and nowhere else. A setting only an engineer can change is not a
 * setting — it is a constant with extra steps.
 */

type Trial = { hours: number; planCode: string };

export default function PlatformSettings() {
  const router = useRouter();
  const [graceDays, setGraceDays] = useState('');
  const [trial, setTrial] = useState<Trial | null>(null);
  const [trialHours, setTrialHours] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [dunning, trialSettings] = await Promise.all([
        api.get('/api/platform/dunning/settings'),
        api.get('/api/platform/trial/settings'),
      ]);
      setGraceDays(String(dunning.data.graceDays));
      setTrial(trialSettings.data);
      setTrialHours(String(trialSettings.data.hours));
    } catch (error: any) {
      if ([401, 403].includes(error?.response?.status)) {
        router.replace('/login');
        return;
      }
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const saveGrace = async () => {
    setSaving('grace');
    try {
      const { data } = await api.patch('/api/platform/dunning/settings', {
        graceDays: Number(graceDays),
      });
      setGraceDays(String(data.graceDays));
      toast.success('Grace period saved');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not save');
    } finally {
      setSaving(null);
    }
  };

  const saveTrial = async () => {
    setSaving('trial');
    try {
      const { data } = await api.patch('/api/platform/trial/settings', {
        hours: Number(trialHours),
      });
      setTrial(data);
      setTrialHours(String(data.hours));
      toast.success('Trial length saved');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not save');
    } finally {
      setSaving(null);
    }
  };

  /**
   * Run the dunning pass now instead of waiting for the schedule.
   *
   * Deliberately reachable: the pass is the thing that warns and then suspends
   * paying customers, and an owner who has just changed the grace period should
   * be able to see what that does without waiting a day to find out.
   */
  const runDunning = async () => {
    setSaving('run');
    try {
      const { data } = await api.post('/api/platform/dunning/run');
      toast.success(
        `Dunning run: ${data.warned ?? 0} warned, ${data.suspended ?? 0} suspended, ${data.cleared ?? 0} cleared`,
      );
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not run dunning');
    } finally {
      setSaving(null);
    }
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Link
        href="/platform"
        className="inline-flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
        Platform control
      </Link>

      <h1 className="mt-3 text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-caption text-muted-foreground">
        What the automations do when nobody is watching.
      </p>

      {loading ? (
        <p className="mt-8 flex items-center gap-2 text-caption text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : loadError ? (
        <ErrorState
          className="mt-6"
          title="Could not load settings"
          description="The platform settings could not be loaded. Check the platform connection and try again."
          retryLabel="Retry"
          onRetry={load}
        />
      ) : (
        <div className="mt-8 space-y-4">
          {/* ── the trial offer ─────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <Clock className="h-4 w-4 text-primary" />
              Free trial
            </h2>
            <p className="mt-1 text-caption leading-6 text-muted-foreground">
              How long every new workspace gets before the paywall, and which plan it is a trial
              of. It runs on a paid plan deliberately — the free plan grants no WhatsApp
              connection, so a trial on it would demonstrate nothing.
            </p>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Label htmlFor="trial-hours">Hours</Label>
                <Input
                  id="trial-hours"
                  className="mt-1"
                  value={trialHours}
                  onChange={(e) => setTrialHours(e.target.value)}
                  inputMode="numeric"
                  dir="ltr"
                />
              </div>
              <Button onClick={saveTrial} disabled={saving !== null}>
                {saving === 'trial' && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
              {trial && (
                <p className="text-caption text-muted-foreground">
                  Currently <b className="numeric">{trial.hours}h</b> on{' '}
                  <b>{trial.planCode}</b>
                </p>
              )}
            </div>

            {/*
              Said out loud because it is the question an owner will ask before
              touching this field, and guessing wrong either way is expensive.
            */}
            <p className="mt-3 text-micro leading-5 text-muted-foreground">
              Changing this affects new signups only. Anyone already inside a trial keeps the
              deadline they were given — it is stamped once, at signup.
            </p>
          </section>

          {/* ── dunning ─────────────────────────────────────────────────── */}
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <Wallet className="h-4 w-4 text-primary" />
              Overdue invoices
            </h2>
            <p className="mt-1 text-caption leading-6 text-muted-foreground">
              When an invoice passes its due date the subscriber is warned and given a deadline.
              If it is still unpaid when that deadline arrives, their workspace is suspended.
              Paying at any point clears the deadline and restores service.
            </p>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="w-40">
                <Label htmlFor="grace-days">Days before suspension</Label>
                <Input
                  id="grace-days"
                  className="mt-1"
                  value={graceDays}
                  onChange={(e) => setGraceDays(e.target.value)}
                  inputMode="numeric"
                  dir="ltr"
                />
              </div>
              <Button onClick={saveGrace} disabled={saving !== null}>
                {saving === 'grace' && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
                Save
              </Button>
            </div>

            <div className="mt-4 border-t border-border pt-4">
              <p className="text-caption text-muted-foreground">
                The pass runs on a schedule. Run it now to see what the current setting does.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={runDunning}
                disabled={saving !== null}
              >
                {saving === 'run' ? (
                  <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="me-1.5 h-3.5 w-3.5" />
                )}
                Run dunning now
              </Button>
              {/*
                This warns and suspends real subscribers, so it says so before
                it is pressed rather than after.
              */}
              <p className="mt-2 text-micro leading-5 text-warning">
                This acts on real subscribers: it can warn and suspend them.
              </p>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
