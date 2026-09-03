import { Router } from 'express';
import { prisma } from '../../prisma';
import { requirePermission } from '../../middleware/rbac.middleware';
import { auditLog } from '../../lib/audit';
import { newWidgetToken } from './widget-token';

/**
 * Tenant-facing management of growth widgets.
 *
 * The public redirect deliberately lives in `widget-redirect.routes.ts` rather
 * than here — it is the only unauthenticated write in the product, and the gate
 * that checks it is append-only can only do so if its file contains nothing
 * else. This file updates and archives, which is exactly what must not sit
 * beside the anonymous handler.
 */
const router = Router();

/** The link a subscriber hands out. Absolute so it survives being pasted anywhere. */
function widgetUrl(publicToken: string): string {
  const base = (process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/api/widgets/go/${publicToken}`;
}

router.get('/', requirePermission('system:config'), async (_req, res) => {
  try {
    const widgets = await prisma.growthWidget.findMany({
      where: { isArchived: false },
      orderBy: { createdAt: 'desc' },
      include: {
        session: { select: { id: true, sessionName: true, phoneNumber: true } },
        _count: { select: { clicks: true, contacts: true } },
      },
    });

    res.json(widgets.map((w) => ({
      id: w.id,
      name: w.name,
      type: w.type,
      publicToken: w.publicToken,
      url: widgetUrl(w.publicToken),
      prefillText: w.prefillText,
      sessionId: w.sessionId,
      sessionName: w.session?.sessionName ?? null,
      phoneNumber: w.session?.phoneNumber ?? null,
      // Both counts are shown together on purpose. Clicks alone would be read as
      // performance, and clicks are not verifiable — see the redirect's header.
      clicks: w._count.clicks,
      contacts: w._count.contacts,
      createdAt: w.createdAt,
    })));
  } catch {
    res.status(500).json({ error: 'Failed to load growth widgets' });
  }
});

router.post('/', requirePermission('system:config'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const sessionId = String(req.body?.sessionId || '').trim();
    const prefillText = String(req.body?.prefillText || '').trim();

    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!sessionId) return res.status(400).json({ error: 'A channel is required' });

    // Scoped by the tenant context, so this cannot find another organization's
    // session even if its id were guessed.
    const session = await prisma.whatsappSession.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: 'Channel not found' });
    if (!session.phoneNumber) {
      return res.status(400).json({ error: 'That channel has no phone number yet' });
    }

    const widget = await prisma.growthWidget.create({
      data: {
        organizationId: session.organizationId,
        name,
        type: 'CHAT_LINK',
        publicToken: newWidgetToken(),
        sessionId,
        prefillText,
      },
    });

    await auditLog({
      action: 'growth_widget.created',
      resource: 'growth_widget',
      resourceId: widget.id,
      description: name,
    });

    res.status(201).json({
      id: widget.id,
      name: widget.name,
      type: widget.type,
      publicToken: widget.publicToken,
      url: widgetUrl(widget.publicToken),
      prefillText: widget.prefillText,
      sessionId: widget.sessionId,
      clicks: 0,
      contacts: 0,
      createdAt: widget.createdAt,
    });
  } catch {
    res.status(500).json({ error: 'Failed to create growth widget' });
  }
});

/**
 * Archive rather than delete, and the reason is physical.
 *
 * A widget's token may be printed on a poster, a card or a sticker that nobody
 * can recall. Deleting the row would make every one of those dead, and would
 * also hit the RESTRICT on `Contact.acquisitionWidgetId` — the contacts it
 * produced still point at it, and their provenance is the entire feature.
 * Archiving stops the link working and keeps the history readable.
 */
router.post('/:id/archive', requirePermission('system:config'), async (req, res) => {
  try {
    const existing = await prisma.growthWidget.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Widget not found' });

    await prisma.growthWidget.update({
      where: { id: req.params.id },
      data: { isArchived: true },
    });

    await auditLog({
      action: 'growth_widget.archived',
      resource: 'growth_widget',
      resourceId: req.params.id,
      description: existing.name,
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to archive growth widget' });
  }
});

export default router;
