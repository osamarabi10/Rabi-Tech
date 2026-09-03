import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { verifyToken } from '../auth/auth.middleware';
import { requireAdmin, requirePermission } from '../../middleware/rbac.middleware';
import {
  API_SCOPES,
  DEFAULT_TOKEN_DAYS,
  isValidScope,
  issueApiToken,
  type ApiScope,
} from './api-token.service';

/**
 * Managing API tokens, from the console.
 *
 * ## Guarded twice, deliberately
 *
 * `requireAdmin` **and** `requirePermission('system:config')`. The first is the
 * role floor; the second is what makes `restrictWorkspaceSettings` actually
 * withdraw this screen. That pairing is not redundancy — a route guarded by
 * `requireAdmin` alone is invisible to the restriction table, which is how the
 * first draft of the per-user restrictions shipped a checkbox that gated
 * nothing. An admin restricted from organization settings who can still mint a
 * organization-wide credential has not been restricted from anything.
 *
 * ## Language
 *
 * Errors here are Arabic, like every other console route. The public API's
 * errors are English, because the reader is an integrator reading a log rather
 * than a subscriber's agent reading a screen. Both are deliberate.
 */

const router = Router();
router.use(verifyToken, requireAdmin, requirePermission('system:config'), requirePermission('integration:manage'));

/** Enough tokens for real integration work; few enough that the list stays readable. */
const MAX_LIVE_TOKENS = 20;
const MAX_NAME_LENGTH = 60;
const MAX_EXPIRY_DAYS = 365;

/**
 * What a listed token exposes.
 *
 * `tokenHash` is absent and must stay absent. It is not a secret that grants
 * access on its own, but publishing it turns an offline guess into a check
 * against a known answer, and nothing in the console has any use for it.
 */
const TOKEN_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  maskContactDetails: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

/** The scope catalogue, so the console never hardcodes a list the server may outgrow. */
router.get('/scopes', (_req, res) => {
  res.json({ scopes: API_SCOPES, defaultExpiryDays: DEFAULT_TOKEN_DAYS });
});

router.get('/', async (req, res) => {
  try {
    const tokens = await prisma.apiToken.findMany({
      select: TOKEN_SELECT,
      // Live tokens first, then by age. A revoked token stays visible: it is the
      // record of a credential that once existed, and deleting the row would
      // erase the only evidence of what an integration was doing.
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ tokens });
  } catch (err: any) {
    logger.error('Failed to list API tokens', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر جلب المفاتيح' });
  }
});

router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'اسم المفتاح مطلوب' });
    if (name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `اسم المفتاح طويل جدًا (الحد ${MAX_NAME_LENGTH} حرفًا)` });
    }

    const rawScopes = Array.isArray(req.body?.scopes) ? req.body.scopes : [];
    const unknown = rawScopes.filter((s: unknown) => !isValidScope(s));
    if (unknown.length) {
      // Refused rather than silently dropped. A token created with a misspelled
      // scope would authenticate and then 403 on the one endpoint it exists to
      // call, and the misspelling is invisible in every screen that lists it.
      return res.status(400).json({ error: 'صلاحية غير معروفة', details: unknown });
    }
    const scopes = rawScopes as ApiScope[];
    if (!scopes.length) {
      return res.status(400).json({ error: 'اختر صلاحية واحدة على الأقل' });
    }

    /*
      Expiry. `null` means never, and the console has to send it explicitly —
      an absent field gets the 90-day default rather than immortality, because
      the field most likely to be absent is the one a script forgot to send.
    */
    let expiresInDays: number | null = DEFAULT_TOKEN_DAYS;
    if (req.body?.expiresInDays === null) {
      expiresInDays = null;
    } else if (req.body?.expiresInDays !== undefined) {
      const days = Number(req.body.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
        return res.status(400).json({ error: `مدة الصلاحية بين ١ و${MAX_EXPIRY_DAYS} يوم` });
      }
      expiresInDays = days;
    }

    const live = await prisma.apiToken.count({ where: { revokedAt: null } });
    if (live >= MAX_LIVE_TOKENS) {
      return res.status(409).json({
        error: `وصلت الحد الأقصى (${MAX_LIVE_TOKENS} مفتاح فعّال) — ألغِ مفتاحًا قديمًا أولًا`,
      });
    }

    const issued = await issueApiToken({
      name,
      scopes,
      expiresInDays,
      createdById: req.user?.id ?? null,
      /*
        The token inherits its creator's masking.

        `maskPhoneAndEmail` hides contact phone numbers and email addresses from
        an individual user, and until this line it was enforced only on routes
        that read `req.user`. A token carries no user, so a masked admin — masked
        but not restricted from workspace settings, which are separate flags —
        could mint a `contacts:read` token and read every unmasked number in the
        workspace. The restriction was real everywhere except through the door
        this module opened.
      */
      maskContactDetails: !!req.user?.maskPhoneAndEmail,
    });

    // The prefix identifies the token in the log; the secret never appears in
    // one. This line is how an organization owner later ties "who made this" to a
    // token they find in the list.
    logger.info('API token issued', {
      prefix: issued.prefix,
      scopes: issued.scopes,
      byUserId: req.user?.id,
      requestId: (req as any).id,
    });

    res.status(201).json({
      token: issued,
      warning: 'انسخ المفتاح الآن — ما رح يظهر مرة تانية',
    });
  } catch (err: any) {
    logger.error('Failed to issue API token', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر إنشاء المفتاح' });
  }
});

/**
 * Revoke. Soft, and irreversible on purpose.
 *
 * The row survives so the list keeps showing that this credential existed, what
 * it could do and when it was last used — the questions asked *after* a leak,
 * when the row is the only thing that can answer them. There is no un-revoke:
 * a credential that can be brought back is one an attacker can bring back.
 */
router.delete('/:id', async (req, res) => {
  try {
    const id = String(req.params.id);

    // The tenancy extension scopes this update, so an id from another organization
    // matches nothing and reports as not-found rather than revoking it.
    const result = await prisma.apiToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (result.count === 0) {
      return res.status(404).json({ error: 'المفتاح غير موجود أو ملغى مسبقًا' });
    }

    logger.info('API token revoked', {
      tokenId: id,
      byUserId: req.user?.id,
      requestId: (req as any).id,
    });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Failed to revoke API token', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر إلغاء المفتاح' });
  }
});

export default router;
