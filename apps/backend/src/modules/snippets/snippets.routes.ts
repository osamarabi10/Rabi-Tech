import fs from 'fs/promises';
import express, { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { requireSupervisor } from '../../middleware/rbac.middleware';
import { auditLog } from '../../lib/audit';
import { runAsOrganization } from '../../lib/tenant-context';
import {
  MAX_SNIPPET_FILES,
  cleanSnippetFileName,
  newStorageKey,
  removeSnippetAsset,
  snippetAssetPath,
  snippetAssetUrl,
  storeSnippetAsset,
  validateSnippetUpload,
  verifySnippetAssetSignature,
} from './snippet-storage';

const router = Router();
const MAX_SNIPPETS = 5000;
const MAX_TOPICS = 10;

const snippetInclude = {
  snippetTopics: { include: { topic: true }, orderBy: { topic: { name: 'asc' as const } } },
  attachments: { orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }] },
} satisfies Prisma.MessageTemplateInclude;

type SnippetRow = Prisma.MessageTemplateGetPayload<{ include: typeof snippetInclude }>;

function present(row: SnippetRow) {
  return {
    ...row,
    topics: row.snippetTopics.map((entry) => entry.topic),
    attachments: row.attachments.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      sortOrder: file.sortOrder,
      url: snippetAssetUrl(file.organizationId, file.storageKey),
    })),
    snippetTopics: undefined,
  };
}

function cleanText(value: unknown, field: string, max: number): string {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} must be ${max} characters or less`);
  return text;
}

function cleanOptionalShortcut(value: unknown): string | null {
  const shortcut = String(value || '').trim().replace(/^\/+/, '');
  if (!shortcut) return null;
  if (shortcut.length > 80 || /\s/.test(shortcut)) throw new Error('Shortcut must be one word and 80 characters or less');
  return shortcut;
}

function cleanTopicIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('topicIds must be an array');
  const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length > MAX_TOPICS) throw new Error(`A Snippet can have up to ${MAX_TOPICS} topics`);
  return ids;
}

async function findSnippet(id: string) {
  return prisma.messageTemplate.findFirst({ where: { id, category: 'QUICK_REPLY' }, include: snippetInclude });
}

// Signed assets are deliberately available before JWT auth. OpenWA fetches the
// URL server-to-server; the unguessable signature is the authorization.
router.get('/assets/:organizationId/:storageKey', async (req, res) => {
  try {
    const { organizationId, storageKey } = req.params;
    if (!verifySnippetAssetSignature(organizationId, storageKey, String(req.query.sig || ''))) {
      return res.status(404).json({ error: 'Snippet asset not found' });
    }
    const row = await runAsOrganization(organizationId, () => prisma.snippetAttachment.findFirst({
      where: { storageKey },
      select: { contentType: true, fileName: true },
    }));
    if (!row) return res.status(404).json({ error: 'Snippet asset not found' });
    const body = await fs.readFile(snippetAssetPath(organizationId, storageKey));
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(body);
  } catch {
    res.status(404).json({ error: 'Snippet asset not found' });
  }
});

router.use(verifyToken);

router.get('/topics', async (_req, res) => {
  try {
    const topics = await prisma.snippetTopic.findMany({
      include: { _count: { select: { snippets: true } } },
      orderBy: { name: 'asc' },
    });
    res.json(topics.map((topic) => ({ ...topic, snippetCount: topic._count.snippets, _count: undefined })));
  } catch {
    res.status(500).json({ error: 'Failed to load Snippet topics' });
  }
});

router.post('/topics', requireSupervisor, async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 'Topic name', 50);
    const topic = await prisma.snippetTopic.create({ data: { organizationId: req.user!.organizationId, name } });
    await auditLog({ userId: req.user!.id, action: 'snippet.topic.created', resource: 'snippet-topic', resourceId: topic.id, changes: { after: topic }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.status(201).json({ ...topic, snippetCount: 0 });
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'A topic with this name already exists' });
    res.status(400).json({ error: String(error?.message || error) });
  }
});

router.delete('/topics/:id', requireSupervisor, async (req, res) => {
  try {
    const topic = await prisma.snippetTopic.findFirst({ where: { id: req.params.id } });
    if (!topic) return res.status(404).json({ error: 'Snippet topic not found' });
    await prisma.snippetTopic.delete({ where: { id: topic.id } });
    await auditLog({ userId: req.user!.id, action: 'snippet.topic.deleted', resource: 'snippet-topic', resourceId: topic.id, changes: { before: topic }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.sendStatus(204);
  } catch {
    res.status(500).json({ error: 'Failed to delete Snippet topic' });
  }
});

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const topicId = String(req.query.topicId || '').trim();
    const rows = await prisma.messageTemplate.findMany({
      where: {
        category: 'QUICK_REPLY',
        ...(req.query.active === 'true' ? { isActive: true } : {}),
        ...(topicId === '__none__' ? { snippetTopics: { none: {} } } : topicId ? { snippetTopics: { some: { topicId } } } : {}),
        ...(q ? { OR: [
          { id: { contains: q, mode: 'insensitive' } },
          { title: { contains: q, mode: 'insensitive' } },
          { body: { contains: q, mode: 'insensitive' } },
          { shortCode: { contains: q.replace(/^\//, ''), mode: 'insensitive' } },
        ] } : {}),
      },
      include: snippetInclude,
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
      take: 5000,
    });
    res.json(rows.map(present));
  } catch {
    res.status(500).json({ error: 'Failed to load Snippets' });
  }
});

router.post('/', requireSupervisor, async (req, res) => {
  try {
    if (await prisma.messageTemplate.count({ where: { category: 'QUICK_REPLY' } }) >= MAX_SNIPPETS) {
      return res.status(409).json({ error: `A workspace can have up to ${MAX_SNIPPETS} Snippets` });
    }
    const title = cleanText(req.body?.title, 'Snippet name', 80);
    const body = cleanText(req.body?.body, 'Message', 3000);
    const shortCode = cleanOptionalShortcut(req.body?.shortCode) || title.replace(/\s+/g, '-').slice(0, 80);
    const topicIds = cleanTopicIds(req.body?.topicIds) || [];
    if (topicIds.length && await prisma.snippetTopic.count({ where: { id: { in: topicIds } } }) !== topicIds.length) {
      return res.status(400).json({ error: 'One or more Snippet topics do not exist' });
    }
    const created = await prisma.messageTemplate.create({
      data: {
        organizationId: req.user!.organizationId,
        title,
        body,
        shortCode,
        category: 'QUICK_REPLY',
        isActive: req.body?.isActive !== false,
        snippetTopics: topicIds.length ? { create: topicIds.map((topicId) => ({ topicId })) } : undefined,
      },
      include: snippetInclude,
    });
    await auditLog({ userId: req.user!.id, action: 'snippet.created', resource: 'snippet', resourceId: created.id, changes: { after: { title, shortCode, topicIds } }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.status(201).json(present(created));
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'This Snippet shortcut is already in use' });
    res.status(400).json({ error: String(error?.message || error) });
  }
});

router.patch('/:id', requireSupervisor, async (req, res) => {
  try {
    const existing = await findSnippet(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Snippet not found' });
    const topicIds = cleanTopicIds(req.body?.topicIds);
    if (topicIds && topicIds.length && await prisma.snippetTopic.count({ where: { id: { in: topicIds } } }) !== topicIds.length) {
      return res.status(400).json({ error: 'One or more Snippet topics do not exist' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      if (topicIds) {
        await tx.snippetTopicAssignment.deleteMany({ where: { templateId: existing.id } });
        if (topicIds.length) await tx.snippetTopicAssignment.createMany({ data: topicIds.map((topicId) => ({ organizationId: req.user!.organizationId, templateId: existing.id, topicId })) });
      }
      return tx.messageTemplate.update({
        where: { id: existing.id },
        data: {
          ...(req.body?.title !== undefined ? { title: cleanText(req.body.title, 'Snippet name', 80) } : {}),
          ...(req.body?.body !== undefined ? { body: cleanText(req.body.body, 'Message', 3000) } : {}),
          ...(req.body?.shortCode !== undefined ? { shortCode: cleanOptionalShortcut(req.body.shortCode) } : {}),
          ...(req.body?.isActive !== undefined ? { isActive: Boolean(req.body.isActive) } : {}),
        },
        include: snippetInclude,
      });
    });
    await auditLog({ userId: req.user!.id, action: 'snippet.updated', resource: 'snippet', resourceId: updated.id, changes: { before: present(existing), after: present(updated) }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.json(present(updated));
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'This Snippet shortcut is already in use' });
    res.status(400).json({ error: String(error?.message || error) });
  }
});

router.delete('/:id', requireSupervisor, async (req, res) => {
  try {
    const existing = await findSnippet(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Snippet not found' });
    await prisma.messageTemplate.delete({ where: { id: existing.id } });
    await Promise.all(existing.attachments.map((file) => removeSnippetAsset(file.organizationId, file.storageKey)));
    await auditLog({ userId: req.user!.id, action: 'snippet.deleted', resource: 'snippet', resourceId: existing.id, changes: { before: present(existing) }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.sendStatus(204);
  } catch {
    res.status(500).json({ error: 'Failed to delete Snippet' });
  }
});

router.post('/:id/attachments', requireSupervisor, express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    const snippet = await findSnippet(req.params.id);
    if (!snippet) return res.status(404).json({ error: 'Snippet not found' });
    if (snippet.attachments.length >= MAX_SNIPPET_FILES) return res.status(409).json({ error: `A Snippet can have up to ${MAX_SNIPPET_FILES} files` });
    const fileName = cleanSnippetFileName(req.get('x-file-name'));
    if (snippet.attachments.some((file) => file.fileName.toLocaleLowerCase() === fileName.toLocaleLowerCase())) {
      return res.status(409).json({ error: 'File names must be unique within a Snippet' });
    }
    const upload = validateSnippetUpload(req.body as Buffer, req.get('content-type'));
    const storageKey = newStorageKey();
    await storeSnippetAsset(req.user!.organizationId, storageKey, upload.body);
    try {
      const attachment = await prisma.snippetAttachment.create({ data: {
        organizationId: req.user!.organizationId,
        templateId: snippet.id,
        storageKey,
        fileName,
        contentType: upload.contentType,
        sizeBytes: upload.body.length,
        sortOrder: snippet.attachments.length,
      } });
      await auditLog({ userId: req.user!.id, action: 'snippet.file.attached', resource: 'snippet', resourceId: snippet.id, description: fileName, ipAddress: req.ip, userAgent: req.get('user-agent') });
      res.status(201).json({ id: attachment.id, fileName, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes, sortOrder: attachment.sortOrder, url: snippetAssetUrl(attachment.organizationId, attachment.storageKey) });
    } catch (error) {
      await removeSnippetAsset(req.user!.organizationId, storageKey);
      throw error;
    }
  } catch (error: any) {
    res.status(error?.code === 'P2002' ? 409 : 400).json({ error: error?.code === 'P2002' ? 'File names must be unique within a Snippet' : String(error?.message || error) });
  }
});

router.delete('/:id/attachments/:attachmentId', requireSupervisor, async (req, res) => {
  try {
    const snippet = await findSnippet(req.params.id);
    const attachment = snippet?.attachments.find((file) => file.id === req.params.attachmentId);
    if (!snippet || !attachment) return res.status(404).json({ error: 'Snippet file not found' });
    await prisma.snippetAttachment.delete({ where: { id: attachment.id } });
    await removeSnippetAsset(attachment.organizationId, attachment.storageKey);
    await auditLog({ userId: req.user!.id, action: 'snippet.file.removed', resource: 'snippet', resourceId: snippet.id, description: attachment.fileName, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.sendStatus(204);
  } catch {
    res.status(500).json({ error: 'Failed to remove Snippet file' });
  }
});

export default router;
