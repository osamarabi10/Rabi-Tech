import { Prisma } from '@prisma/client';
import { decryptCredential } from '../../lib/credential-crypto';
import logger from '../../lib/logger';
import { getTenantId, runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import { prisma } from '../../prisma';
import {
  createMessageTemplate,
  listMessageTemplates,
  type MetaTemplateComponent,
  type MetaTemplateListPage,
  type MetaTemplateSnapshot,
} from '../channels/meta.client';

const SUPPORTED_CATEGORIES = new Set(['UTILITY', 'MARKETING']);
const SUPPORTED_COMPONENTS = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
const SUPPORTED_BUTTONS = new Set(['QUICK_REPLY', 'URL']);

export type MetaTemplateApi = {
  create: typeof createMessageTemplate;
  list: typeof listMessageTemplates;
};

export const defaultMetaTemplateApi: MetaTemplateApi = {
  create: createMessageTemplate,
  list: listMessageTemplates,
};

export class MetaTemplateError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'MetaTemplateError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function isMetaTemplateError(error: unknown): error is MetaTemplateError {
  return error instanceof MetaTemplateError;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export type MetaTemplateValidation = {
  supported: boolean;
  reason: string | null;
};

/**
 * Validate the deliberately narrow phase-1 component vocabulary.
 *
 * Imported provider rows are never rejected for being outside this product's
 * current scope; they are retained and marked unsupported. Drafts and submits
 * do fail here, so an unsupported shape cannot be sent to Meta by a later
 * phase without an explicit implementation decision.
 */
export function validateMetaTemplateComponents(
  category: unknown,
  value: unknown,
): MetaTemplateValidation {
  if (typeof category !== 'string' || !SUPPORTED_CATEGORIES.has(category)) {
    return { supported: false, reason: 'Only Utility and Marketing templates are supported.' };
  }
  if (!Array.isArray(value)) return { supported: false, reason: 'Template components must be an array.' };

  const seen = new Set<string>();
  for (const rawComponent of value) {
    const component = record(rawComponent);
    if (!component) return { supported: false, reason: 'Template components must be objects.' };
    const type = nonEmptyString(component?.type);
    if (!type || !SUPPORTED_COMPONENTS.has(type)) {
      return { supported: false, reason: 'This template contains a component outside phase 1.' };
    }
    if (seen.has(type)) return { supported: false, reason: 'A template component type may appear only once.' };
    seen.add(type);

    if (type === 'HEADER') {
      if (component?.format !== 'TEXT' || !nonEmptyString(component.text)) {
        return { supported: false, reason: 'Only text headers are supported.' };
      }
    }
    if (type === 'BODY' && !nonEmptyString(component.text)) {
      return { supported: false, reason: 'A template body is required.' };
    }
    if (type === 'FOOTER' && !nonEmptyString(component.text)) {
      return { supported: false, reason: 'A template footer cannot be empty.' };
    }
    if (type === 'BUTTONS') {
      if (!Array.isArray(component.buttons) || component.buttons.length < 1 || component.buttons.length > 10) {
        return { supported: false, reason: 'Buttons must contain one to ten supported buttons.' };
      }
      for (const rawButton of component.buttons) {
        const button = record(rawButton);
        if (!button) return { supported: false, reason: 'Template buttons must be objects.' };
        const buttonType = nonEmptyString(button?.type);
        if (!buttonType || !SUPPORTED_BUTTONS.has(buttonType) || !nonEmptyString(button.text)) {
          return { supported: false, reason: 'Only text quick replies and URL buttons are supported.' };
        }
        if (buttonType === 'URL' && !nonEmptyString(button.url)) {
          return { supported: false, reason: 'URL buttons require a URL.' };
        }
      }
    }
  }

  if (!seen.has('BODY')) return { supported: false, reason: 'A template body is required.' };
  return { supported: true, reason: null };
}

/** Exact provider policy. No normalization means unknown statuses fail closed. */
export function isMetaTemplateSendable(status: string, archivedAt: Date | string | null = null): boolean {
  return status === 'APPROVED' && archivedAt == null;
}

function providerStatus(value: unknown, fallback = 'UNKNOWN'): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function providerDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function activeCredential(): Promise<{
  id: string;
  wabaId: string;
  accessToken: string;
}> {
  const row = await prisma.metaChannelCredential.findFirst({
    where: { status: 'ACTIVE' },
    select: { id: true, wabaId: true, accessTokenEnc: true },
  });
  if (!row) {
    throw new MetaTemplateError(
      409,
      'META_TEMPLATE_CREDENTIAL_UNAVAILABLE',
      'لا يمكن إدارة قوالب Meta قبل تفعيل بيانات اعتماد Meta.',
    );
  }
  return { id: row.id, wabaId: row.wabaId, accessToken: decryptCredential(row.accessTokenEnc) };
}

function templateView(row: {
  id: string;
  organizationId: string;
  wabaId: string;
  providerId: string | null;
  name: string;
  language: string;
  category: string;
  components: Prisma.JsonValue;
  status: string;
  rejectionReason: string | null;
  isSupported: boolean;
  unsupportedReason: string | null;
  submittedAt: Date | null;
  lastSyncedAt: Date | null;
  providerUpdatedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    wabaId: row.wabaId,
    providerId: row.providerId,
    name: row.name,
    language: row.language,
    category: row.category,
    components: row.components,
    status: row.status,
    rejectionReason: row.rejectionReason,
    isSupported: row.isSupported,
    unsupportedReason: row.unsupportedReason,
    submittedAt: row.submittedAt,
    lastSyncedAt: row.lastSyncedAt,
    providerUpdatedAt: row.providerUpdatedAt,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sendable: isMetaTemplateSendable(row.status, row.archivedAt),
  };
}

function draftInput(input: {
  name: unknown;
  language: unknown;
  category: unknown;
  components: unknown;
}): {
  name: string;
  language: string;
  category: string;
  components: MetaTemplateComponent[];
} {
  const name = nonEmptyString(input.name);
  const language = nonEmptyString(input.language);
  const category = nonEmptyString(input.category);
  if (!name || !/^[a-z0-9_]{1,512}$/.test(name)) {
    throw new MetaTemplateError(400, 'META_TEMPLATE_NAME_INVALID', 'اسم القالب يجب أن يتكون من أحرف صغيرة وأرقام وشرطة سفلية.');
  }
  if (!language || language.length > 35) {
    throw new MetaTemplateError(400, 'META_TEMPLATE_LANGUAGE_INVALID', 'لغة القالب مطلوبة.');
  }
  if (!category || !SUPPORTED_CATEGORIES.has(category)) {
    throw new MetaTemplateError(400, 'META_TEMPLATE_CATEGORY_UNSUPPORTED', 'فئة القالب يجب أن تكون Utility أو Marketing.');
  }
  if (!Array.isArray(input.components)) {
    throw new MetaTemplateError(400, 'META_TEMPLATE_COMPONENTS_INVALID', 'مكوّنات القالب مطلوبة.');
  }
  const validation = validateMetaTemplateComponents(category, input.components);
  if (!validation.supported) {
    throw new MetaTemplateError(400, 'META_TEMPLATE_COMPONENTS_UNSUPPORTED', validation.reason || 'مكوّنات القالب غير مدعومة.');
  }
  return { name, language, category, components: input.components as MetaTemplateComponent[] };
}

async function currentWabaTemplate(id: string, wabaId: string) {
  // Both organizationId and wabaId are intentional. The first is the tenant
  // boundary; the second prevents a template from an old or different WABA
  // being submitted through the current credential.
  return prisma.metaMessageTemplate.findFirst({ where: { id, wabaId } });
}

export async function createMetaTemplateDraft(input: {
  name: unknown;
  language: unknown;
  category: unknown;
  components: unknown;
}) {
  const credential = await activeCredential();
  const draft = draftInput(input);
  const duplicate = await prisma.metaMessageTemplate.findFirst({
    where: { wabaId: credential.wabaId, name: draft.name, language: draft.language, archivedAt: null },
    select: { id: true },
  });
  if (duplicate) {
    throw new MetaTemplateError(409, 'META_TEMPLATE_DUPLICATE', 'يوجد قالب نشط بالاسم واللغة نفسيهما.');
  }

  const row = await prisma.metaMessageTemplate.create({
    data: {
      organizationId: getTenantId(),
      wabaId: credential.wabaId,
      name: draft.name,
      language: draft.language,
      category: draft.category,
      components: draft.components as unknown as Prisma.InputJsonValue,
      status: 'DRAFT',
      isSupported: true,
    },
  });
  return templateView(row);
}

export async function listMetaTemplates(includeArchived = false) {
  const credential = await prisma.metaChannelCredential.findFirst({
    select: { wabaId: true, status: true, lastValidatedAt: true },
  });
  const rows = await prisma.metaMessageTemplate.findMany({
    where: includeArchived ? undefined : { archivedAt: null },
    orderBy: [{ archivedAt: 'asc' }, { updatedAt: 'desc' }],
  });
  return {
    templates: rows.map(templateView),
    wabaId: credential?.wabaId || null,
    credentialStatus: credential?.status || null,
    lastValidatedAt: credential?.lastValidatedAt || null,
  };
}

export async function submitMetaTemplate(id: string, api = defaultMetaTemplateApi) {
  const credential = await activeCredential();
  const row = await currentWabaTemplate(id, credential.wabaId);
  if (!row) throw new MetaTemplateError(404, 'META_TEMPLATE_NOT_FOUND', 'القالب غير موجود في حساب Meta الحالي.');
  if (row.archivedAt) throw new MetaTemplateError(409, 'META_TEMPLATE_ARCHIVED', 'لا يمكن إرسال قالب مؤرشف.');
  if (row.status !== 'DRAFT') throw new MetaTemplateError(409, 'META_TEMPLATE_NOT_DRAFT', 'لا يمكن إرسال القالب إلا من حالة المسودة.');

  const input = draftInput({
    name: row.name,
    language: row.language,
    category: row.category,
    components: row.components,
  });
  const response = await api.create(credential.wabaId, credential.accessToken, input);
  const providerId = nonEmptyString(response.id);
  if (!providerId) throw new MetaTemplateError(502, 'META_TEMPLATE_PROVIDER_ID_MISSING', 'لم تُرجع Meta معرّف القالب.');

  const updated = await prisma.metaMessageTemplate.update({
    where: { id },
    data: {
      providerId,
      status: providerStatus(response.status, 'PENDING'),
      rejectionReason: response.rejected_reason || null,
      submittedAt: new Date(),
      lastSyncedAt: new Date(),
      providerUpdatedAt: providerDate(response.last_updated_time),
    },
  });
  return templateView(updated);
}

export async function archiveMetaTemplate(id: string) {
  const row = await prisma.metaMessageTemplate.findFirst({ where: { id }, select: { id: true, archivedAt: true } });
  if (!row) throw new MetaTemplateError(404, 'META_TEMPLATE_NOT_FOUND', 'القالب غير موجود.');
  const updated = row.archivedAt
    ? await prisma.metaMessageTemplate.findUniqueOrThrow({ where: { id } })
    : await prisma.metaMessageTemplate.update({ where: { id }, data: { archivedAt: new Date() } });
  return templateView(updated);
}

function snapshotComponents(snapshot: MetaTemplateSnapshot, existing: Prisma.JsonValue | undefined): unknown {
  return Array.isArray(snapshot.components) ? snapshot.components : existing || [];
}

async function syncWabaTemplates(
  credential: { organizationId: string; wabaId: string; accessToken: string },
  api: MetaTemplateApi,
) {
  let after: string | undefined;
  let pages = 0;
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  while (pages < 1000) {
    const page: MetaTemplateListPage = await api.list(credential.wabaId, credential.accessToken, after);
    pages += 1;
    const rows = Array.isArray(page.data) ? page.data : [];
    for (const snapshot of rows) {
      const providerId = nonEmptyString(snapshot.id);
      const name = nonEmptyString(snapshot.name);
      const language = nonEmptyString(snapshot.language);
      const category = nonEmptyString(snapshot.category) || 'UNKNOWN';
      if (!providerId || !name || !language) {
        skipped += 1;
        continue;
      }

      const existing = await prisma.metaMessageTemplate.findFirst({ where: { wabaId: credential.wabaId, providerId } });
      const components = snapshotComponents(snapshot, existing?.components);
      const validation = validateMetaTemplateComponents(category, components);
      const data = {
        organizationId: credential.organizationId,
        wabaId: credential.wabaId,
        providerId,
        name,
        language,
        category,
        components: components as Prisma.InputJsonValue,
        status: providerStatus(snapshot.status),
        rejectionReason: snapshot.rejected_reason || null,
        isSupported: validation.supported,
        unsupportedReason: validation.reason,
        lastSyncedAt: new Date(),
        providerUpdatedAt: providerDate(snapshot.last_updated_time),
      };
      if (existing) {
        await prisma.metaMessageTemplate.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await prisma.metaMessageTemplate.create({ data });
        imported += 1;
      }
    }

    const next = page.paging?.cursors?.after || undefined;
    if (!next || next === after) break;
    after = next;
  }

  if (pages >= 1000) throw new MetaTemplateError(502, 'META_TEMPLATE_PAGINATION_LIMIT', 'توقفت مزامنة قوالب Meta عند حد الصفحات الآمن.');
  return { pages, imported, updated, skipped, wabaId: credential.wabaId };
}

export async function syncCurrentMetaTemplates(api = defaultMetaTemplateApi) {
  const credential = await activeCredential();
  return syncWabaTemplates({ organizationId: getTenantId(), ...credential }, api);
}

export async function syncAllMetaTemplates(api = defaultMetaTemplateApi) {
  const credentials = await runAsPlatform('meta-template-sync:list-active-credentials', () =>
    prisma.metaChannelCredential.findMany({
      where: { status: 'ACTIVE' },
      select: { organizationId: true, wabaId: true, accessTokenEnc: true },
    }),
  );
  const result = { organizations: 0, pages: 0, imported: 0, updated: 0, skipped: 0, failures: 0 };
  for (const credential of credentials) {
    try {
      const synced = await runAsOrganization(credential.organizationId, () => syncWabaTemplates({
        organizationId: credential.organizationId,
        wabaId: credential.wabaId,
        accessToken: decryptCredential(credential.accessTokenEnc),
      }, api));
      result.organizations += 1;
      result.pages += synced.pages;
      result.imported += synced.imported;
      result.updated += synced.updated;
      result.skipped += synced.skipped;
    } catch (error) {
      result.failures += 1;
      logger.warn('Meta template polling failed for one organization', {
        organizationId: credential.organizationId,
        wabaId: credential.wabaId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/** Apply a WABA-level webhook event; inactive channel status does not block it. */
export async function applyMetaTemplateStatusChange(input: {
  organizationId: string;
  wabaId: string;
  value: Record<string, unknown>;
}): Promise<boolean> {
  const providerId = nonEmptyString(input.value.message_template_id);
  const name = nonEmptyString(input.value.message_template_name);
  const language = nonEmptyString(input.value.message_template_language);
  if (!providerId && (!name || !language)) return false;

  const row = await prisma.metaMessageTemplate.findFirst({
    where: {
      wabaId: input.wabaId,
      ...(providerId ? { providerId } : { name: name as string, language: language as string }),
    },
    select: { id: true },
  });
  if (!row) return false;

  const status = providerStatus(input.value.event ?? input.value.status);
  const reason = nonEmptyString(input.value.reason);
  await prisma.metaMessageTemplate.update({
    where: { id: row.id },
    data: {
      status,
      rejectionReason: reason,
      lastSyncedAt: new Date(),
    },
  });
  return true;
}
