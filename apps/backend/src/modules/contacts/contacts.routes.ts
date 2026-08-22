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
import { PLAN_ENTITLEMENTS, normalizePlanCode } from '../billing/plans';
import { setContactConsent } from '../../utils/consent';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { dispatchWorkflowEvent } from '../../workers/workflow.worker';
import { ImportError, importContacts } from './import.service';
import logger from '../../lib/logger';
import { requirePermission } from '../../middleware/rbac.middleware';

/** Accepted marketing-consent values, validated before any write. */
const CONSENT_VALUES = ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT'] as const;

const router = Router();
router.use(verifyToken);

const CONTACT_INCLUDE = {
  assignee: { select: { id: true, name: true, role: true, primaryTeam: { select: { id: true, name: true, slug: true, color: true } } } },
  contactTags: { include: { tag: true }, orderBy: { createdAt: 'asc' as const } },
  customFieldValues: { include: { fieldDefinition: true }, orderBy: { createdAt: 'asc' as const } },
};

function normalizeSlug(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function cleanString(value: unknown, max = 255): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : null;
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
          { email: { contains: String(search), mode: 'insensitive' as const } },
          { phone: { contains: String(search) } },
        ],
      }
    : null;
  const where = {
    isArchived: false,
    AND: [searchWhere, dslWhere].filter(Boolean) as Prisma.ContactWhereInput[],
  };

  const contacts = await prisma.contact.findMany({
    where,
    include: CONTACT_INCLUDE,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    take: limit + (paginated ? 1 : 0),
  });

  if (!paginated) return contacts.slice(0, limit);
  const items = contacts.slice(0, limit);
  return {
    items,
    pagination: {
      cursorId: contacts.length > limit ? items[items.length - 1]?.id || null : null,
      hasMore: contacts.length > limit,
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
  const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
  res.json(tags);
});

router.post('/tags', async (req, res) => {
  try {
    const name = cleanString(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: 'Tag name is required' });
    const tag = await prisma.tag.upsert({
      where: { organizationId_name: { organizationId: req.user!.organizationId, name } },
      create: {
        organizationId: req.user!.organizationId,
        name,
        description: cleanString(req.body?.description, 255),
        colorCode: cleanString(req.body?.colorCode, 32),
        emoji: cleanString(req.body?.emoji, 16),
      },
      update: {
        description: cleanString(req.body?.description, 255),
        colorCode: cleanString(req.body?.colorCode, 32),
        emoji: cleanString(req.body?.emoji, 16),
      },
    });
    res.status(201).json(tag);
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

router.get('/custom-fields', async (_req, res) => {
  const definitions = await prisma.customFieldDefinition.findMany({ orderBy: { name: 'asc' } });
  res.json(definitions);
});

router.post('/custom-fields', async (req, res) => {
  try {
    const name = cleanString(req.body?.name, 80);
    const slug = normalizeSlug(req.body?.slug || name);
    const dataType = String(req.body?.dataType || '').trim();
    if (!name || !slug) return res.status(400).json({ error: 'Custom field name is required' });
    if (!['text', 'number', 'date', 'list'].includes(dataType)) {
      return res.status(400).json({ error: 'dataType must be text, number, date, or list' });
    }
    const allowedValues = Array.isArray(req.body?.allowedValues)
      ? req.body.allowedValues.map((value: unknown) => String(value).trim()).filter(Boolean)
      : [];
    // Feature allowances follow the effective plan too. Honouring an override
    // for quotas but not for features is half an upgrade, which is worse than
    // none: the customer paid for a tier they cannot fully use.
    const effective = await resolveEntitlements(req.user!.organizationId);
    const limit = PLAN_ENTITLEMENTS[effective.plan].customFieldsLimit;
    if (limit !== null) {
      const existing = await prisma.customFieldDefinition.count();
      const sameSlug = await prisma.customFieldDefinition.findUnique({
        where: { organizationId_slug: { organizationId: req.user!.organizationId, slug } },
        select: { id: true },
      });
      if (!sameSlug && existing >= limit) {
        return res.status(429).json({ error: `Current plan allows ${limit} custom fields` });
      }
    }
    const definition = await prisma.customFieldDefinition.upsert({
      where: { organizationId_slug: { organizationId: req.user!.organizationId, slug } },
      create: {
        organizationId: req.user!.organizationId,
        name,
        slug,
        description: cleanString(req.body?.description, 255),
        dataType,
        allowedValues,
      },
      update: {
        name,
        description: cleanString(req.body?.description, 255),
        dataType,
        allowedValues,
      },
    });
    res.status(201).json(definition);
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
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

router.post('/bulk', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(String).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'contactIds are required' });
    const data: Record<string, unknown> = {};
    if (req.body?.assigneeId !== undefined) data.assigneeId = cleanString(req.body.assigneeId);

    if (Object.keys(data).length) {
      await prisma.contact.updateMany({ where: { id: { in: ids } }, data });
    }

    if (req.body?.tagName) {
      const name = String(req.body.tagName).trim();
      const tag = await prisma.tag.upsert({
        where: { organizationId_name: { organizationId: req.user!.organizationId, name } },
        create: { organizationId: req.user!.organizationId, name },
        update: {},
      });
      const contacts = await prisma.contact.findMany({ where: { id: { in: ids } }, select: { id: true } });
      const { count } = await prisma.contactTag.createMany({
        data: contacts.map((contact) => ({ organizationId: req.user!.organizationId, contactId: contact.id, tagId: tag.id })),
        skipDuplicates: true,
      });

      // TAG_ADDED workflow trigger. Fires per contact, and only when the tag was
      // actually new — re-tagging an already-tagged contact must not wake every
      // automation in the organization.
      if (count > 0) {
        for (const contact of contacts) {
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
        tx.contact.findUnique({ where: { id_organizationId: { id: primaryContactId, organizationId } } }),
        tx.contact.findUnique({ where: { id_organizationId: { id: secondaryContactId, organizationId } } }),
      ]);
      if (!primary || !secondary) throw new Error('Contact not found');

      await tx.conversation.updateMany({ where: { organizationId, contactId: secondary.id }, data: { contactId: primary.id } });
      const secondaryTags = await tx.contactTag.findMany({ where: { organizationId, contactId: secondary.id } });
      await tx.contactTag.createMany({
        data: secondaryTags.map((tag) => ({ organizationId, contactId: primary.id, tagId: tag.tagId })),
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

    res.json(merged);
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

router.get('/:ref', async (req, res) => {
  try {
    const contact = await prisma.contact.findFirst({
      where: { organizationId: req.user!.organizationId, isArchived: false, ...contactWhereForRef(req.params.ref) },
      include: CONTACT_INCLUDE,
    });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(contact);
  } catch {
    res.status(404).json({ error: 'Contact not found' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
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
    res.json(contact);
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
router.get('/:id/consent', async (req, res) => {
  try {
    const contact = await prisma.contact.findUnique({
      where: { id: req.params.id },
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

router.put('/:id/custom-fields/:slug', async (req, res) => {
  try {
    const definition = await prisma.customFieldDefinition.findUnique({
      where: { organizationId_slug: { organizationId: req.user!.organizationId, slug: req.params.slug } },
    });
    if (!definition) return res.status(404).json({ error: 'Custom field not found' });
    const value = cleanString(req.body?.value, 2000);
    const row = await prisma.customFieldValue.upsert({
      where: {
        organizationId_contactId_fieldDefinitionId: {
          organizationId: req.user!.organizationId,
          contactId: req.params.id,
          fieldDefinitionId: definition.id,
        },
      },
      create: { organizationId: req.user!.organizationId, contactId: req.params.id, fieldDefinitionId: definition.id, value },
      update: { value },
      include: { fieldDefinition: true },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

export default router;
