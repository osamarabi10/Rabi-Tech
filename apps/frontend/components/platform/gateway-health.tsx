'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Activity, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Gateway health for the platform console.
 *
 * English only, no `t()` — this screen has one user.
 *
 * Two probes are reported and they mean different things. `status` is a cheap
 * HTTP poll that runs every 15 minutes. `selfSend` is an **internal probe**: it
 * sends a real WhatsApp message to the subscriber's own number, runs every six
 * hours, is never charged to the tenant, and is the only thing that can catch
 * outbound failing while the session still claims to be connected.
 */

export type HealthRow = {
  organizationId: string;
  probe: 'status' | 'selfSend';
  ok: boolean;
  error: string | null;
  latencyMs: number;
  createdAt: string;
};

export type HealthAlert = {
  id: string;
  organizationId: string | null;
  severity: string;
  message: string;
  resolvedAt: string | null;
  createdAt: string;
};

export type GatewayHealth = { latest: HealthRow[]; alerts: HealthAlert[] };

export async function fetchGatewayHealth(): Promise<GatewayHealth> {
  const { data } = await api.get('/api/platform/gateway/health');
  return data as GatewayHealth;
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One subscriber's health cell. */
export function HealthCell({
  organizationId,
  health,
  onRefresh,
}: {
  organizationId: string;
  health: GatewayHealth | null;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const rows = (health?.latest || []).filter((row) => row.organizationId === organizationId);
  const status = rows.find((row) => row.probe === 'status');
  const selfSend = rows.find((row) => row.probe === 'selfSend');

  const check = async (probe: 'status' | 'selfSend') => {
    setBusy(true);
    try {
      const { data } = await api.post(`/api/platform/gateway/health-check/${organizationId}`, { probe });
      if (data.outcome === 'ok') toast.success(`${probe} probe ok (${data.latencyMs}ms)`);
      else if (data.outcome === 'skipped') toast.message(`Skipped — ${data.reason}`);
      else toast.error(`${probe} probe failed — ${data.error}`);
      onRefresh();
    } catch {
      toast.error('Probe request failed');
    } finally {
      setBusy(false);
    }
  };

  const dot = (row: HealthRow | undefined) =>
    !row ? 'bg-muted-foreground/40' : row.ok ? 'bg-success-vivid' : 'bg-destructive';

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', dot(status))}
        title={
          status
            ? `status: ${status.ok ? 'ok' : status.error} (${ago(status.createdAt)})`
            : 'status: never probed'
        }
      />
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full opacity-70', dot(selfSend))}
        title={
          selfSend
            ? `self-send: ${selfSend.ok ? 'ok' : selfSend.error} (${ago(selfSend.createdAt)})`
            : 'self-send: never probed'
        }
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-caption"
        disabled={busy}
        onClick={() => check('status')}
        title="Run the free status probe now"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
      </Button>
    </div>
  );
}

/** Open and recently-resolved gateway alerts. */
export function GatewayAlerts({ health }: { health: GatewayHealth | null }) {
  const alerts = health?.alerts || [];
  const open = alerts.filter((alert) => !alert.resolvedAt);
  if (!alerts.length) return null;

  return (
    <div className="mb-4 rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold">
        <AlertTriangle className={cn('h-3.5 w-3.5', open.length ? 'text-destructive' : 'text-muted-foreground')} />
        Gateway alerts
        {open.length > 0 && <Badge variant="destructive" className="text-micro">{open.length} open</Badge>}
      </div>
      <div className="divide-y divide-border">
        {alerts.slice(0, 10).map((alert) => (
          <div key={alert.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
            <span className={cn('truncate', alert.resolvedAt && 'text-muted-foreground line-through')}>
              {alert.message}
            </span>
            <span className="shrink-0 text-caption text-muted-foreground">
              {alert.resolvedAt
                ? `resolved ${ago(alert.resolvedAt)}`
                : `open since ${ago(alert.createdAt)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Polls health alongside the subscriber list. */
export function useGatewayHealth() {
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const refresh = useCallback(() => {
    fetchGatewayHealth().then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return { health, refresh };
}
