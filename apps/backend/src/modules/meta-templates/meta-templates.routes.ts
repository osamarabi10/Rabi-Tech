import { Router } from 'express';
import { auditLog } from '../../lib/audit';
import { permissionsForRole, requireAdmin, requirePermission } from '../../middleware/rbac.middleware';
import { verifyToken } from '../auth/auth.middleware';
import { MetaApiError } from '../channels/meta.client';
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

export default router;
