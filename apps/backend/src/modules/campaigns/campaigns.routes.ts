import { Router } from 'express';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { campaignQueue } from '../../workers/campaign.worker';
import { getPrimarySession } from '../../utils/whatsapp-sessions';
import { requirePermission } from '../../middleware/rbac.middleware';
import {
  assertMetricAvailable,
  isQuotaExceededError,
  quotaErrorResponse,
} from '../usage/entitlements';
import {
  parseContactFilterDsl,
  contactWhereFromFilterDsl,
  type ContactFilterDsl,
} from '../../lib/contact-filter-dsl';
import { assertCampaignsInOrg } from './campaign-refs';

/**
 * Filter-compilation failures carry a message written for the user (in Arabic,
 * naming the offending field or operator). Anything else is ours and must not
 * be echoed back — an internal message in a UI toast is a leak, not a hint.
 */
function isFilterError(err: unknown): boolean {
  return err instanceof Error && typeof err.message === 'string' && err.message.length > 0
    && !/prisma|invocation|ECONN|ENOTFOUND/i.test(err.message);
}

const router = Router();
router.use(verifyToken);

/**
 * Recipients for an audience filter. One definition used by preview, create and
 * report, so the count an admin approves is the count that actually gets sent.
 *
 * Opted-out contacts are excluded **unconditionally** — there is deliberately no
 * override parameter. On the official WhatsApp API Meta enforces this; on our
 * gateway nothing does, so it is enforced here or nowhere.
 */
function audienceWhere(filter: ContactFilterDsl | null, organizationId: string) {
  return {
    ...contactWhereFromFilterDsl(filter, organizationId),
    isArchived: false,
    marketingConsent: { not: 'OPTED_OUT' as const },
  };
}


/**
 * How many contacts the filter matched but consent removed.
 *
 * Surfaced so a shrinking audience is explained rather than mysterious — an
 * admin who sees 3,605 become 3,028 with no reason given assumes the filter is
 * broken and works around it.
 */
async function countExcludedByConsent(filter: ContactFilterDsl | null, organizationId: string): Promise<number> {
  return prisma.contact.count({
    where: {
      ...contactWhereFromFilterDsl(filter, organizationId),
      isArchived: false,
      marketingConsent: 'OPTED_OUT',
    },
  });
}

/**
 * Spacing between sends. WhatsApp throttles — and eventually bans — numbers that
 * blast, so this is a safety limit rather than a tuning knob. The worker enforces
 * a queue-level limiter too; this just keeps the queue itself from bunching.
 */
const SEND_SPACING_MS = Number(process.env.CAMPAIGN_SEND_SPACING_MS || 1200);

// GET /api/campaigns
router.get('/', async (_req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      include: {
        session: true,
        _count: { select: { recipients: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(campaigns);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/campaigns/audience/preview
 * Resolved recipient count plus a sample, so an admin sees who they are about to
 * message *before* committing. Sending to the wrong segment is unrecoverable —
 * the messages have already left.
 */
router.post('/audience/preview', requirePermission('campaign:create'), async (req, res) => {
  try {
    const filter = parseContactFilterDsl(req.body?.audienceFilter);
    await assertCampaignsInOrg(filter);
    const where = audienceWhere(filter, req.user!.organizationId);
    const [count, sample, excludedOptedOut] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({
        where,
        select: { id: true, name: true, phone: true, firstName: true, lastName: true },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      countExcludedByConsent(filter, req.user!.organizationId),
    ]);
    res.json({ count, sample, excludedOptedOut });
  } catch (err) {
    // A bad filter is a user error, not a server error. Returning a bare 500
    // told the admin nothing at all — the audience count just stopped updating
    // and they had no way to know which rule was wrong.
    const status = (err as Error & { statusCode?: number }).statusCode;
    if (status) return res.status(status).json({ error: (err as Error).message });
    if (isFilterError(err)) return res.status(400).json({ error: (err as Error).message });
    logger.error('Audience preview failed', { error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/campaigns/:id/report — delivery breakdown for one campaign.
 */
router.get('/:id/report', async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, status: true, sentAt: true, scheduledAt: true },
    });
    // 404 rather than 403 for a cross-tenant id: existence is itself information.
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    const grouped = await prisma.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    });

    const counts = grouped.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});

    const failures = await prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id, status: 'failed' },
      select: { id: true, error: true, contact: { select: { name: true, phone: true } } },
      take: 20,
    });

    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    res.json({
      campaign,
      total,
      counts: {
        pending: counts.pending ?? 0,
        sent: counts.sent ?? 0,
        delivered: counts.delivered ?? 0,
        read: counts.read ?? 0,
        failed: counts.failed ?? 0,
      },
      failures,
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/campaigns
router.post('/', requirePermission('campaign:create'), async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    const { title, message, mediaUrl, scheduledAt, audienceFilter } = req.body;

    const session = await getPrimarySession();
    if (!session) return res.status(400).json({ error: 'No active WhatsApp session found' });

    const filter = parseContactFilterDsl(audienceFilter);

    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        title,
        message,
        mediaUrl,
        sessionId: session.id,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        audienceFilter: (filter as object) ?? undefined,
      },
    });

    const contacts = await prisma.contact.findMany({
      where: audienceWhere(filter, req.user!.organizationId),
      select: { id: true },
    });

    await prisma.campaignRecipient.createMany({
      data: contacts.map((c) => ({ organizationId, campaignId: campaign.id, contactId: c.id })),
      skipDuplicates: true,
    });

    res.json({ ...campaign, recipientCount: contacts.length });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/campaigns/:id/send
router.post('/:id/send', requirePermission('campaign:send'), async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: {
        recipients: { include: { contact: true } },
        session: true,
      },
    });
    if (!campaign) return res.status(404).json({ error: 'Not found' });

    // A blast with nothing to say strands the audience mid-send once the gateway
    // rejects it, so refuse before anything is queued rather than half way through.
    if (!campaign.message?.trim() && !campaign.mediaUrl) {
      return res.status(400).json({ error: 'لا يمكن إرسال حملة بدون نص أو وسائط' });
    }
    if (campaign.status === 'SENDING') {
      return res.status(409).json({ error: 'الحملة قيد الإرسال بالفعل' });
    }

    const jobs = campaign.recipients
      .filter((r) => r.status === 'pending')
      .map((r, i) => ({
        name: 'send-message',
        data: {
          organizationId,
          campaignId: campaign.id,
          recipientId: r.id,
          phone: r.contact.phone,
          message: campaign.message,
          mediaUrl: campaign.mediaUrl,
          session: campaign.session.sessionName,
        },
        // BullMQ rejects ':' in a custom job id — it is the queue's own key
        // separator. Colons here silently failed every campaign send.
        opts: { delay: i * SEND_SPACING_MS, jobId: `${organizationId}--${campaign.id}--${r.id}` },
      }));

    await assertMetricAvailable('messages_outbound', jobs.length);
    await assertMetricAvailable('campaign_sends', jobs.length);

    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'SENDING' } });
    await campaignQueue.addBulk(jobs);
    res.json({ queued: jobs.length });
  } catch (error) {
    if (isQuotaExceededError(error)) return res.status(error.status).json(quotaErrorResponse(error));
    res.status(500).json({ error: 'Server error' });
  }
});


export default router;
