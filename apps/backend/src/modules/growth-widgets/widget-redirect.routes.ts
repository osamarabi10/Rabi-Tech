import { Router } from 'express';
import { prisma } from '../../prisma';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import logger from '../../lib/logger';
import { buildWhatsAppHandoff, newClickToken } from './widget-token';

/**
 * The public widget redirect — a **category 3** exempt path.
 *
 * ## Why this file exists separately from growth-widgets.routes.ts
 *
 * This is the only unauthenticated surface in the product that writes. Keeping
 * it in its own file is not tidiness: `verify-auth-exemptions` asserts that a
 * category-3 handler contains no update, delete or upsert, and that assertion is
 * only meaningful if the file holds nothing else. The authenticated CRUD lives
 * next door precisely so this file can be checked as a whole.
 *
 * ## Category 3, and why neither existing category fit
 *
 * Category 1 means genuinely public with nothing to scope to. False here: this
 * writes a row that belongs to a tenant.
 *
 * Category 2 means scoped elsewhere — and every sibling in that category is
 * *authenticated* elsewhere, by a bearer token, an HMAC or a platform token.
 * The widget token authenticates nobody. It is printed on posters and embedded
 * in pages; everyone holding it is supposed to hold it. Filing this as
 * category 2 would have passed the gate and left an annotation claiming
 * something the code does not do.
 *
 * So: **public, tenant-derived.** Four invariants, three of them enforced by
 * the gate:
 *
 *   1. The tenant comes from a server-side lookup keyed by the public token,
 *      never from anything the caller supplies. Nothing in this file reads an
 *      organization id off the request, and the gate asserts that.
 *   2. It enters that tenant's scope before writing.
 *   3. It is rate-limited by IP, declared in LIMITS and mounted in index.ts.
 *   4. It only ever appends. An anonymous caller must not mutate existing rows.
 *
 * ## What the click count is worth
 *
 * Nothing, as evidence. Anyone can call this endpoint; the rate limit bounds a
 * flood, it does not make the number true. A *contact* cannot be forged the
 * same way — it costs the sender a real WhatsApp message from a real number.
 * The sources report leads with contacts for that reason, and deliberately does
 * not compute a click-to-contact rate: the numerator is trustworthy and the
 * denominator is attacker-controlled, and a ratio between them would look
 * meaningful while meaning nothing.
 */
const router = Router();

/** Only the first 200 characters. This is analytics, not a forensic log. */
const trim = (value: unknown, max = 200): string | null => {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
};

router.get('/go/:publicToken', async (req, res) => {
  const { publicToken } = req.params;

  try {
    /*
      Resolving the tenant. This is the one read that cannot be organization
      scoped, because the whole point is that the caller has not told us which
      organization they belong to and must not be able to. The same shape as
      `meta-webhook:resolve-phone-number-id`: a narrow, named, read-only lookup
      in platform scope whose only output is an organization id.
    */
    const widget = await runAsPlatform('widget-redirect:resolve-token', () =>
      prisma.growthWidget.findUnique({
        where: { publicToken },
        select: {
          id: true,
          organizationId: true,
          prefillText: true,
          isArchived: true,
          session: { select: { phoneNumber: true } },
        },
      }));

    /*
      One response for "no such widget" and for "archived". A distinguishable
      404 would let anyone enumerate which tokens exist, and a widget token is
      printed on things — the set of valid ones is not something to help someone
      map out.
    */
    if (!widget || widget.isArchived || !widget.session?.phoneNumber) {
      return res.status(404).send('This link is no longer active.');
    }

    const clickToken = newClickToken();

    /*
      The only write, and it is an insert. Everything the browser knows lives
      for exactly this one request: the page the link was on, the referrer, the
      campaign parameters. If they are not written here they are not recoverable
      from anywhere, by anyone, afterwards.

      Its own try/catch, and that placement is the point. A failure to record
      the click must not cost the visitor their conversation — attribution is
      the second most important thing happening on this request; the first is
      that somebody who wants to talk to this business gets to. So a write
      failure is logged and the redirect still happens, unattributed. Letting
      the outer catch handle it would turn a analytics failure into a dead link.
    */
    try {
      await runAsOrganization(widget.organizationId, () =>
        prisma.widgetClick.create({
          data: {
            organizationId: widget.organizationId,
            widgetId: widget.id,
            clickToken,
            sourceUrl: trim(req.query.su) || trim(req.get('referer'), 500),
            referrer: trim(req.get('referer'), 500),
            utmSource: trim(req.query.utm_source, 100),
            utmMedium: trim(req.query.utm_medium, 100),
            utmCampaign: trim(req.query.utm_campaign, 100),
            utmTerm: trim(req.query.utm_term, 100),
            utmContent: trim(req.query.utm_content, 100),
            userAgent: trim(req.get('user-agent'), 200),
          },
        }));
    } catch (writeError) {
      logger.error('Widget click not recorded; redirecting anyway', {
        publicToken, organizationId: widget.organizationId, error: writeError,
      });
    }

    return res.redirect(
      302,
      buildWhatsAppHandoff(widget.session.phoneNumber, widget.prefillText, clickToken),
    );
  } catch (error) {
    // Reaching here means the lookup itself failed, so there is no destination
    // to send anyone to.
    logger.error('Widget redirect failed', { publicToken, error });
    return res.status(404).send('This link is no longer active.');
  }
});

export default router;
