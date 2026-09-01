import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import {
  contactWhereFromFilterDsl,
  normalizeContactLimit,
  normalizeCursor,
  parseContactFilterDsl,
  validateContactFilter,
} from '../../lib/contact-filter-dsl';
import { normalizePhone } from '../contacts/phone';
import { validateCustomFieldValue } from '../contacts/custom-field-validation';
import { setContactConsent } from '../../utils/consent';
import { requireScope } from '../api-tokens/api-token.middleware';
import { parseContactRef } from './identifier';
import { CONTACT_INCLUDE, serializeContact } from './serialize';

/**
 * `/api/v1/contacts` — the contact surface of the public API.
 *
 * ## Four verbs that mean four different things
 *
 * `POST` creates and refuses to overwrite. `PUT` is create-or-update. `PATCH`
 * updates and refuses to create. `GET` reads. Collapsing any pair of these is
 * the most common way an integration destroys data it did not mean to touch:
 * a sync job that means "add if new" and gets upsert semantics silently
 * overwrites every field it left blank.
 *
 * ## There is no DELETE, deliberately
 *
 * The console has no contact deletion either — `contact:delete` exists in the
 * permission table and no route uses it. Deleting a contact cascades to their
 * conversations and every message in them, which is usually the entire record
 * of why the contact mattered. Defining those semantics for the first time in
 * a *public API*, where the caller is somebody else's script and the blast
 * radius is a workspace's history, is the wrong place to define them. Archiving
 * is available through `PATCH` and is what most callers actually want.
 *
 * ## Consent is not a field here either
 *
 * `marketingConsent` goes through `setContactConsent` with source `api`, the
 * same path the console uses with source `agent`. A bare column write would
 * record the new value and lose who changed it and when — and consent is the
 * one field where that difference can matter to somebody outside this company.
 */

const router = Router();

/** Fields a caller may set directly. Everything else is either derived or guarded. */
const WRITABLE = ['name', 'firstName', 'lastName', 'email', 'language', 'countryCode', 'lifecycleStage', 'notes'] as const;

const CONSENT_VALUES = ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT'] as const;

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

function clean(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

/** The writable subset of a request body, validated. */
function contactPayload(body: any) {
  const data: Record<string, unknown> = {};
  for (const field of WRITABLE) {
    const value = clean(body?.[field], field === 'notes' ? 2000 : 255);
    if (value === undefined) continue;
    data[field] = field === 'email' && value ? value.toLowerCase() : value;
  }
  if (body?.archived !== undefined) data.isArchived = !!body.archived;
  return data;
}

/**
 * Resolve `customFields` through the workspace's definitions.
 *
 * Never written as a bare object onto the contact. That exact shape — spreading
 * caller-supplied keys straight onto a row — was caught in the workflow engine
 * during development, where it let a request set `organizationId` and move a
 * contact into another tenant. Resolving each key through
 * `CustomFieldDefinition` means an unknown key is a 400 rather than a column.
 */
async function resolveCustomFields(input: unknown): Promise<{ definitionId: string; value: string | null }[]> {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'customFields must be an object of { slug: value }.');
  }

  const slugs = Object.keys(input as Record<string, unknown>);
  if (!slugs.length) return [];
  if (slugs.length > 50) throw new ApiError(400, 'Too many custom fields in one request (limit 50).');

  const definitions = await prisma.customFieldDefinition.findMany({ where: { slug: { in: slugs } } });
  const bySlug = new Map(definitions.map((definition) => [definition.slug, definition]));

  const unknown = slugs.filter((slug) => !bySlug.has(slug));
  if (unknown.length) {
    // Naming the valid slugs turns a guessing game into one more request. The
    // list is the workspace's own vocabulary, which the caller is entitled to.
    throw new ApiError(400, 'Unknown custom field(s).', {
      unknown,
      known: definitions.length ? definitions.map((d) => d.slug) : await knownSlugs(),
    });
  }

  return slugs.map((slug) => {
    const definition = bySlug.get(slug)!;
    const raw = clean((input as Record<string, unknown>)[slug], 2000);
    // Same validator the console uses, so a value the UI would reject cannot
    // enter through the API and then fail to render.
    return { definitionId: definition.id, value: validateCustomFieldValue(definition, raw ?? null) ?? null };
  });
}

async function knownSlugs(): Promise<string[]> {
  const all = await prisma.customFieldDefinition.findMany({ select: { slug: true }, take: 100 });
  return all.map((row) => row.slug);
}

async function writeCustomFields(contactId: string, fields: { definitionId: string; value: string | null }[]) {
  const organizationId = getTenantId();
  for (const field of fields) {
    await prisma.customFieldValue.upsert({
      where: {
        organizationId_contactId_fieldDefinitionId: {
          organizationId,
          contactId,
          fieldDefinitionId: field.definitionId,
        },
      },
      create: { organizationId, contactId, fieldDefinitionId: field.definitionId, value: field.value },
      update: { value: field.value },
    });
  }
}

/**
 * The country code to assume for a local number, from the request.
 *
 * Not a workspace setting, because there is no such column and inventing one
 * here would be a guess stored permanently. The console's import route takes it
 * the same way — per request, from whoever knows which country the numbers came
 * from. Absent it, a local number is rejected rather than assigned to whichever
 * country the workspace happens to sit in, which is how contacts end up
 * unreachable at a plausible-looking number in the wrong country.
 */
function countryCodeFrom(req: any): string | undefined {
  const raw = String(req?.body?.defaultCountryCode ?? '').replace(/\D/g, '');
  return raw || undefined;
}

async function findByRef(raw: unknown, req: any) {
  const ref = parseContactRef(raw, countryCodeFrom(req));
  if (!ref.ok) throw new ApiError(400, ref.message);
  const contact = await prisma.contact.findFirst({ where: ref.where, include: CONTACT_INCLUDE });
  return { ref, contact };
}

function send(res: any, req: any, contact: any, status = 200) {
  return res.status(status).json(serializeContact(contact, req.apiToken!.maskContactDetails));
}

/** One error shape for the whole surface, so a client writes one handler. */
function fail(res: any, req: any, err: unknown, where: string) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: 'invalid_request', message: err.message, details: err.details });
  }
  logger.error(`public-api ${where} failed`, { error: (err as Error)?.message, requestId: req.id });
  return res.status(500).json({ error: 'server_error' });
}

/* ── read ─────────────────────────────────────────────────────────────────── */

router.get('/:identifier', requireScope('contacts:read'), async (req, res) => {
  try {
    const { contact } = await findByRef(req.params.identifier, req);
    if (!contact) return res.status(404).json({ error: 'not_found', message: 'No contact matches that identifier.' });
    return send(res, req, contact);
  } catch (err) { return fail(res, req, err, 'GET /contacts/:identifier'); }
});

/**
 * `POST /contacts/list` — a filter body, not a query string.
 *
 * A POST for a read, which looks wrong and is not: the filter grammar nests
 * groups and operators arbitrarily deep, and a query string cannot carry that
 * without inventing an encoding that every client then has to implement.
 * Respond.io made the same call for the same reason.
 *
 * **Ours is the richer grammar** and it is exposed as-is rather than narrowed
 * to theirs. `GET /api/contacts/filter-schema` on the console describes it, and
 * it is the same validator, so a filter that works in a saved segment works
 * here unchanged.
 */
router.post('/list', requireScope('contacts:read'), async (req, res) => {
  try {
    const limit = normalizeContactLimit(req.body?.limit);
    const cursorId = normalizeCursor(req.body?.cursorId);

    let where: any = { isArchived: req.body?.includeArchived === true ? undefined : false };
    if (req.body?.filter !== undefined && req.body?.filter !== null) {
      const validation = validateContactFilter(req.body.filter, getTenantId());
      if (!validation.valid) {
        throw new ApiError(400, 'The filter is not valid.', validation.errors);
      }
      const parsed = parseContactFilterDsl(req.body.filter);
      where = { AND: [where, contactWhereFromFilterDsl(parsed, getTenantId())].filter(Boolean) };
    }

    const rows = await prisma.contact.findMany({
      where,
      include: CONTACT_INCLUDE,
      // Deterministic and stable: `createdAt` alone ties for contacts imported
      // in the same batch, and a tie makes cursor pagination skip or repeat rows.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: limit + 1,
    });

    const items = rows.slice(0, limit);
    const mask = req.apiToken!.maskContactDetails;
    return res.json({
      contacts: items.map((contact) => serializeContact(contact as any, mask)),
      pagination: {
        // No total. Counting the whole filtered set on every page is a table
        // scan a caller pays for and rarely reads; ask for it explicitly if it
        // is ever wanted.
        cursorId: rows.length > limit ? items[items.length - 1]?.id ?? null : null,
        hasMore: rows.length > limit,
      },
    });
  } catch (err) { return fail(res, req, err, 'POST /contacts/list'); }
});

/* ── write ────────────────────────────────────────────────────────────────── */

async function applyConsent(contactId: string, value: unknown) {
  if (value === undefined) return;
  if (!(CONSENT_VALUES as readonly string[]).includes(String(value))) {
    throw new ApiError(400, `marketingConsent must be one of ${CONSENT_VALUES.join(', ')}.`);
  }
  await setContactConsent(contactId, value as any, 'api', null);
}

router.post('/', requireScope('contacts:write'), async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone, countryCodeFrom(req));
    if (!phone.ok) throw new ApiError(400, `phone is required and must be usable: ${phone.reason}`);

    const fields = await resolveCustomFields(req.body?.customFields);

    const existing = await prisma.contact.findFirst({ where: { phone: phone.phone }, select: { id: true } });
    if (existing) {
      // 409 with the id, not a silent update. A caller who meant upsert has
      // PUT; one who meant create needs to know this was not one, and needs the
      // id to do something about it without a second lookup.
      return res.status(409).json({
        error: 'already_exists',
        message: 'A contact with that phone number already exists. Use PUT to create or update.',
        contactId: existing.id,
      });
    }

    const created = await prisma.contact.create({
      data: {
        organizationId: getTenantId(),
        phone: phone.phone,
        ...contactPayload(req.body),
      },
      select: { id: true },
    });

    await applyConsent(created.id, req.body?.marketingConsent);
    if (fields.length) await writeCustomFields(created.id, fields);

    const contact = await prisma.contact.findUnique({ where: { id: created.id }, include: CONTACT_INCLUDE });
    logger.info('public-api contact created', { contactId: created.id, tokenId: req.apiToken!.id });
    return send(res, req, contact, 201);
  } catch (err) { return fail(res, req, err, 'POST /contacts'); }
});

/** `PUT` — create or update, the endpoint most sync jobs actually want. */
router.put('/:identifier', requireScope('contacts:write'), async (req, res) => {
  try {
    const cc = countryCodeFrom(req);
    const ref = parseContactRef(req.params.identifier, cc);
    if (!ref.ok) throw new ApiError(400, ref.message);

    const fields = await resolveCustomFields(req.body?.customFields);
    const existing = await prisma.contact.findFirst({ where: ref.where, select: { id: true } });

    let contactId: string;
    if (existing) {
      await prisma.contact.update({ where: { id: existing.id }, data: contactPayload(req.body) });
      contactId = existing.id;
    } else {
      /*
        Creating from an identifier. Only `phone:` can do it on its own, because
        phone is the workspace's messaging identity and the one required column.
        An `email:` or `id:` PUT for a contact that does not exist has no phone
        to create it with — so it says that, rather than creating a contact the
        product cannot message.
      */
      // Normalised once and then branched on. Calling normalizePhone twice
      // inside a ternary reads as one check and is two, and TypeScript cannot
      // narrow the second call from the first.
      const fromBody = normalizePhone(req.body?.phone, cc);
      const phone = ref.kind === 'phone' ? ref.value : (fromBody.ok ? fromBody.phone : null);
      if (!phone) {
        throw new ApiError(400, `No contact matches ${ref.kind}:${ref.value}, and creating one needs a phone number — send "phone" in the body or address the contact as phone:<number>.`);
      }
      const created = await prisma.contact.create({
        data: { organizationId: getTenantId(), phone, ...contactPayload(req.body) },
        select: { id: true },
      });
      contactId = created.id;
    }

    await applyConsent(contactId, req.body?.marketingConsent);
    if (fields.length) await writeCustomFields(contactId, fields);

    const contact = await prisma.contact.findUnique({ where: { id: contactId }, include: CONTACT_INCLUDE });
    return send(res, req, contact, existing ? 200 : 201);
  } catch (err) { return fail(res, req, err, 'PUT /contacts/:identifier'); }
});

/** `PATCH` — update only. A missing contact is a 404, never a create. */
router.patch('/:identifier', requireScope('contacts:write'), async (req, res) => {
  try {
    const { contact } = await findByRef(req.params.identifier, req);
    if (!contact) return res.status(404).json({ error: 'not_found', message: 'No contact matches that identifier.' });

    const fields = await resolveCustomFields(req.body?.customFields);
    await prisma.contact.update({ where: { id: contact.id }, data: contactPayload(req.body) });
    await applyConsent(contact.id, req.body?.marketingConsent);
    if (fields.length) await writeCustomFields(contact.id, fields);

    const updated = await prisma.contact.findUnique({ where: { id: contact.id }, include: CONTACT_INCLUDE });
    return send(res, req, updated);
  } catch (err) { return fail(res, req, err, 'PATCH /contacts/:identifier'); }
});

/* ── tags ─────────────────────────────────────────────────────────────────── */

/**
 * Tag a contact. Creates the tag if the workspace does not have it yet.
 *
 * Deliberate: a sync job that must create the tag first, in a second call, with
 * different error handling, is a sync job that half-applies its tags. The
 * assignment is recorded with source `API` so an operator can tell an automated
 * tag from one a colleague applied.
 */
router.post('/:identifier/tags', requireScope('tags:write'), async (req, res) => {
  try {
    const { contact } = await findByRef(req.params.identifier, req);
    if (!contact) return res.status(404).json({ error: 'not_found', message: 'No contact matches that identifier.' });

    const names = Array.isArray(req.body?.tags) ? req.body.tags : [req.body?.tag];
    const wanted = [...new Set(names.map((n: unknown) => String(n ?? '').trim()).filter(Boolean))].slice(0, 20) as string[];
    if (!wanted.length) throw new ApiError(400, 'Send "tag" or a "tags" array.');

    const organizationId = getTenantId();
    for (const name of wanted) {
      const tag = await prisma.tag.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name },
        update: {},
        select: { id: true },
      });
      await prisma.contactTag.upsert({
        where: { organizationId_contactId_tagId: { organizationId, contactId: contact.id, tagId: tag.id } },
        create: { organizationId, contactId: contact.id, tagId: tag.id, source: 'API' },
        update: {},
      });
    }

    const updated = await prisma.contact.findUnique({ where: { id: contact.id }, include: CONTACT_INCLUDE });
    return send(res, req, updated);
  } catch (err) { return fail(res, req, err, 'POST /contacts/:identifier/tags'); }
});

router.delete('/:identifier/tags/:tag', requireScope('tags:write'), async (req, res) => {
  try {
    const { contact } = await findByRef(req.params.identifier, req);
    if (!contact) return res.status(404).json({ error: 'not_found', message: 'No contact matches that identifier.' });

    const organizationId = getTenantId();
    const tag = await prisma.tag.findUnique({
      where: { organizationId_name: { organizationId, name: String(req.params.tag) } },
      select: { id: true },
    });
    // Removing a tag the contact does not have is not an error — a retrying
    // client must be able to converge without special-casing "already gone".
    if (tag) {
      await prisma.contactTag.deleteMany({ where: { contactId: contact.id, tagId: tag.id } });
    }

    const updated = await prisma.contact.findUnique({ where: { id: contact.id }, include: CONTACT_INCLUDE });
    return send(res, req, updated);
  } catch (err) { return fail(res, req, err, 'DELETE /contacts/:identifier/tags/:tag'); }
});

export default router;
