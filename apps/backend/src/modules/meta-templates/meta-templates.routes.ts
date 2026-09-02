import { Router } from 'express';
import { auditLog } from '../../lib/audit';
import { permissionsForRole, requireAdmin, requirePermission } from '../../middleware/rbac.middleware';
import { verifyToken } from '../auth/auth.middleware';
import { MetaApiError } from '../channels/meta.client';
import { sendMetaTemplate, TemplateSendError } from './meta-template-send.service';
import logger from '../../lib/logger';
import {
  archiveMetaTemplate,
  createMetaTemplateDraft,
  isMetaTemplateError,
  listMetaTemplates,
  submitMetaTemplate,
  syncCurrentMetaTemplates,
} from './meta-templates.service';

const router = Router();
router.use(verifyToken);

function errorResponse(res: any, error: unknown) {
  if (isMetaTemplateError(error)) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  if (error instanceof MetaApiError) {
    return res.status(502).json({
      error: 'تعذر الوصول إلى Meta حالياً. أعد المحاولة بعد التحقق من بيانات الاعتماد.',
      code: 'META_API_UNAVAILABLE',
    });
  }
  throw error;
}

router.get('/', requirePermission('campaign:read'), async (req: any, res) => {
  try {
    const result = await listMetaTemplates(String(req.query.archived || '') === 'true');
    const permissions = permissionsForRole(req.user?.role || '');
    return res.json({
      ...result,
      canManage: permissions.includes('campaign:create'),
      canSync: req.user?.role === 'ADMIN',
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/', requirePermission('campaign:create'), async (req: any, res) => {
  try {
    const template = await createMetaTemplateDraft({
      name: req.body?.name,
      language: req.body?.language,
      category: req.body?.category,
      components: req.body?.components,
    });
    await auditLog({
      userId: req.user?.id,
      action: 'meta-template.draft.created',
      resource: 'MetaMessageTemplate',
      resourceId: template.id,
      description: `name=${template.name} language=${template.language}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.status(201).json(template);
  } catch (error) {
    return errorResponse(res, error);
  }
});

/** Import is provider-owned synchronization, exposed separately from polling. */
router.post('/import', requireAdmin, async (req: any, res) => {
  try {
    const result = await syncCurrentMetaTemplates();
    await auditLog({
      userId: req.user?.id,
      action: 'meta-template.imported',
      resource: 'MetaMessageTemplate',
      resourceId: 'current-waba',
      description: `pages=${result.pages} imported=${result.imported} updated=${result.updated}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.json(result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

/** Visible repair action for webhook drift. */
router.post('/sync', requireAdmin, async (req: any, res) => {
  try {
    const result = await syncCurrentMetaTemplates();
    await auditLog({
      userId: req.user?.id,
      action: 'meta-template.sync',
      resource: 'MetaMessageTemplate',
      resourceId: 'current-waba',
      description: `pages=${result.pages} imported=${result.imported} updated=${result.updated}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.json(result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/:id/submit', requirePermission('campaign:create'), async (req: any, res) => {
  try {
    const template = await submitMetaTemplate(req.params.id);
    await auditLog({
      userId: req.user?.id,
      action: 'meta-template.submitted',
      resource: 'MetaMessageTemplate',
      resourceId: template.id,
      description: `providerId=${template.providerId || 'missing'}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.json(template);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/:id/archive', requirePermission('campaign:create'), async (req: any, res) => {
  try {
    const template = await archiveMetaTemplate(req.params.id);
    await auditLog({
      userId: req.user?.id,
      action: 'meta-template.archived',
      resource: 'MetaMessageTemplate',
      resourceId: template.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.json(template);
  } catch (error) {
    return errorResponse(res, error);
  }
});

/**
 * POST /api/meta-templates/:id/send — start a conversation.
 *
 * The one send that does not require the customer to have written first, and
 * therefore the only way a Meta-only workspace can initiate anything at all.
 *
 * Guarded by `conversation:create` rather than a template permission: what this
 * does is message a customer, and that is the permission that governs messaging
 * a customer. A separate one would let somebody who may not send a message send
 * the one kind that reaches people who never wrote in.
 */
router.post('/:id/send', requirePermission('conversation:create'), async (req, res) => {
  try {
    const contactId = String(req.body?.contactId || '').trim();
    if (!contactId) return res.status(400).json({ error: 'جهة الاتصال مطلوبة' });

    const variables = Array.isArray(req.body?.variables)
      ? req.body.variables.map((value: unknown) => String(value ?? ''))
      : [];

    const result = await sendMetaTemplate({
      templateId: String(req.params.id),
      contactId,
      variables,
      source: 'MANUAL',
    });

    res.status(202).json(result);
  } catch (err: any) {
    if (err instanceof TemplateSendError) {
      // The code travels with the message so the composer can react - an
      // opted-out contact and a rejected template need different UI.
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    logger.error('Template send failed', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر إرسال القالب' });
  }
});

export default router;
