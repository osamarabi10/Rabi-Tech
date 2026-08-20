import { Router } from 'express';
import type { AutoReplyKind } from '@prisma/client';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { invalidateAutoReplyCache } from '../../utils/auto-reply';

const router = Router();
router.use(verifyToken);

const AUTO_REPLY_KINDS: AutoReplyKind[] = [
  'WELCOME',
  'OUT_OF_HOURS',
  'CSAT_PROMPT',
  'CSAT_THANKS',
  'CONVERSATION_CLOSED',
  'AWAITING_CLIENT',
  'KEYWORD_CRITICAL',
  'KEYWORD_HIGH',
  'KEYWORD_MEDIUM',
  'KEYWORD_LOW',
];

/**
 * GET /api/templates/auto-replies
 * Every auto-reply kind with the organization's configured row (or null).
 * A null row, or isActive === false, means that auto-reply is never sent.
 */
router.get('/auto-replies', async (_req, res) => {
  try {
    const rows = await prisma.messageTemplate.findMany({
      where: { autoReplyKind: { not: null } },
      select: { id: true, autoReplyKind: true, title: true, body: true, isActive: true, updatedAt: true },
    });
    const byKind = new Map(rows.map((r) => [r.autoReplyKind as AutoReplyKind, r]));
    res.json(
      AUTO_REPLY_KINDS.map((kind) => ({
        kind,
        configured: byKind.has(kind),
        template: byKind.get(kind) ?? null,
      })),
    );
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/templates/auto-replies/:kind — admin only.
 * Body: { body?: string, title?: string, isActive?: boolean }
 * Sending isActive:false (or deleting the row) stops that auto-reply entirely.
 */
router.put('/auto-replies/:kind', requireAdmin, async (req, res) => {
  try {
    const kind = req.params.kind as AutoReplyKind;
    if (!AUTO_REPLY_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'Unknown auto-reply kind' });
    }
    const { body, title, isActive } = req.body as {
      body?: string; title?: string; isActive?: boolean;
    };
    if (body !== undefined && !String(body).trim()) {
      return res.status(400).json({ error: 'نص الرد لا يمكن أن يكون فارغاً' });
    }

    const organizationId = req.user!.organizationId;
    const existing = await prisma.messageTemplate.findFirst({
      where: { autoReplyKind: kind },
      select: { id: true },
    });

    const saved = existing
      ? await prisma.messageTemplate.update({
          where: { id: existing.id },
          data: {
            ...(body !== undefined ? { body: String(body).trim() } : {}),
            ...(title !== undefined ? { title: String(title).trim() } : {}),
            ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
          },
        })
      : await prisma.messageTemplate.create({
          data: {
            organizationId,
            autoReplyKind: kind,
            category: 'AUTO_REPLY',
            title: String(title || kind).trim(),
            body: String(body || '').trim(),
            isActive: isActive ?? true,
          },
        });

    invalidateAutoReplyCache(kind);
    res.json(saved);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/templates/auto-replies/:kind — removes it entirely; nothing will be sent. */
router.delete('/auto-replies/:kind', requireAdmin, async (req, res) => {
  try {
    const kind = req.params.kind as AutoReplyKind;
    if (!AUTO_REPLY_KINDS.includes(kind)) {
      return res.status(400).json({ error: 'Unknown auto-reply kind' });
    }
    const existing = await prisma.messageTemplate.findFirst({
      where: { autoReplyKind: kind },
      select: { id: true },
    });
    if (existing) await prisma.messageTemplate.delete({ where: { id: existing.id } });
    invalidateAutoReplyCache(kind);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/templates?category=&teamId=&shortCode=
router.get('/', async (req, res) => {
  try {
    const { category, teamId, active, shortCode } = req.query;
    const templates = await prisma.messageTemplate.findMany({
      where: {
        ...(category ? { category: category as any } : {}),
        ...(teamId ? { teamId: teamId as string } : {}),
        ...(active === 'true' ? { isActive: true } : {}),
        ...(shortCode ? { shortCode: { startsWith: shortCode as string, mode: 'insensitive' } } : {}),
      },
      include: { team: { select: { id: true, name: true, slug: true, color: true } } },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
    res.json(templates);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/templates
router.post('/', async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    const { title, body, category, teamId, sortOrder, shortCode } = req.body;
    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ error: 'العنوان والنص مطلوبان' });
    }
    const template = await prisma.messageTemplate.create({
      data: {
        organizationId,
        title: title.trim(),
        body: body.trim(),
        category: category || 'QUICK_REPLY',
        teamId: teamId || null,
        sortOrder: sortOrder ?? 0,
        shortCode: shortCode?.trim() || null,
      },
    });
    res.status(201).json(template);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'هذا الرمز المختصر مستخدم بالفعل' });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/templates/:id
router.patch('/:id', async (req, res) => {
  try {
    const { title, body, category, teamId, sortOrder, isActive, shortCode } = req.body;
    const template = await prisma.messageTemplate.update({
      where: { id: req.params.id },
      data: {
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(body !== undefined ? { body: body.trim() } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(teamId !== undefined ? { teamId: teamId || null } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
        ...(shortCode !== undefined ? { shortCode: shortCode?.trim() || null } : {}),
      },
    });
    res.json(template);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'هذا الرمز المختصر مستخدم بالفعل' });
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/templates/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.messageTemplate.delete({ where: { id: req.params.id } });
    res.sendStatus(204);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
