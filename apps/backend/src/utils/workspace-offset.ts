import { getTenantId } from '../lib/tenant-context';
import { prisma } from '../prisma';

/**
 * The workspace's own clock, as minutes east of UTC.
 *
 * ## Why reports must not use the viewer's offset
 *
 * They did. `analytics.routes.ts` read `utcOffsetMinutes` from the query string,
 * which the browser filled from `Date.getTimezoneOffset()`. Two managers in
 * different countries opening the same weekly report therefore saw **different
 * numbers for the same week** — a message at 23:30 in Jerusalem falls in
 * Tuesday for one viewer and Wednesday for the other.
 *
 * That is worse than being wrong in a fixed direction. A wrong number can be
 * corrected; a number that differs by who is looking cannot even be discussed,
 * because the two people are not talking about the same quantity.
 *
 * The intent was always the business's clock — the comment at the old call site
 * said so outright: *"The staffing question is about the business's clock, not
 * UTC."* The viewer's offset was standing in for it, and usually matched,
 * which is why it survived.
 *
 * ## The heatmap is not an exception
 *
 * It looks like one — "when do messages arrive" sounds like a question about
 * the person asking. It is not: it is a staffing question, and two managers
 * rostering the same team have to agree on when the peak is. A heatmap that
 * shifts three hours depending on who opens it cannot be used to schedule
 * anybody.
 *
 * There is currently **no report that legitimately wants viewer-local time**.
 * If one appears — a personal "my day" view — it should take the offset
 * explicitly and say why at the call site.
 *
 * ## DST is approximated, deliberately and unchanged
 *
 * One offset is resolved for the period rather than per timestamp. A period
 * spanning a DST change is off by an hour on one side of it. That is the
 * approximation the previous implementation already made, and fixing it means a
 * zone conversion per message rather than per report — a real cost on the
 * largest table in the schema, for an hour's skew twice a year. Recorded rather
 * than silently inherited.
 */

/** Minutes east of UTC for an IANA zone at a given instant. */
export function offsetMinutesFor(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);

    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    // `Date.UTC` on the zone's wall-clock reading gives the same instant
    // expressed as if it were UTC; the difference is the offset.
    const asUtc = Date.UTC(
      get('year'), get('month') - 1, get('day'),
      get('hour') % 24, get('minute'), get('second'),
    );
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    // An unknown zone must not fail a report. UTC is the honest fallback: it is
    // wrong by a fixed, explainable amount rather than by a hidden one.
    return 0;
  }
}

/**
 * The current tenant's configured offset.
 *
 * Falls back to the schema default rather than to the caller's clock — the
 * whole point is that no report depends on who is asking.
 */
export async function workspaceOffsetMinutes(at: Date = new Date()): Promise<number> {
  const config = await prisma.organizationConfig.findUnique({
    where: { organizationId: getTenantId() },
    select: { timezone: true },
  });
  return offsetMinutesFor(config?.timezone || 'Asia/Jerusalem', at);
}
