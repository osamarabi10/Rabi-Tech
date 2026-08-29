import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import {
  contactWhereFromFilterDsl,
  normalizeContactLimit,
  normalizeCursor,
  parseContactFilterDsl,
  filterVocabulary,
} from '../../lib/contact-filter-dsl';
import { normalizePlanCode } from '../billing/plans';
import { getEdition } from '../billing/editions.service';
import { setContactConsent } from '../../utils/consent';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { dispatchWorkflowEvent } from '../../workers/workflow.worker';
import { ImportError, importContacts } from './import.service';
import logger from '../../lib/logger';
import { requireAdmin, requirePermission, requireSupervisor } from '../../middleware/rbac.middleware';
import { contactAccessWhere, maskContact } from '../../lib/user-access';
import { auditLog } from '../../lib/audit';
import { validateCustomFieldValue } from './custom-field-validation';

/** Accepted marketing-consent values, validated before any write. */
const CONSENT_VALUES = ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT'] as const;
const CUSTOM_FIELD_TYPES = ['text', 'list', 'checkbox', 'email', 'number', 'url', 'date', 'time'] as const;
const FIELD_VISIBILITIES = ['ALWAYS_SHOW', 'HIDE_WHEN_EMPTY', 'ALWAYS_HIDE'] as const;
const STANDARD_CONTACT_FIELDS = [
  { fieldKey: 'firstName', name: 'First Name', dataType: 'text', editable: true, defaultVisibility: 'ALWAYS_SHOW' },
  { fieldKey: 'lastName', name: 'Last Name', dataType: 'text', editable: true, defaultVisibility: 'ALWAYS_SHOW' },
  { fieldKey: 'phone', name: 'Phone Number', dataType: 'phone', editable: true, defaultVisibility: 'ALWAYS_SHOW' },
  { fieldKey: 'email', name: 'Email Address', dataType: 'email', editable: true, defaultVisibility: 'HIDE_WHEN_EMPTY' },
  { fieldKey: 'countryCode', name: 'Country', dataType: 'country', editable: true, defaultVisibility: 'HIDE_WHEN_EMPTY' },
  { fieldKey: 'language', name: 'Language', dataType: 'language', editable: true, defaultVisibility: 'HIDE_WHEN_EMPTY' },
  { fieldKey: 'profilePic', name: 'Profile Picture', dataType: 'image', editable: false, defaultVisibility: 'HIDE_WHEN_EMPTY' },
] as const;

const router = Router();
router.use(verifyToken);

const CONTACT_INCLUDE = {
  assignee: { select: { id: true, name: true, role: true, primaryTeam: { select: { id: true, name: true, slug: true, color: true } } } },
  contactTags: { include: { tag: true }, orderBy: { createdAt: 'asc' as const } },
  customFieldValues: { include: { fieldDefinition: true }, orderBy: { createdAt: 'asc' as const } },
};

function normalizeSlug(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

function cleanString(value: unknown, max = 255): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
}

function cleanAllowedValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((row) => String(row || '').trim()).filter(Boolean))].slice(0, 50).map((row) => row.slice(0, 255));
}

function cleanColor(value: unknown): string {
  const color = String(value || '#64748b').trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Tag color must be a six-digit hex color');
  return color.toLowerCase();
}

function contactWhereForRef(ref: string) {
  const [kind, ...rest] = ref.split(':');
  const value = rest.join(':').trim();
  if (!value) return { id: ref };
  if (kind === 'id') return { id: value };
  if (kind === 'email') return { email: value.toLowerCase() };
  if (kind === 'phone') return { phone: value };
  return { id: ref };
}

function contactPayload(body: any) {
  const data: Record<string, unknown> = {};
  for (const field of ['name', 'firstName', 'lastName', 'email', 'language', 'profilePic', 'countryCode', 'lifecycleStage', 'assigneeId', 'notes']) {
    const value = cleanString(body?.[field], field === 'notes' ? 2000 : 255);
    if (value !== undefined) data[field] = field === 'email' && value ? value.toLowerCase() : value;
  }
  if (Array.isArray(body?.tags)) data.tags = body.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean);
  return data;
}

async function listContacts(req: any, paginated: boolean) {
  const { search } = req.query;
  const limit = normalizeContactLimit(req.query.limit);
  const cursorId = normalizeCursor(req.query.cursorId);
  const dslWhere = contactWhereFromFilterDsl(parseContactFilterDsl(req.query.filter), req.user.organizationId);
  // Search and the filter DSL are combined under AND rather than spread into one
  // object. Spreading meant a filter carrying `$or` overwrote the search's own
  // `OR` key, so typing a name while a filter was active silently ignored the
  // name and returned the unsearched list — a wrong result with no error.
  const searchWhere = search
    ? {
        OR: [
          { name: { contains: String(search), mode: 'insensitive' as const } },
          { firstName: { contains: String(search), mode: 'insensitive' as const } },
          { lastName: { contains: String(search), mode: 'insensitive' as const } },
          ...(!req.user.maskPhoneAndEmail ? [
            { email: { contains: String(search), mode: 'insensitive' as const } },
            { phone: { contains: String(search) } },
          ] : []),
        ],
      }
    : null;
  const where = {
    isArchived: false,
    AND: [searchWhere, dslWhere, contactAccessWhere(req.user)].filter(Boolean) as Prisma.ContactWhereInput[],
  };

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      include: CONTACT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: limit + (paginated ? 1 : 0),
    }),
    paginated ? prisma.contact.count({ where }) : Promise.resolve(0),
  ]);

  if (!paginated) {
    const items = contacts.slice(0, limit);
    return req.user.maskPhoneAndEmail ? items.map(maskContact) : items;
  }
  const rawItems = contacts.slice(0, limit);
  const items = req.user.maskPhoneAndEmail ? rawItems.map(maskContact) : rawItems;
  return {
    items,
    pagination: {
      cursorId: contacts.length > limit ? rawItems[rawItems.length - 1]?.id || null : null,
      hasMore: contacts.length > limit,
      total,
    },
  };
}

/**
 * GET /api/contacts/filter-schema
 *
 * The segment builder's vocabulary, served rather than hardcoded in the client.
 * Two reasons: the backend is the only place that can reject an unknown field,
 * so a client copy would drift into offering filters that 400; and custom
 * fields, tags and teams are per-organization, so half of this list cannot be
 * known at build time anyway.
 */
router.get('/filter-schema', async (req, res) => {
  try {
    const [customFields, tags, teams, campaigns] = await Promise.all([
      prisma.customFieldDefinition.findMany({
        select: { slug: true, name: true, dataType: true, allowedValues: true },
        orderBy: { name: 'asc' },
      }),
      prisma.tag.findMany({ select: { name: true }, orderBy: { name: 'asc' } }),
      prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      // Only campaigns that actually went out can appear in broadcast history.
      prisma.campaign.findMany({
        where: { sentAt: { not: null } },
        select: { id: true, title: true, sentAt: true },
        orderBy: { sentAt: 'desc' },
        take: 50,
      }),
    ]);
    res.json({ ...filterVocabulary(), customFields, tags, teams, campaigns });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

router.get('/', async (req, res) => {
  try {
    const paginated = req.query.paginated === '1' || req.query.cursorId !== undefined || req.query.filter !== undefined;
    res.json(await listContacts(req, paginated));
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

router.get('/tags', async (_req, res) => {
  const tags = await prisma.tag.findMany({
    include: { _count: { select: { contacts: true } } },
    orderBy: { name: 'asc' },
  });
  res.json(tags.map((tag) => ({ ...tag, contactCount: tag._count.contacts, _count: undefined })));
});

router.post('/tags', requireSupervisor, async (req, res) => {
  try {
    const name = cleanString(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: 'Tag name is required' });
    const tag = await prisma.tag.create({
      data: {
        organizationId: req.user!.organizationId,
        name,
        description: cleanString(req.body?.description, 255),
        colorCode: cleanColor(req.body?.colorCode),
        emoji: cleanString(req.body?.emoji, 16),
      },
    });
    await auditLog({ userId: req.user!.id, action: 'tag.created', resource: 'tag', resourceId: tag.id, changes: { after: tag }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.status(201).json({ ...tag, contactCount: 0 });
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'A Tag with this name already exists' });
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.patch('/tags/:id', requireSupervisor, async (req, res) => {
  try {
    const existing = await prisma.tag.findFirst({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Tag not found' });
    const name = req.body?.name === undefined ? existing.name : cleanString(req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Tag name is required' });
    const tag = await prisma.tag.update({
      where: { id: existing.id },
      data: {
        name,
        ...(req.body?.description !== undefined ? { description: cleanString(req.body.description, 255) } : {}),
        ...(req.body?.colorCode !== undefined ? { colorCode: cleanColor(req.body.colorCode) } : {}),
        ...(req.body?.emoji !== undefined ? { emoji: cleanString(req.body.emoji, 16) } : {}),
      },
      include: { _count: { select: { contacts: true } } },
    });
    await auditLog({ userId: req.user!.id, action: 'tag.updated', resource: 'tag', resourceId: tag.id, changes: { before: existing, after: tag }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.json({ ...tag, contactCount: tag._count.contacts, _count: undefined });
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'A Tag with this name already exists' });
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.delete('/tags/:id', requireSupervisor, async (req, res) => {
  try {
    const tag = await prisma.tag.findFirst({ where: { id: req.params.id }, include: { _count: { select: { contacts: true } } } });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    if (Number(req.body?.confirmCount) !== tag._count.contacts) {
      return res.status(409).json({ error: 'Enter the assigned Contact count to confirm deletion', expectedCount: tag._count.contacts });
    }
    await prisma.tag.delete({ where: { id: tag.id } });
    await auditLog({ userId: req.user!.id, action: 'tag.deleted', resource: 'tag', resourceId: tag.id, changes: { before: tag }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.json({ deleted: true, removedAssignments: tag._count.contacts });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.get('/custom-fields', async (_req, res) => {
  const definitions = await prisma.customFieldDefinition.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  res.json(definitions);
});

router.post('/custom-fields', requireSupervisor, async (req, res) => {
  try {
    const name = cleanString(req.body?.name, 80);
    const slug = normalizeSlug(req.body?.slug || name);
    const dataType = String(req.body?.dataType || '').trim().toLowerCase();
    if (!name || !slug) return res.status(400).json({ error: 'Custom field name is required' });
    if (!CUSTOM_FIELD_TYPES.includes(dataType as typeof CUSTOM_FIELD_TYPES[number])) {
      return res.status(400).json({ error: `dataType must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}` });
    }
    if (STANDARD_CONTACT_FIELDS.some((field) => field.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'Custom field names must differ from standard Contact fields' });
    }
    const effective = await resolveEntitlements(req.user!.organizationId);
    const limit = getEdition(effective.plan).customFieldsLimit;
    const existing = await prisma.customFieldDefinition.count();
    if (limit !== null && existing >= limit) return res.status(429).json({ error: `Current plan allows ${limit} custom fields` });
    const maxOrder = await prisma.customFieldDefinition.aggregate({ _max: { sortOrder: true } });
    const definition = await prisma.customFieldDefinition.create({
      data: {
        organizationId: req.user!.organizationId,
        name,
        slug,
        description: cleanString(req.body?.description, 255),
        dataType,
        allowedValues: dataType === 'list' ? cleanAllowedValues(req.body?.allowedValues) : [],
        sortOrder: Math.max(6, maxOrder._max.sortOrder ?? 6) + 1,
        visibility: 'HIDE_WHEN_EMPTY',
      },
    });
    await auditLog({ userId: req.user!.id, action: 'contact-field.created', resource: 'contact-field', resourceId: definition.id, changes: { after: definition }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.status(201).json(definition);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'A Contact field with this name or ID already exists' });
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.patch('/custom-fields/:id', requireSupervisor, async (req, res) => {
  try {
    const existing = await prisma.customFieldDefinition.findFirst({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Custom field not found' });
    const name = req.body?.name === undefined ? existing.name : cleanString(req.body.name, 80);
    if (!name) return res.status(400).json({ error: 'Custom field name is required' });
    if (STANDARD_CONTACT_FIELDS.some((field) => field.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'Custom field names must differ from standard Contact fields' });
    }
    const updated = await prisma.customFieldDefinition.update({
      where: { id: existing.id },
      data: {
        name,
        ...(req.body?.description !== undefined ? { description: cleanString(req.body.description, 255) } : {}),
        ...(existing.dataType === 'list' && req.body?.allowedValues !== undefined ? { allowedValues: cleanAllowedValues(req.body.allowedValues) } : {}),
      },
    });
    await auditLog({ userId: req.user!.id, action: 'contact-field.updated', resource: 'contact-field', resourceId: updated.id, changes: { before: existing, after: updated }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.json(updated);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'A Contact field with this name already exists' });
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.delete('/custom-fields/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.customFieldDefinition.findFirst({ where: { id: req.params.id }, include: { _count: { select: { values: true } } } });
    if (!existing) return res.status(404).json({ error: 'Custom field not found' });
    await prisma.customFieldDefinition.delete({ where: { id: existing.id } });
    await auditLog({ userId: req.user!.id, action: 'contact-field.deleted', resource: 'contact-field', resourceId: existing.id, changes: { before: existing }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.json({ deleted: true, removedValues: existing._count.values });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.get('/contact-fields', async (_req, res) => {
  try {
    const [preferences, custom] = await Promise.all([
      prisma.contactFieldPreference.findMany(),
      prisma.customFieldDefinition.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ]);
    const preferenceByKey = new Map(preferences.map((row) => [row.fieldKey, row]));
    const standard = STANDARD_CONTACT_FIELDS.map((field, index) => {
      const preference = preferenceByKey.get(field.fieldKey);
      return { ...field, kind: 'STANDARD', sortOrder: preference?.sortOrder ?? index, visibility: preference?.visibility ?? field.defaultVisibility };
    });
    const customRows = custom.map((field) => ({ ...field, fieldKey: `custom:${field.id}`, kind: 'CUSTOM', editable: true }));
    res.json([...standard, ...customRows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)));
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.put('/contact-fields/view', requireSupervisor, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.fields) ? req.body.fields : [];
    if (!rows.length || rows.length > 100) return res.status(400).json({ error: 'fields are required' });
    const keys = rows.map((row: any) => String(row?.fieldKey || ''));
    if (new Set(keys).size !== keys.length) return res.status(400).json({ error: 'Contact field keys must be unique' });
    const custom = await prisma.customFieldDefinition.findMany({ select: { id: true } });
    const standardKeys = new Set(STANDARD_CONTACT_FIELDS.map((field) => field.fieldKey));
    const customKeys = new Set(custom.map((field) => `custom:${field.id}`));
    for (const [index, row] of rows.entries()) {
      if (!standardKeys.has(row.fieldKey) && !customKeys.has(row.fieldKey)) return res.status(400).json({ error: 'Unknown Contact field' });
      if (!FIELD_VISIBILITIES.includes(row.visibility)) return res.status(400).json({ error: 'Invalid Contact field visibility' });
      row.sortOrder = index;
    }
    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        if (standardKeys.has(row.fieldKey)) {
          await tx.contactFieldPreference.upsert({
            where: { organizationId_fieldKey: { organizationId: req.user!.organizationId, fieldKey: row.fieldKey } },
            create: { organizationId: req.user!.organizationId, fieldKey: row.fieldKey, sortOrder: row.sortOrder, visibility: row.visibility },
            update: { sortOrder: row.sortOrder, visibility: row.visibility },
          });
        } else {
          await tx.customFieldDefinition.update({ where: { id: row.fieldKey.slice(7) }, data: { sortOrder: row.sortOrder, visibility: row.visibility } });
        }
      }
    });
    await auditLog({ userId: req.user!.id, action: 'contact-field.view-updated', resource: 'contact-field-view', resourceId: req.user!.organizationId, changes: { after: rows }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.get('/:id/tags', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: req.params.id, ...contactAccessWhere(req.user!) }, select: { id: true } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const assignments = await prisma.contactTag.findMany({
      where: { contactId: contact.id },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(assignments.map((row) => ({
      ...row.tag,
      source: row.source,
      assignedById: row.createdById,
      assignedByName: row.createdByName,
      assignedAt: row.createdAt,
    })));
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.post('/:id/tags', requirePermission('contact:create'), async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: req.params.id, ...contactAccessWhere(req.user!) }, select: { id: true } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    let tag = req.body?.tagId
      ? await prisma.tag.findFirst({ where: { id: String(req.body.tagId) } })
      : null;
    if (!tag) {
      const name = cleanString(req.body?.name, 80);
      if (!name) return res.status(400).json({ error: 'Tag ID or name is required' });
      tag = await prisma.tag.findUnique({ where: { organizationId_name: { organizationId: req.user!.organizationId, name } } });
      if (!tag) {
        try {
          tag = await prisma.tag.create({ data: { organizationId: req.user!.organizationId, name, colorCode: '#64748b' } });
        } catch (err: any) {
          if (err?.code !== 'P2002') throw err;
          tag = await prisma.tag.findUnique({ where: { organizationId_name: { organizationId: req.user!.organizationId, name } } });
        }
      }
    }
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    const { count } = await prisma.contactTag.createMany({
      data: [{
        organizationId: req.user!.organizationId,
        contactId: contact.id,
        tagId: tag.id,
        source: 'MANUAL',
        createdById: req.user!.id,
        createdByName: req.user!.name,
      }],
      skipDuplicates: true,
    });
    if (count > 0) {
      await dispatchWorkflowEvent({ triggerType: 'TAG_ADDED', contactId: contact.id, payload: { tag: tag.name } });
      await auditLog({ userId: req.user!.id, action: 'contact.tag-added', resource: 'contact', resourceId: contact.id, changes: { after: { tagId: tag.id, tagName: tag.name, source: 'MANUAL' } }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    }
    res.status(count > 0 ? 201 : 200).json({
      ...tag,
      source: 'MANUAL',
      assignedById: req.user!.id,
      assignedByName: req.user!.name,
      assignedAt: new Date(),
      created: count > 0,
    });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

router.delete('/:id/tags/:tagId', requirePermission('contact:create'), async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({ where: { id: req.params.id, ...contactAccessWhere(req.user!) }, select: { id: true } });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const tag = await prisma.tag.findFirst({ where: { id: req.params.tagId }, select: { id: true, name: true } });
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    const { count } = await prisma.contactTag.deleteMany({ where: { contactId: contact.id, tagId: tag.id } });
    if (!count) return res.status(404).json({ error: 'Tag assignment not found' });
    await auditLog({ userId: req.user!.id, action: 'contact.tag-removed', resource: 'contact', resourceId: contact.id, changes: { before: { tagId: tag.id, tagName: tag.name } }, ipAddress: req.ip, userAgent: req.get('user-agent') });
    res.sendStatus(204);
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

/**
 * POST /api/contacts/import
 *
 * Bulk import. Requires an explicit consent affirmation in the payload — the
 * checkbox in the UI is a courtesy, this is the gate. Every imported contact is
 * stamped consentSource: 'import', and a contact who has already opted out is
 * never flipped back: re-importing a list must not undo the STOPs a tenant has
 * received.
 */
router.post('/import', requirePermission('contact:create'), async (req, res) => {
  try {
    const summary = await importContacts(
      req.user!.organizationId,
      Array.isArray(req.body?.rows) ? req.body.rows : [],
      {
        consentAffirmed: req.body?.consentAffirmed === true,
        defaultCountryCode: req.body?.defaultCountryCode,
        tag: req.body?.tag ?? null,
      },
    );
    res.json(summary);
  } catch (err) {
    if (err instanceof ImportError) return res.status(err.status).json({ error: err.message });
    logger.error('Contact import failed', { error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/bulk', requirePermission('contact:update'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'contactIds are required' });
    const visible = await prisma.contact.findMany({
      where: { id: { in: ids }, ...contactAccessWhere(req.user!) },
      select: { id: true },
    });
    const visibleIds = visible.map((contact) => contact.id);
    if (visibleIds.length !== ids.length) return res.status(404).json({ error: 'Contact not found' });
    const data: Record<string, unknown> = {};
    if (req.body?.assigneeId !== undefined) data.assigneeId = cleanString(req.body.assigneeId);

    if (Object.keys(data).length) {
      await prisma.contact.updateMany({ where: { id: { in: visibleIds } }, data });
    }

    if (req.body?.tagName) {
      const name = String(req.body.tagName).trim();
      const tag = await prisma.tag.upsert({
        where: { organizationId_name: { organizationId: req.user!.organizationId, name } },
        create: { organizationId: req.user!.organizationId, name },
        update: {},
      });
      const contacts = await prisma.contact.findMany({ where: { id: { in: visibleIds } }, select: { id: true } });
      const existingAssignments = await prisma.contactTag.findMany({
        where: { contactId: { in: contacts.map((contact) => contact.id) }, tagId: tag.id },
        select: { contactId: true },
      });
      const existingContactIds = new Set(existingAssignments.map((row) => row.contactId));
      const newlyTagged = contacts.filter((contact) => !existingContactIds.has(contact.id));
      const { count } = await prisma.contactTag.createMany({
        data: newlyTagged.map((contact) => ({
          organizationId: req.user!.organizationId,
          contactId: contact.id,
          tagId: tag.id,
          source: 'MANUAL',
          createdById: req.user!.id,
          createdByName: req.user!.name,
        })),
        skipDuplicates: true,
      });

      // TAG_ADDED workflow trigger. Fires per contact, and only when the tag was
      // actually new — re-tagging an already-tagged contact must not wake every
      // automation in the organization.
      if (count > 0) {
        for (const contact of newlyTagged) {
          await dispatchWorkflowEvent({
            triggerType: 'TAG_ADDED',
            contactId: contact.id,
            payload: { tag: name },
          });
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

router.post('/merge', async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    const { primaryContactId, secondaryContactId } = req.body || {};
    if (!primaryContactId || !secondaryContactId || primaryContactId === secondaryContactId) {
      return res.status(400).json({ error: 'Distinct primaryContactId and secondaryContactId are required' });
    }

    const merged = await prisma.$transaction(async (tx) => {
      const [primary, secondary] = await Promise.all([
        tx.contact.findFirst({ where: { id: primaryContactId, organizationId, ...contactAccessWhere(req.user!) } }),
        tx.contact.findFirst({ where: { id: secondaryContactId, organizationId, ...contactAccessWhere(req.user!) } }),
      ]);
      if (!primary || !secondary) throw new Error('Contact not found');

      await tx.conversation.updateMany({ where: { organizationId, contactId: secondary.id }, data: { contactId: primary.id } });
      const secondaryTags = await tx.contactTag.findMany({ where: { organizationId, contactId: secondary.id } });
      await tx.contactTag.createMany({
        data: secondaryTags.map((tag) => ({
          organizationId,
          contactId: primary.id,
          tagId: tag.tagId,
          source: tag.source,
          createdById: tag.createdById,
          createdByName: tag.createdByName,
        })),
        skipDuplicates: true,
      });

      const secondaryValues = await tx.customFieldValue.findMany({ where: { organizationId, contactId: secondary.id } });
      for (const value of secondaryValues) {
        await tx.customFieldValue.upsert({
          where: {
            organizationId_contactId_fieldDefinitionId: {
              organizationId,
              contactId: primary.id,
              fieldDefinitionId: value.fieldDefinitionId,
            },
          },
          create: {
            organizationId,
            contactId: primary.id,
            fieldDefinitionId: value.fieldDefinitionId,
            value: value.value,
          },
          update: { value: value.value },
        });
      }

      await tx.contact.update({ where: { id_organizationId: { id: secondary.id, organizationId } }, data: { isArchived: true } });
      return tx.contact.findUniqueOrThrow({ where: { id_organizationId: { id: primary.id, organizationId } }, include: CONTACT_INCLUDE });
    });

    res.json(req.user!.maskPhoneAndEmail ? maskContact(merged) : merged);
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

router.get('/:ref', async (req, res) => {
  try {
    if (req.user!.maskPhoneAndEmail && /^(email|phone):/.test(req.params.ref)) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    const contact = await prisma.contact.findFirst({
      where: {
        organizationId: req.user!.organizationId,
        isArchived: false,
        ...contactWhereForRef(req.params.ref),
        ...contactAccessWhere(req.user!),
      },
      include: CONTACT_INCLUDE,
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(req.user!.maskPhoneAndEmail ? maskContact(contact) : contact);
  } catch {
    res.status(404).json({ error: 'Contact not found' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const visible = await prisma.contact.findFirst({
      where: { id: req.params.id, ...contactAccessWhere(req.user!) },
      select: { id: true },
    });
    if (!visible) return res.status(404).json({ error: 'Contact not found' });
    // Consent is deliberately not part of contactPayload's allow-list. It is not
    // a plain field: changing it must also record who/what changed it and when,
    // so it goes through setContactConsent rather than a bare column write.
    const consent = req.body?.marketingConsent;
    if (consent !== undefined) {
      if (!CONSENT_VALUES.includes(consent)) {
        return res.status(400).json({ error: 'قيمة الموافقة غير صالحة' });
      }
      // The actor, not just the source. "An agent changed it" is not an
      // answer to "who changed it", and consent is the one field where that
      // difference can matter to somebody outside this company.
      await setContactConsent(req.params.id, consent, 'agent', {
        id: req.user!.id,
        name: req.user!.name,
      });
    }

    const contact = await prisma.contact.update({
      where: { id: req.params.id },
      data: contactPayload(req.body),
      include: CONTACT_INCLUDE,
    });
    res.json(req.user!.maskPhoneAndEmail ? maskContact(contact) : contact);
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

/**
 * GET /api/contacts/:id/consent — the current value and how it got there.
 *
 * Its own endpoint rather than a field on the contact: the panel asks for it
 * when the Details tab is open, and every other consumer of a contact — the
 * list, the audience preview, the campaign worker — has no use for a history
 * it would pay to load on every row.
 */
/**
 * GET /api/contacts/:id/conversations — this contact's threads.
 *
 * The contact panel could show the conversation you are in and nothing about
 * the four before it. On a support desk that history is most of the context:
 * whether this is a first complaint or the fourth about the same line, and
 * how the previous ones ended.
 *
 * Resolved threads are included deliberately — they are the ones that carry
 * the answer. The default inbox filter hides them, which is exactly why they
 * are unreachable from anywhere else.
 */
router.get('/:id/conversations', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, ...contactAccessWhere(req.user!) },
      select: { id: true },
    });
    if (!contact) return res.status(404).json({ error: 'جهة الاتصال غير موجودة' });

    const conversations = await prisma.conversation.findMany({
      where: { contactId: contact.id },
      orderBy: { lastMessageAt: 'desc' },
      take: 20,
      select: {
        id: true,
        displayId: true,
        status: true,
        lastMessageAt: true,
        createdAt: true,
        resolvedAt: true,
        team: { select: { name: true, color: true } },
        assignee: { select: { name: true } },
        _count: { select: { messages: true } },
      },
    });

    res.json(conversations);
  } catch (err) {
    logger.error('Contact conversations failed', { contactId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/consent', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, ...contactAccessWhere(req.user!) },
      select: { marketingConsent: true, consentSource: true, consentUpdatedAt: true },
    });
    if (!contact) return res.status(404).json({ error: 'جهة الاتصال غير موجودة' });

    const history = await prisma.consentEvent.findMany({
      where: { contactId: req.params.id },
      orderBy: { at: 'desc' },
      take: 10,
      select: { id: true, fromValue: true, toValue: true, source: true, actorName: true, at: true },
    });

    res.json({
      current: contact.marketingConsent,
      // From the contact row, which predates the history table. A contact
      // whose consent was last set before it existed has a source and a date
      // and no event — reported honestly rather than shown as never set.
      source: contact.consentSource,
      updatedAt: contact.consentUpdatedAt,
      history,
    });
  } catch (err) {
    logger.error('Consent provenance failed', { contactId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/custom-fields/:slug', requirePermission('contact:create'), async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: req.params.id, ...contactAccessWhere(req.user!) },
      select: { id: true },
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const definition = await prisma.customFieldDefinition.findUnique({
      where: { organizationId_slug: { organizationId: req.user!.organizationId, slug: req.params.slug } },
    });
    if (!definition) return res.status(404).json({ error: 'Custom field not found' });

    const value = validateCustomFieldValue(definition, cleanString(req.body?.value, 2000));
    const row = await prisma.customFieldValue.upsert({
      where: {
        organizationId_contactId_fieldDefinitionId: {
          organizationId: req.user!.organizationId,
          contactId: contact.id,
          fieldDefinitionId: definition.id,
        },
      },
      create: { organizationId: req.user!.organizationId, contactId: contact.id, fieldDefinitionId: definition.id, value },
      update: { value },
      include: { fieldDefinition: true },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

export default router;
