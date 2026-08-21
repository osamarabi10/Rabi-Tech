'use client';

import { useId, useMemo, useState } from 'react';
import { useT } from '@/lib/i18n';
import { EmptyNote } from './primitives';

/**
 * Time-series line chart.
 *
 * Hand-drawn SVG rather than a charting library: the whole need is one polyline
 * with a hover readout, and every candidate library costs more in bundle than
 * this file costs in code. It also keeps the chart on the design tokens — a
 * library would arrive with its own palette that does not flip with the theme.
 *
 * Always `dir="ltr"`. The x-axis is time, and time reads left-to-right in every
 * locale this ships in; mirroring it under RTL would put the newest day on the
 * left and contradict every other clock and calendar the user looks at.
 */

export type SeriesPoint = { date: string; value: number };

export type Series = {
  key: string;
  label: string;
  color: string;
  points: SeriesPoint[];
};

const VIEW_W = 720;
const VIEW_H = 200;
const PAD_X = 8;
const PAD_Y = 12;

export function LineChart({ series, height = 200 }: { series: Series[]; height?: number }) {
  const { t } = useT();
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const dates = series[0]?.points.map((p) => p.date) ?? [];
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value)));

  const paths = useMemo(() => {
    return series.map((s) => {
      const step = s.points.length > 1 ? (VIEW_W - PAD_X * 2) / (s.points.length - 1) : 0;
      const points = s.points.map((point, i) => {
        const x = PAD_X + i * step;
        const y = VIEW_H - PAD_Y - (point.value / max) * (VIEW_H - PAD_Y * 2);
        return { x, y, ...point };
      });
      return {
        ...s,
        coords: points,
        line: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        area:
          points.length > 0
            ? `M${points[0].x.toFixed(1)},${(VIEW_H - PAD_Y).toFixed(1)} ` +
              points.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
              ` L${points[points.length - 1].x.toFixed(1)},${(VIEW_H - PAD_Y).toFixed(1)} Z`
            : '',
      };
    });
  }, [series, max]);

  if (dates.length === 0) return <EmptyNote />;

  return (
    <div dir="ltr">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-micro text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full"
          style={{ height }}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('الحجم عبر الزمن')}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            const index = Math.round(ratio * (dates.length - 1));
            setHover(Math.max(0, Math.min(dates.length - 1, index)));
          }}
        >
          <defs>
            {paths.map((s) => (
              <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* Horizontal guides. Four is enough to read a level against without
              turning the plot into graph paper. */}
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
            <line
              key={fraction}
              x1={PAD_X}
              x2={VIEW_W - PAD_X}
              y1={PAD_Y + fraction * (VIEW_H - PAD_Y * 2)}
              y2={PAD_Y + fraction * (VIEW_H - PAD_Y * 2)}
              stroke="hsl(var(--border))"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {paths.map((s) => (
            <g key={s.key}>
              <path d={s.area} fill={`url(#${gradientId}-${s.key})`} />
              <path
                d={s.line}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                // Without this the line thins and thickens with the aspect
                // ratio, because preserveAspectRatio="none" scales the stroke.
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}

          {hover !== null && paths[0]?.coords[hover] && (
            <>
              <line
                x1={paths[0].coords[hover].x}
                x2={paths[0].coords[hover].x}
                y1={PAD_Y}
                y2={VIEW_H - PAD_Y}
                stroke="hsl(var(--muted-foreground))"
                strokeWidth="1"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              {paths.map((s) =>
                s.coords[hover] ? (
                  <circle
                    key={s.key}
                    cx={s.coords[hover].x}
                    cy={s.coords[hover].y}
                    r="3"
                    fill={s.color}
                    stroke="hsl(var(--card))"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </>
          )}
        </svg>

        {hover !== null && (
          <div className="pointer-events-none absolute top-0 rounded-md border border-border bg-popover px-2 py-1 text-micro shadow-md"
            style={{ insetInlineStart: `${(hover / Math.max(1, dates.length - 1)) * 100}%` }}
          >
            <div className="numeric font-medium">{dates[hover]}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="numeric font-medium">{s.points[hover]?.value ?? 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-1 flex justify-between text-micro text-muted-foreground">
        <span className="numeric">{dates[0]}</span>
        <span className="numeric">{dates[dates.length - 1]}</span>
      </div>
    </div>
  );
}
