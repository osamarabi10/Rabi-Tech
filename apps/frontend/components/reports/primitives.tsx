'use client';

import { useRef, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Download, FileImage, FileSpreadsheet, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Shared report primitives (M7).
 *
 * All of them share one rule: a number that cannot be computed renders as an
 * em-dash with an explanation, never as `0`. A zero is a measurement; a missing
 * value is not, and a report that shows the second as the first is how a
 * manager ends up acting on a number nobody produced.
 */

/** Durations arrive in minutes and are read by humans, so they degrade upward. */
export function formatDuration(minutes: number | null, t: (s: string) => string): string {
  if (minutes === null) return '—';
  if (minutes < 1) return `${Math.round(minutes * 60)}${t('ث')}`;
  if (minutes < 60) return `${Math.round(minutes)}${t('د')}`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return m ? `${h}${t('س')} ${m}${t('د')}` : `${h}${t('س')}`;
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes % 1440) / 60);
  return h ? `${d}${t('ي')} ${h}${t('س')}` : `${d}${t('ي')}`;
}

export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value}%`;
}

export function MetricTile({
  label,
  value,
  changePct,
  hint,
  onClick,
}: {
  label: string;
  value: ReactNode;
  changePct?: number | null;
  hint?: string;
  onClick?: () => void;
}) {
  const { t } = useT();
  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start rounded-lg border border-border bg-card p-4 text-start',
        onClick && 'transition-colors hover:border-primary/50 hover:bg-accent/40',
      )}
    >
      <span className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="numeric mt-1.5 text-2xl font-extrabold leading-none">{value}</span>
      {changePct !== undefined && (
        <span className="mt-2 flex items-center gap-1 text-caption">
          {changePct === null ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Minus className="h-3 w-3" />
              {/* Not "0%": there was nothing before, so there is no rate to state. */}
              {t('لا مقارنة')}
            </span>
          ) : changePct >= 0 ? (
            <span className="flex items-center gap-1 text-success">
              <ArrowUpRight className="h-3 w-3" />
              <span className="numeric" dir="ltr">{changePct}%</span>
            </span>
          ) : (
            <span className="flex items-center gap-1 text-destructive">
              <ArrowDownRight className="h-3 w-3" />
              <span className="numeric" dir="ltr">{changePct}%</span>
            </span>
          )}
          <span className="text-muted-foreground">{t('مقابل الفترة السابقة')}</span>
        </span>
      )}
      {hint && <span className="mt-1 text-caption text-muted-foreground">{hint}</span>}
    </Wrapper>
  );
}

export function ReportCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export type ChartExportValue = string | number | null | undefined;
export type ChartExportRow = Record<string, ChartExportValue>;

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function chartSvgSource(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const styles = getComputedStyle(document.documentElement);
  const serialized = new XMLSerializer().serializeToString(clone);
  return serialized.replace(/var\(--([^)]+)\)/g, (_match, name: string) => {
    return styles.getPropertyValue(`--${name}`).trim() || '0 0% 0%';
  });
}

function csvSource(rows: ChartExportRow[]): string {
  const columns = rows.reduce<string[]>((all, row) => {
    for (const key of Object.keys(row)) if (!all.includes(key)) all.push(key);
    return all;
  }, []);
  const orderedColumns = columns.includes('date')
    ? ['date', ...columns.filter((column) => column !== 'date')]
    : columns;
  const quote = (value: ChartExportValue) => {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [
    orderedColumns.map(quote).join(','),
    ...rows.map((row) => orderedColumns.map((column) => quote(row[column])).join(',')),
  ].join('\n');
}

/**
 * A shared chart frame with the controls every report chart needs. The chart
 * itself stays a child so a future Dashboard can use the same export and
 * group-by contract without duplicating toolbar logic.
 */
export function ChartCard({
  title,
  children,
  data,
  filename = 'rabitech-report',
  groupBy,
  groupByOptions,
  onGroupByChange,
}: {
  title: string;
  children: ReactNode;
  data: ChartExportRow[];
  filename?: string;
  groupBy?: string;
  groupByOptions?: Array<{ value: string; label: string }>;
  onGroupByChange?: (value: string) => void;
}) {
  const { t } = useT();
  const chartRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  const withExport = async (task: () => Promise<void>) => {
    setExporting(true);
    try {
      await task();
    } catch {
      toast.error(t('تعذر تصدير الرسم'));
    } finally {
      setExporting(false);
    }
  };

  const exportSvg = () => withExport(async () => {
    const svg = chartRef.current?.querySelector('svg');
    if (!svg) throw new Error('chart_not_found');
    downloadBlob(new Blob([chartSvgSource(svg)], { type: 'image/svg+xml;charset=utf-8' }), `${filename}.svg`);
  });

  const exportPng = () => withExport(async () => {
    const svg = chartRef.current?.querySelector('svg');
    if (!svg) throw new Error('chart_not_found');
    const source = chartSvgSource(svg);
    const svgUrl = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('chart_image_failed'));
      });
      image.src = svgUrl;
      await loaded;
      const rect = svg.getBoundingClientRect();
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas_not_available');
      context.fillStyle = getComputedStyle(chartRef.current || document.body).backgroundColor || '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('png_not_available');
      downloadBlob(blob, `${filename}.png`);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  });

  const exportCsv = () => withExport(async () => {
    downloadBlob(new Blob([`\uFEFF${csvSource(data)}`], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);
  });

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {groupByOptions && onGroupByChange && (
            <select
              value={groupBy ?? ''}
              onChange={(event) => onGroupByChange(event.target.value)}
              className="select-field-sm max-w-full"
              aria-label={t('تجميع الرسم')}
            >
              <option value="">{t('كل السلاسل')}</option>
              {groupByOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={exporting}
                aria-label={t('تصدير الرسم')}
                title={t('تصدير الرسم')}
              >
                <Download className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void exportSvg()}>
                <FileImage className="size-4" aria-hidden /> {t('تصدير SVG')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportPng()}>
                <FileText className="size-4" aria-hidden /> {t('تصدير PNG')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportCsv()}>
                <FileSpreadsheet className="size-4" aria-hidden /> {t('تصدير CSV')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div ref={chartRef} className="p-4">{children}</div>
    </section>
  );
}

/**
 * A distribution as stacked proportional bars.
 *
 * The counts are shown next to the bars rather than only in a tooltip: a
 * distribution whose bars are all short because one bucket dominates is
 * unreadable without the raw numbers.
 */
export function DistributionBars({
  buckets,
  labelFor,
}: {
  buckets: { label: string; count: number }[];
  labelFor: (label: string) => string;
}) {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) {
    return <EmptyNote />;
  }

  return (
    <div className="space-y-2">
      {buckets.map((bucket) => {
        const pct = Math.round((bucket.count / total) * 100);
        return (
          <div key={bucket.label} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-caption text-muted-foreground">
              {labelFor(bucket.label)}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="numeric w-16 shrink-0 text-end text-caption tabular-nums">
              {bucket.count} <span className="text-muted-foreground">({pct}%)</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Daily volume as a bar sparkline.
 *
 * Deliberately not a line: a line implies a continuous quantity between the
 * points, and a day with no messages is a real zero, not a dip on the way
 * somewhere.
 */
export function Sparkline({
  points,
  valueOf,
}: {
  points: { date: string; inbound: number; outbound: number; resolved: number }[];
  valueOf: (p: { inbound: number; outbound: number; resolved: number }) => number;
}) {
  const max = Math.max(1, ...points.map(valueOf));
  if (points.length === 0) return <EmptyNote />;

  return (
    <div className="flex h-16 items-end gap-px" dir="ltr">
      {points.map((point) => {
        const value = valueOf(point);
        return (
          <div
            key={point.date}
            title={`${point.date}: ${value}`}
            className="min-w-[2px] flex-1 rounded-sm bg-primary/70"
            // A real zero keeps a hairline so the day is still visible as a day.
            style={{ height: `${Math.max(2, (value / max) * 100)}%` }}
          />
        );
      })}
    </div>
  );
}

export function EmptyNote() {
  const { t } = useT();
  return (
    <p className="py-6 text-center text-xs text-muted-foreground">
      {t('لا توجد بيانات في هذه الفترة')}
    </p>
  );
}
