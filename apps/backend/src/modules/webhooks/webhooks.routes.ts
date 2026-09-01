import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { verifyToken } from '../auth/auth.middleware';
import { requireAdmin, requirePermission } from '../../middleware/rbac.middleware';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_GROUPS,
  isWebhookEvent,
  type WebhookEvent,
} from './webhook-events';
import { generateWebhookSecret } from './webhook-signature';
import { deliverOnce } from '../../workers/webhook-delivery.worker';
import {
  DEACTIVATE_AFTER_FAILURES,
  DEACTIVATE_WINDOW_MINUTES,
  newDeliveryId,
  newEventId,
} from './webhook-policy';

/**
 * Managing outbound webhook endpoints, from the console.
 *
 * Guarded by `requireAdmin` **and** `requirePermission('system:config')`, the
 * same pairing as API tokens: the first is the role floor, the second is what
 * makes `restrictWorkspaceSettings` actually withdraw this screen. A route
 * guarded by `requireAdmin` alone is invisible to the restriction table.
 */

const router = Router();
router.use(verifyToken, requireAdmin, requirePermission('system:config'));

/** Theirs is 35 per workspace; matched rather than guessed at. */
const MAX_ENDPOINTS = 35;
const MAX_NAME_LENGTH = 60;

/**
 * What a listed endpoint exposes.
 *
 * `secret` is absent and must stay absent. It is returned exactly once, when
 * the endpoint is created or its secret is rotated — the same rule as an API
 * token, for the same reason: a value that can be read back later is one that
 * leaks from wherever it is readable.
 */
const ENDPOINT_SELECT = {
  id: true,
  name: true,
  url: true,
  events: true,
  isActive: true,
  disabledAt: true,
  disabledReason: true,
  lastDeliveryAt: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/**
 * Reject a URL we should not be asked to call.
 *
 * HTTPS only in production, and never a private or loopback address. Without
 * this, a webhook endpoint is a request forgery primitive: a subscriber — or
 * anyone who compromises one admin account — can point it at `127.0.0.1` or a
 * cloud metadata address and have *our* server make that request from inside
 * our own network, then read the response body out of the delivery log.
 *
 * Plain HTTP stays allowed outside production because that is how an integrator
 * tests against a laptop.
 */
function urlProblem(raw: unknown): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return 'عنوان الويب هوك مطلوب';

  let url: URL;
  try { url = new URL(text); } catch { return 'عنوان غير صالح'; }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'العنوان لازم يكون http أو https';
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    return 'العنوان لازم يكون https';
  }

  const host = url.hostname.toLowerCase();
  const isPrivate =
    host === 'localhost'
    || host === '::1'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isPrivate && process.env.NODE_ENV === 'production') {
    return 'ما بنقدر نبعت لعنوان داخلي';
  }
  return null;
}

function validEvents(raw: unknown): { events: WebhookEvent[] } | { error: string; details?: unknown } {
  const list = Array.isArray(raw) ? raw : [];
  const unknown = list.filter((event) => !isWebhookEvent(event));
  if (unknown.length) return { error: 'حدث غير معروف', details: unknown };
  const events = [...new Set(list)] as WebhookEvent[];
  if (!events.length) return { error: 'اختر حدث واحد على الأقل' };
  return { events };
}

/** The catalogue, so the console never hardcodes a list the server may outgrow. */
router.get('/events', (_req, res) => {
  res.json({
    events: WEBHOOK_EVENTS,
    groups: WEBHOOK_EVENT_GROUPS,
    autoDisable: { failures: DEACTIVATE_AFTER_FAILURES, windowMinutes: DEACTIVATE_WINDOW_MINUTES },
  });
});

router.get('/', async (req, res) => {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      select: ENDPOINT_SELECT,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    });
    res.json({ endpoints });
  } catch (err: any) {
    logger.error('Failed to list webhook endpoints', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر جلب الويب هوكس' });
  }
});

router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'اسم الويب هوك مطلوب' });
    if (name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `الاسم طويل جدًا (الحد ${MAX_NAME_LENGTH} حرفًا)` });
    }

    const problem = urlProblem(req.body?.url);
    if (problem) return res.status(400).json({ error: problem });

    const events = validEvents(req.body?.events);
    if ('error' in events) return res.status(400).json(events);

    const count = await prisma.webhookEndpoint.count();
    if (count >= MAX_ENDPOINTS) {
      return res.status(409).json({ error: `وصلت الحد الأقصى (${MAX_ENDPOINTS} ويب هوك)` });
    }

    const secret = generateWebhookSecret();
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        organizationId: getTenantId(),
        name,
        url: String(req.body.url).trim(),
        secret,
        events: events.events,
        createdById: req.user?.id ?? null,
      },
      select: ENDPOINT_SELECT,
    });

    logger.info('Webhook endpoint created', {
      endpointId: endpoint.id,
      events: endpoint.events,
      byUserId: req.user?.id,
    });

    res.status(201).json({
      endpoint: { ...endpoint, secret },
      warning: 'انسخ المفتاح السري الآن — ما رح يظهر مرة تانية',
    });
  } catch (err: any) {
    logger.error('Failed to create webhook endpoint', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر إنشاء الويب هوك' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true, isActive: true },
    });
    if (!existing) return res.status(404).json({ error: 'الويب هوك غير موجود' });

    const data: any = {};

    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'اسم الويب هوك مطلوب' });
      data.name = name.slice(0, MAX_NAME_LENGTH);
    }

    if (req.body?.url !== undefined) {
      const problem = urlProblem(req.body.url);
      if (problem) return res.status(400).json({ error: problem });
      data.url = String(req.body.url).trim();
    }

    if (req.body?.events !== undefined) {
      const events = validEvents(req.body.events);
      if ('error' in events) return res.status(400).json(events);
      data.events = events.events;
    }

    /*
      Re-enabling clears the reason, deliberately.

      A stale "turned off automatically after 30 failures" sitting on a working
      endpoint is worse than no message: the next person to look believes it is
      still broken. The reason describes the *current* state or it is not there.
    */
    if (req.body?.isActive !== undefined) {
      data.isActive = !!req.body.isActive;
      if (data.isActive) {
        data.disabledAt = null;
        data.disabledReason = null;
      } else if (existing.isActive) {
        // Only when it was actually on. Re-sending isActive:false on an
        // already-off endpoint must not overwrite the reason it went off — that
        // sentence is often the only record of what went wrong.
        data.disabledAt = new Date();
        data.disabledReason = 'Turned off by an administrator.';
      }
    }

    const endpoint = await prisma.webhookEndpoint.update({
      where: { id: existing.id },
      data,
      select: ENDPOINT_SELECT,
    });
    res.json({ endpoint });
  } catch (err: any) {
    logger.error('Failed to update webhook endpoint', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر تحديث الويب هوك' });
  }
});

/**
 * Rotate the signing secret.
 *
 * Immediate rather than overlapping: the moment this returns, the old secret
 * verifies nothing. That is the blunt version, and it is the right one to ship
 * first — a rotation that leaves the old secret working is not a rotation, and
 * the case for rotating at all is usually that the old one leaked. The console
 * says so before the button is pressed.
 */
router.post('/:id/rotate-secret', async (req, res) => {
  try {
    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: 'الويب هوك غير موجود' });

    const secret = generateWebhookSecret();
    await prisma.webhookEndpoint.update({ where: { id: existing.id }, data: { secret } });

    logger.info('Webhook secret rotated', { endpointId: existing.id, byUserId: req.user?.id });
    res.json({ secret, warning: 'انسخ المفتاح الجديد الآن — ما رح يظهر مرة تانية' });
  } catch (err: any) {
    logger.error('Failed to rotate webhook secret', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر تدوير المفتاح' });
  }
});

/**
 * Send a test delivery.
 *
 * The single most useful thing on this screen. Configuring a webhook otherwise
 * means saving it and then waiting for a real event to find out whether the URL
 * was right — and the events worth subscribing to are the ones you cannot make
 * happen on demand.
 *
 * Delivered synchronously and *not* retried: the caller is a human watching a
 * spinner, and the answer they need is what happened on the first attempt.
 */
router.post('/:id/test', async (req, res) => {
  try {
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true, isActive: true },
    });
    if (!endpoint) return res.status(404).json({ error: 'الويب هوك غير موجود' });
    if (!endpoint.isActive) {
      return res.status(409).json({ error: 'الويب هوك متوقف — فعّله أولًا' });
    }

    const result = await deliverOnce({
      organizationId: getTenantId(),
      endpointId: endpoint.id,
      envelope: {
        id: newDeliveryId(),
        event: { id: newEventId(), type: 'contact.updated', occurredAt: new Date().toISOString() },
        workspace: { id: getTenantId() },
        // Marked, so a receiver in production can ignore it rather than
        // acting on a contact that does not exist.
        data: { test: true, message: 'This is a test delivery from RabiTech.' },
      },
      attempt: 1,
    });

    // The outcome is in the delivery log either way, which is where the console
    // reads the status code and response body from — so the answer here is
    // deliberately just "did it work".
    res.json({ ok: result.ok });
  } catch (err: any) {
    logger.error('Webhook test delivery failed', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر إرسال التجربة' });
  }
});

/**
 * The delivery log — the thing Respond.io does not have.
 *
 * Their webhooks ship without one and it is an open feature request against
 * them. Without it, "did you send it?" is unanswerable by both parties and the
 * subscriber's only recourse is to ask us to read a server log.
 */
router.get('/:id/deliveries', async (req, res) => {
  try {
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true },
    });
    if (!endpoint) return res.status(404).json({ error: 'الويب هوك غير موجود' });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const deliveries = await prisma.webhookDeliveryLog.findMany({
      where: {
        webhookId: endpoint.id,
        direction: 'OUTBOUND',
        ...(req.query.failedOnly === 'true' ? { ok: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventType: true,
        statusCode: true,
        ok: true,
        errorMessage: true,
        responseBody: true,
        durationMs: true,
        attempt: true,
        createdAt: true,
      },
    });

    res.json({ deliveries });
  } catch (err: any) {
    logger.error('Failed to read webhook deliveries', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر جلب سجل الإرسال' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await prisma.webhookEndpoint.deleteMany({ where: { id: String(req.params.id) } });
    if (result.count === 0) return res.status(404).json({ error: 'الويب هوك غير موجود' });

    // The delivery log rows survive on purpose — there is no foreign key. "What
    // did we send them before you deleted it" is exactly the question asked
    // afterwards, and a cascade would have destroyed the answer.
    logger.info('Webhook endpoint deleted', { endpointId: req.params.id, byUserId: req.user?.id });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Failed to delete webhook endpoint', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر حذف الويب هوك' });
  }
});

export default router;
