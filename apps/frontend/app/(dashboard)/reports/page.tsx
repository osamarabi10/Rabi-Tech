'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Megaphone, MessageSquare, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import {
  fetchAgentPerformance,
  fetchSessions,
  fetchStats,
  fetchAgents,
  type AgentStat,
  type Session,
  type Stats,
  type Agent,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export default function OverviewPage() {
  const { t } = useT();
  const [stats, setStats] = useState<Stats | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [agentStats, setAgentStats] = useState<AgentStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const load = async () => {
    setLoading(true);
    const [nextStats, nextAgents, nextSessions] = await Promise.all([
      fetchStats(),
      fetchAgents(),
      fetchSessions(),
    ]);
    setStats(nextStats);
    setAgents(nextAgents);
    setSessions(nextSessions);
    setLastRefresh(new Date());
    setLoading(false);
  };

  useEffect(() => {
    load().catch(() => setLoading(false));
    const now = new Date();
    fetchAgentPerformance({
      startDate: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      endDate: now.toISOString(),
    }).then(setAgentStats).catch(() => {});
  }, []);

  const cards = stats ? [
    // Darkened for the light canvas; the previous mid shades failed contrast on white.
    { value: stats.conversations?.open ?? 0, label: t('محادثات مفتوحة'), color: '#0052CC' },
    { value: stats.conversations?.pending ?? 0, label: t('معلقة'), color: '#B45309' },
    { value: stats.conversations?.resolvedToday ?? 0, label: t('حُلّت اليوم'), color: '#047857' },
    { value: stats.conversations?.campaignsSent ?? 0, label: t('حملات مرسلة'), color: '#6D28D9' },
  ] : [];

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-base font-extrabold">{t('نظرة عامة')}</h1>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {lastRefresh.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {loading && !stats ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('جاري التحميل...')}</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {cards.map((card) => (
              <Card key={card.label}>
                <CardContent className="p-4">
                  <div className="text-2xl font-extrabold" style={{ color: card.color }}>{card.value}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{card.label}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('جلسات واتساب')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pb-4">
                {sessions.map((session) => (
                  <div key={session.sessionName} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs">
                    <span>{session.label || session.sessionName}</span>
                    {session.connected ? <Wifi className="h-4 w-4 text-success" /> : <WifiOff className="h-4 w-4 text-muted-foreground" />}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('الفريق')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2 pb-4">
                {agents.map((tech) => (
                  <div key={tech.id} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: tech.avail ? '#047857' : '#DC2626' }} />
                    {tech.name}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2 pt-4">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('أداء الوكلاء')}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="px-4 py-2 text-right font-medium">{t('الوكيل')}</th>
                    <th className="px-3 py-2 text-center font-medium">{t('رسائل')}</th>
                    <th className="px-3 py-2 text-center font-medium">{t('محادثات')}</th>
                    <th className="px-3 py-2 text-center font-medium">{t('محلولة')}</th>
                    <th className="px-3 py-2 text-center font-medium">CSAT</th>
                  </tr>
                </thead>
                <tbody>
                  {agentStats.map((agent) => (
                    <tr key={agent.name} className="border-b border-border/40">
                      <td className="px-4 py-2 font-medium">{agent.name}</td>
                      <td className="px-3 py-2 text-center">{agent.messagesSent}</td>
                      <td className="px-3 py-2 text-center">{agent.conversationsHandled}</td>
                      <td className="px-3 py-2 text-center text-success">{agent.resolvedCount}</td>
                      <td className="px-3 py-2 text-center">{agent.csatAvg ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link href="/inbox"><MessageSquare className="ml-1.5 h-3.5 w-3.5" />{t('الرسائل')}</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href="/campaigns"><Megaphone className="ml-1.5 h-3.5 w-3.5" />{t('الحملات')}</Link>
            </Button>
          </div>

        </div>
      )}
    </div>
  );
}
