import fs from 'fs/promises';
import express, { Router } from 'express';
import { OrganizationBranding } from '@prisma/client';
import { prisma } from '../../prisma';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { runAsPlatform } from '../../lib/tenant-context';
import {
  assetFieldForKind,
  assertFooterEntitlement,
  brandingAssetPath,
  BrandingAssetKind,
  buildBrandingUpdateData,
  getPublicBrandingForHost,
  normalizeBrandingInput,
  publicBranding,
  storeBrandingAsset,
  validateBrandingAsset,
  verifyBrandingAssetSignature,
} from './branding.service';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import logger from '../../lib/logger';

const router = Router();

type EditableBranding = OrganizationBranding & { organization?: { tier: string } | null };

function errorStatus(error: unknown): number {
  const message = String((error as Error).message || error);
  return message.includes('Powered by RabiTech attribution') ? 403 : 400;
}

function editableBranding(row: EditableBranding) {
  return {
    ...publicBranding(row),
    customDomain: row.customDomain,
    customFooter: row.customFooter,
    customDomainVerificationToken: row.customDomainVerificationToken,
    customDomainVerifiedAt: row.customDomainVerifiedAt,
    customDomainVerificationRecord: row.customDomainVerificationToken
      ? `rabitech-site-verification=${row.customDomainVerificationToken}`
      : null,
    customDomainVerified: Boolean(row.customDomainVerifiedAt),
  };
}

router.get('/public', async (req, res) => {
  try {
    const host = String(req.query.host || req.headers['x-forwarded-host'] || req.headers.host || '');
    res.json(await getPublicBrandingForHost(host));
  } catch {
    res.json(await getPublicBrandingForHost(undefined));
  }
});

router.get('/current', async (req, res) => {
  try {
    const row = await prisma.organizationBranding.findUnique({
      where: { organizationId: req.user!.organizationId },
      include: { organization: { select: { tier: true } } },
    });
    res.json(row ? editableBranding(row) : { ...publicBranding(null), customDomain: null, customFooter: null });
  } catch (error) {
    logger.error('Branding load failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to load branding' });
  }
});

router.patch('/current', requireAdmin, async (req, res) => {
  try {
    const normalized = normalizeBrandingInput(req.body || {});
    // The effective plan, so an organization overridden to BUSINESS can
    // actually remove the footer it is now paying to remove.
    const effective = await resolveEntitlements(req.user!.organizationId);
    assertFooterEntitlement(effective.plan, normalized);
    if (!Object.keys(normalized).length) {
      return res.status(400).json({ error: 'No branding fields supplied' });
    }
    const current = await prisma.organizationBranding.findUnique({
      where: { organizationId: req.user!.organizationId },
    });
    const data = buildBrandingUpdateData(normalized, current);
    const row = await prisma.organizationBranding.upsert({
      where: { organizationId: req.user!.organizationId },
      create: { ...data, organizationId: req.user!.organizationId },
      update: data,
      include: { organization: { select: { tier: true } } },
    });
    res.json(editableBranding(row));
  } catch (error) {
    res.status(errorStatus(error)).json({ error: String((error as Error).message || error) });
  }
});

router.post(
  '/current/:kind(logo|favicon)',
  requireAdmin,
  express.raw({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    try {
      const kind = req.params.kind as BrandingAssetKind;
      const asset = validateBrandingAsset(req.body as Buffer);
      const url = await storeBrandingAsset(req.user!.organizationId, kind, asset);
      const field = assetFieldForKind(kind);
      const row = await prisma.organizationBranding.upsert({
        where: { organizationId: req.user!.organizationId },
        create: { organizationId: req.user!.organizationId, [field]: url },
        update: { [field]: url },
        include: { organization: { select: { tier: true } } },
      });
      res.json(editableBranding(row));
    } catch (error) {
      res.status(400).json({ error: String((error as Error).message || error) });
    }
  },
);

router.get('/current/domain-verification', requireAdmin, async (req, res) => {
  try {
    const row = await prisma.organizationBranding.findUnique({
      where: { organizationId: req.user!.organizationId },
      include: { organization: { select: { tier: true } } },
    });
    if (!row?.customDomain) {
      return res.json({ customDomain: null, verified: false, record: null, token: null });
    }
    res.json({
      customDomain: row.customDomain,
      verified: Boolean(row.customDomainVerifiedAt),
      verifiedAt: row.customDomainVerifiedAt,
      token: row.customDomainVerificationToken,
      record: row.customDomainVerificationToken
        ? `rabitech-site-verification=${row.customDomainVerificationToken}`
        : null,
      status: row.customDomainVerifiedAt ? 'verified' : 'pending_dns',
    });
  } catch (error) {
    logger.error('Domain verification load failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to load domain verification' });
  }
});

router.get('/assets/:organizationId/:kind(logo|favicon)/:fileName', async (req, res) => {
  try {
    const kind = req.params.kind as BrandingAssetKind;
    const signature = String(req.query.sig || '');
    if (!verifyBrandingAssetSignature(req.params.organizationId, kind, req.params.fileName, signature)) {
      return res.status(403).json({ error: 'Invalid asset signature' });
    }
    const filePath = brandingAssetPath(req.params.organizationId, kind, req.params.fileName);
    const body = await fs.readFile(filePath);
    const asset = validateBrandingAsset(body);
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(asset.body);
  } catch {
    res.status(404).json({ error: 'Branding asset not found' });
  }
});

router.patch('/organizations/:organizationId', async (req, res) => {
  if (req.platformUser?.platformRole !== 'OWNER') {
    return res.status(403).json({ error: 'RabiTech owner access required' });
  }
  try {
    const normalized = normalizeBrandingInput(req.body || {});
    if (!Object.keys(normalized).length) {
      return res.status(400).json({ error: 'No branding fields supplied' });
    }
    const row = await runAsPlatform(`branding-platform-update:${req.params.organizationId}`, async () => {
      // The effective plan, not the raw tier. This path used to read
      // Organization.tier directly while the tenant-facing one resolved
      // entitlements, so an organization overridden to BUSINESS could remove its
      // own footer while the owner editing on its behalf was refused. Same
      // feature, two answers.
      const effective = await resolveEntitlements(req.params.organizationId);
      assertFooterEntitlement(effective.plan, normalized);
      const current = await prisma.organizationBranding.findUnique({
        where: { organizationId: req.params.organizationId },
      });
      const data = buildBrandingUpdateData(normalized, current);
      return prisma.organizationBranding.upsert({
        where: { organizationId: req.params.organizationId },
        create: { ...data, organizationId: req.params.organizationId },
        update: data,
        include: { organization: { select: { tier: true } } },
      });
    });
    res.json(editableBranding(row));
  } catch (error) {
    res.status(errorStatus(error)).json({ error: String((error as Error).message || error) });
  }
});

export default router;
