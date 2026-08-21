'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, Pencil, Plus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  createWorkflow,
  deleteWorkflow,
  fetchWorkflowRuns,
  fetchWorkflows,
  updateWorkflow,
  type Workflow,
  type WorkflowRun,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { WorkflowBuilder } from '@/components/automations/workflow-builder';
import { runStatusLabel, triggerLabel } from '@/lib/workflow-labels';
import { EmptyState } from '@/components/empty-state';

/**
 * Automations list.
 *
 * The stat that matters here is not "how many times did this run" but "how many
 * of those runs did what they were supposed to". A workflow whose every
 * execution is FAILED still shows a healthy-looking execution count, so the
 * tally is broken out rather than summed.
 */
export default function AutomationsPage() {
  const { t } = useT();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [stats, setStats] = useState<Record<string, { tally: Record<string, number>; last: WorkflowRun | null }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchWorkflows();
      setWorkflows(list);
      // Stats are fetched per workflow after the list renders, so the page is
      // usable immediately rather than waiting on N aggregate queries.
      const entries = await Promise.all(list.map(async (workflow) => {
        try {
          const { runs, tally } = await fetchWorkflowRuns(workflow.id);
          return [workflow.id, { tally, last: runs[0] || null }] as const;
        } catch {
          return [workflow.id, { tally: {}, last: null }] as const;
        }
      }));
      setStats(Object.fromEntries(entries));
    } catch {
      setWorkflows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (workflow: Workflow) => {
    setBusyId(workflow.id);
    try {
      await updateWorkflow(workflow.id, { isActive: !workflow.isActive });
      toast.success(workflow.isActive ? t('تم إيقاف الأتمتة') : t('تم تفعيل الأتمتة'));
      load();
    } catch {
      toast.error(t('تعذّر تغيير الحالة'));
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (workflow: Workflow) => {
    setBusyId(workflow.id);
    try {
      // The copy starts inactive regardless of the original, like any new
      // workflow: duplicating one that is live must not immediately double
      // whatever it does to customers.
      await createWorkflow({
        name: `${workflow.name} (${t('نسخة')})`,
        description: workflow.description,
        triggerType: workflow.triggerType,
        configJson: workflow.configJson,
      });
      toast.success(t('تم نسخ الأتمتة'));
      load();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || t('تعذّر نسخ الأتمتة'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (workflow: Workflow) => {
    if (!window.confirm(t('حذف هذه الأتمتة وسجل تشغيلها؟'))) return;
    setBusyId(workflow.id);
    try {
      await deleteWorkflow(workflow.id);
      toast.success(t('تم حذف الأتمتة'));
      load();
    } catch {
      toast.error(t('تعذّر حذف الأتمتة'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-lg font-bold">
          <WorkflowIcon className="h-5 w-5 text-primary" />
          {t('الأتمتة')}
        </h1>
        <Button size="sm" onClick={() => { setEditing(null); setBuilderOpen(true); }}>
          <Plus className="h-4 w-4" />
          {t('أتمتة جديدة')}
        </Button>
      </div>

      {loading && (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('جاري التحميل...')}</p>
      )}

      {!loading && workflows.length === 0 && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={WorkflowIcon}
              title={t('لا توجد أتمتة بعد')}
              hint={t('الأتمتة تنفّذ إجراءات تلقائية عند وصول رسالة أو تغيّر وسم.')}
            />
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        {workflows.map((workflow) => {
          const stat = stats[workflow.id];
          const completed = stat?.tally.COMPLETED || 0;
          const failed = stat?.tally.FAILED || 0;
          const total = Object.values(stat?.tally || {}).reduce((sum, n) => sum + n, 0);
          return (
            <Card key={workflow.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                {/* Toggle. Deliberately the leftmost control in reading order:
                    "is this live" is the first question anyone has. */}
                <button
                  type="button"
                  disabled={busyId === workflow.id}
                  onClick={() => toggle(workflow)}
                  title={workflow.isActive ? t('إيقاف') : t('تفعيل')}
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
                    workflow.isActive ? 'bg-success-vivid' : 'bg-muted-foreground/30',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
                      workflow.isActive ? 'end-0.5' : 'start-0.5',
                    )}
                  />
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">{workflow.name}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-micro text-muted-foreground">
                      {t(triggerLabel(workflow.triggerType))}
                    </span>
                    {!workflow.isActive && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
                        {t('متوقفة')}
                      </span>
                    )}
                  </div>
                  {workflow.description && (
                    <p className="truncate text-caption text-muted-foreground">{workflow.description}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-3 text-caption">
                  <span className="text-muted-foreground">
                    {total} {t('مرات التشغيل')}
                  </span>
                  {completed > 0 && <span className="text-success-vivid">{completed} ✓</span>}
                  {failed > 0 && <span className="text-destructive">{failed} ✕</span>}
                  {stat?.last && (
                    <span className="text-muted-foreground" title={new Date(stat.last.createdAt).toLocaleString('en-GB')}>
                      {t(runStatusLabel(stat.last.status))}
                    </span>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button size="icon" variant="ghost" title={t('تعديل')}
                    onClick={() => { setEditing(workflow); setBuilderOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" title={t('نسخ')}
                    disabled={busyId === workflow.id} onClick={() => duplicate(workflow)}>
                    {busyId === workflow.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button size="icon" variant="ghost" title={t('حذف')}
                    disabled={busyId === workflow.id} onClick={() => remove(workflow)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <WorkflowBuilder
        open={builderOpen}
        workflow={editing}
        onClose={() => setBuilderOpen(false)}
        onSaved={load}
      />
    </div>
  );
}
