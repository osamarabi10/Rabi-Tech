import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import {
  contactWhereFromFilterDsl,
  normalizeContactLimit,
  normalizeCursor,
  parseContactFilterDsl,
} from '../../lib/contact-filter-dsl';
import { PLAN_ENTITLEMENTS, normalizePlanCode } from '../billing/plans';
import { setContactConsent } from '../../utils/consent';

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
  const dslWhere = contactWhereFromFilterDsl(parseContactFilterDsl(req.query.filter));
  const where = {
    isArchived: false,
    ...(search ? {
      OR: [
        { name: { contains: String(search), mode: 'insensitive' as const } },
        { firstName: { contains: String(search), mode: 'insensitive' as const } },
        { lastName: { contains: String(search), mode: 'insensitive' as const } },
        { email: { contains: String(search), mode: 'insensitive' as const } },
        { phone: { contains: String(search) } },
      ],
    } : {}),
    ...dslWhere,
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
    const organization = await prisma.organization.findUnique({
      where: { id: req.user!.organizationId },
      select: { tier: true },
    });
    const limit = PLAN_ENTITLEMENTS[normalizePlanCode(organization?.tier || 'FREE')].customFieldsLimit;
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
      await prisma.contactTag.createMany({
        data: contacts.map((contact) => ({ organizationId: req.user!.organizationId, contactId: contact.id, tagId: tag.id })),
        skipDuplicates: true,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});

router.post('/merge', async (req, res) => {
  try {
    const { primaryContactId, secondaryContactId } = req.body || {};
    const organizationId = req.user!.organizationId;
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
      await setContactConsent(req.params.id, consent, 'agent');
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
