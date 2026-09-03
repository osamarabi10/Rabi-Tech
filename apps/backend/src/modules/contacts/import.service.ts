import { currentWorkspaceId } from '../../lib/current-workspace';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { normalizePhone } from './phone';
import { validateCustomFieldValue } from './custom-field-validation';

/**
 * Bulk contact import.
 *
 * ## The consent rule
 *
 * Bulk-loading a list into a tool that can broadcast is exactly the liability
 * M1 exists to prevent, so two things are non-negotiable:
 *
 * 1. **The caller must affirm consent.** No affirmation, no import. It is a
 *    hard gate, not a checkbox the UI happens to render.
 * 2. **An import can never resurrect an opted-out contact.** Someone who sent
 *    STOP stays `OPTED_OUT` no matter what a spreadsheet claims. Without this,
 *    re-importing a list is how a tenant quietly undoes every opt-out they have
 *    ever received — and they would not even know they had done it.
 *
 * ## Why chunked
 *
 * One transaction per row is slow; one transaction for ten thousand rows holds
 * a connection long enough to time out and rolls back work that was fine. Both
 * fail badly on exactly the large file this feature exists for.
 */

/** Rows per transaction. */
const CHUNK_SIZE = 250;

/**
 * Hard ceiling per request.
 *
 * A 200k-row paste would sit in memory as parsed JSON and occupy the process
 * for minutes. Files above this belong in a queued job, which is a different
 * feature with different progress reporting.
 */
export const MAX_IMPORT_ROWS = 20_000;

/** Only errors this many rows are echoed back; the rest are counted. */
const MAX_REPORTED_ERRORS = 200;

export type ImportRow = {
  phone?: unknown;
  name?: unknown;
  email?: unknown;
  lifecycleStage?: unknown;
  /** slug -> value, for tenant custom fields. */
  customFields?: Record<string, unknown>;
};

export type ImportSummary = {
  total: number;
  created: number;
  updated: number;
  failed: number;
  /** Kept for the opted-out contacts an import must not touch. */
  skippedOptedOut: number;
  errors: Array<{ row: number; reason: string }>;
};

export class ImportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

type Prepared = {
  row: number;
  phone: string;
  name: string | null;
  email: string | null;
  lifecycleStage: string | null;
  customFields: Record<string, string | null>;
};

function cleanText(value: unknown, max = 200): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * Import contacts.
 *
 * Runs inside the caller's tenant scope, so every write is org-scoped by the
 * Prisma extension — and `organizationId` is also passed explicitly, because
 * the extension is a convenience layer and not the boundary.
 */
export async function importContacts(
  organizationId: string,
  rows: ImportRow[],
  options: { consentAffirmed: boolean; defaultCountryCode?: string; tag?: string | null },
): Promise<ImportSummary> {
  // Gate 1. Refused before a single row is read.
  if (!options.consentAffirmed) {
    throw new ImportError(400, 'يجب تأكيد حصولك على موافقة جهات الاتصال قبل الاستيراد');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ImportError(400, 'لا توجد صفوف للاستيراد');
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ImportError(400, `الحد الأقصى ${MAX_IMPORT_ROWS} صف في المرة الواحدة`);
  }

  const summary: ImportSummary = {
    total: rows.length,
    created: 0,
    updated: 0,
    failed: 0,
    skippedOptedOut: 0,
    errors: [],
  };

  const addError = (row: number, reason: string) => {
    summary.failed += 1;
    if (summary.errors.length < MAX_REPORTED_ERRORS) summary.errors.push({ row, reason });
  };

  // --- Validate and de-duplicate before touching the database ---------------
  const prepared: Prepared[] = [];
  const seen = new Map<string, number>();

  rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const result = normalizePhone(raw?.phone, options.defaultCountryCode);
    if (!result.ok) {
      addError(rowNumber, result.reason);
      return;
    }
    // A file listing the same number twice would otherwise race itself inside a
    // chunk and report a confusing unique-constraint error. Last row wins, and
    // the earlier one is reported so the user knows the file had a duplicate.
    const previous = seen.get(result.phone);
    if (previous !== undefined) {
      addError(previous, `duplicate phone in file, superseded by row ${rowNumber}`);
      const at = prepared.findIndex((entry) => entry.phone === result.phone);
      if (at >= 0) prepared.splice(at, 1);
    }
    seen.set(result.phone, rowNumber);

    const customFields: Record<string, string | null> = {};
    for (const [slug, value] of Object.entries(raw?.customFields || {})) {
      customFields[slug] = cleanText(value, 500);
    }

    prepared.push({
      row: rowNumber,
      phone: result.phone,
      name: cleanText(raw?.name, 120),
      email: cleanText(raw?.email, 200)?.toLowerCase() ?? null,
      lifecycleStage: cleanText(raw?.lifecycleStage, 40),
      customFields,
    });
  });

  if (!prepared.length) return summary;

  // Only slugs that actually exist are written. A mapping pointing at a field
  // that was deleted mid-import must not create orphan values.
  const definitions = await prisma.customFieldDefinition.findMany({
    select: { id: true, slug: true, name: true, dataType: true, allowedValues: true },
  });
  const definitionBySlug = new Map(definitions.map((definition) => [definition.slug, definition]));
  const validPrepared = prepared.filter((entry) => {
    try {
      for (const [slug, value] of Object.entries(entry.customFields)) {
        const definition = definitionBySlug.get(slug);
        if (definition) entry.customFields[slug] = validateCustomFieldValue(definition, value) ?? null;
      }
      return true;
    } catch (error) {
      addError(entry.row, String((error as Error).message || error));
      return false;
    }
  });

  let tagId: string | null = null;
  if (options.tag) {
    const name = String(options.tag).trim().slice(0, 60);
    if (name) {
      const tag = await prisma.tag.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name },
        update: {},
      });
      tagId = tag.id;
    }
  }

  // --- Write in chunks ------------------------------------------------------
  for (let start = 0; start < validPrepared.length; start += CHUNK_SIZE) {
    const chunk = validPrepared.slice(start, start + CHUNK_SIZE);
    try {
      await prisma.$transaction(async (tx) => {
        const existing = await tx.contact.findMany({
          where: { phone: { in: chunk.map((entry) => entry.phone) } },
          select: { id: true, phone: true, marketingConsent: true, name: true, email: true, lifecycleStage: true },
        });
        const existingByPhone = new Map(existing.map((contact) => [contact.phone, contact]));

        for (const entry of chunk) {
          const current = existingByPhone.get(entry.phone);

          if (current) {
            // Gate 2. An import cannot undo an opt-out.
            const keepsOptOut = current.marketingConsent === 'OPTED_OUT';
            if (keepsOptOut) summary.skippedOptedOut += 1;

            await tx.contact.update({
              where: { id: current.id },
              data: {
                // Never blank out data the CRM already has with an empty cell.
                name: entry.name ?? current.name,
                email: entry.email ?? current.email,
                lifecycleStage: entry.lifecycleStage ?? current.lifecycleStage,
                ...(keepsOptOut
                  ? {}
                  : {
                      marketingConsent: 'OPTED_IN' as const,
                      consentSource: 'import',
                      consentUpdatedAt: new Date(),
                    }),
              },
            });
            summary.updated += 1;
          } else {
            const created = await tx.contact.create({
              data: {
                workspaceId: await currentWorkspaceId(),
                organizationId,
                phone: entry.phone,
                name: entry.name,
                email: entry.email,
                lifecycleStage: entry.lifecycleStage,
                marketingConsent: 'OPTED_IN',
                consentSource: 'import',
                consentUpdatedAt: new Date(),
                // Stamped rather than left to default. UNKNOWN means 'this row
                // predates attribution'; an import today knows better than that,
                // and how a contact was created is recorded nowhere else, so a
                // row left unstamped could never be corrected by backfill.
                acquisitionSource: 'IMPORT',
                acquisitionAt: new Date(),
              },
              select: { id: true },
            });
            existingByPhone.set(entry.phone, {
              id: created.id,
              phone: entry.phone,
              marketingConsent: 'OPTED_IN',
              name: entry.name,
              email: entry.email,
              lifecycleStage: entry.lifecycleStage,
            });
            summary.created += 1;
          }

          const contactId = existingByPhone.get(entry.phone)!.id;

          if (tagId) {
            await tx.contactTag.createMany({
              data: [{ organizationId, contactId, tagId, source: 'IMPORT' }],
              skipDuplicates: true,
            });
          }

          for (const [slug, value] of Object.entries(entry.customFields)) {
            const fieldDefinition = definitionBySlug.get(slug);
            if (!fieldDefinition) continue;
            await tx.customFieldValue.upsert({
              where: {
                organizationId_contactId_fieldDefinitionId: {
                  organizationId, contactId, fieldDefinitionId: fieldDefinition.id,
                },
              },
              create: { organizationId, contactId, fieldDefinitionId: fieldDefinition.id, value },
              update: { value },
            });
          }
        }
      }, { timeout: 30_000 });
    } catch (error) {
      // One bad chunk must not lose the ones that already succeeded, so the
      // failure is reported against its rows and the import continues.
      const message = String((error as Error).message || error).slice(0, 200);
      logger.error('Contact import chunk failed', { organizationId, start, error: message });
      for (const entry of chunk) addError(entry.row, `batch failed: ${message}`);
    }
  }

  logger.info('Contact import complete', { organizationId, ...summary, errors: summary.errors.length });
  return summary;
}
