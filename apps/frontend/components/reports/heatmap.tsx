'use client';

import { useT } from '@/lib/i18n';
import type { HeatmapCell } from '@/lib/data';
import { EmptyNote } from './primitives';

/**
 * Volume by hour-of-day and day-of-week — the staffing chart.
 *
 * Laid out `dir="ltr"` regardless of interface language. The grid is a
 * time axis, and time runs left-to-right in every locale this product ships in;
 * mirroring it in Arabic would put midnight on the right and make the chart
 * read backwards against every other clock the user looks at.
 *
 * Intensity is scaled against the busiest cell rather than an absolute scale,
 * because the question is "when are we busiest", which is relative by nature.
 */

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function VolumeHeatmap({ cells }: { cells: HeatmapCell[] }) {
  const { t } = useT();

  // Locale-independent, and short enough to fit the row label column.
  const DAY_KEYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  const byKey = new Map(cells.map((c) => [`${c.dayOfWeek}-${c.hour}`, c]));
  const max = Math.max(0, ...cells.map((c) => c.inbound + c.outbound));

  if (max === 0) return <EmptyNote />;

  return (
    <div className="overflow-x-auto" dir="ltr">
      <table className="w-full min-w-[640px] border-separate border-spacing-[2px]">
        <thead>
          <tr>
            <th className="w-16" />
            {HOURS.map((hour) => (
              <th
                key={hour}
                className="numeric text-micro font-normal text-muted-foreground"
                // Every third hour, so the axis stays readable at this size.
                aria-label={`${hour}:00`}
              >
                {hour % 3 === 0 ? hour : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAY_KEYS.map((dayKey, dayOfWeek) => (
            <tr key={dayKey}>
              <th className="w-16 pe-1 text-end text-micro font-normal text-muted-foreground">
                {t(dayKey)}
              </th>
              {HOURS.map((hour) => {
                const cell = byKey.get(`${dayOfWeek}-${hour}`);
                const total = cell ? cell.inbound + cell.outbound : 0;
                const intensity = total / max;
                return (
                  <td
                    key={hour}
                    title={`${t(dayKey)} ${hour}:00 — ${total}`}
                    className="h-5 rounded-sm"
                    style={{
                      // color-mix rather than an alpha suffix: the primary is a
                      // token, and `hsl(var(--primary))20` is not valid CSS —
                      // it fails silently and the whole grid renders blank.
                      backgroundColor:
                        total === 0
                          ? 'hsl(var(--muted))'
                          : `color-mix(in srgb, hsl(var(--primary)) ${Math.round(
                              12 + intensity * 88,
                            )}%, transparent)`,
                    }}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-caption text-muted-foreground">
        {t('الأعمدة ساعات اليوم بتوقيتك المحلي')}
      </p>
    </div>
  );
}
