import crypto from 'crypto';
import { getEdition } from '../billing/editions.service';
import { normalizePlanCode, PlanEntitlements } from '../billing/plans';
import fs from 'fs/promises';
import path from 'path';
import { OrganizationBranding, Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { runAsPlatform } from '../../lib/tenant-context';
import { signingSecret } from '../../lib/signing-secret';

export type PublicBranding = {
  productName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryHsl: string;
  accentHsl: string;
  defaultLocale: string;
  direction: string;
  tier: string;
  footerText: string;
  canCustomizeFooter: boolean;
};

export type BrandingInput = Partial<{
  productName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryHsl: string;
  accentHsl: string;
  defaultLocale: string;
  direction: string;
  customDomain: string | null;
  customFooter: string | null;
}>;

export type BrandingUpdateData = BrandingInput &
  Partial<{
    customDomainVerificationToken: string | null;
    customDomainVerifiedAt: Date | null;
  }>;

const DEFAULT_BRANDING: PublicBranding = {
  productName: 'RabiTech',
  logoUrl: null,
  faviconUrl: null,
  primaryHsl: '262 83% 63%',
  accentHsl: '195 90% 60%',
  defaultLocale: 'ar',
  direction: 'rtl',
  tier: 'FREE',
  footerText: 'Powered by RabiTech',
  canCustomizeFooter: false,
};

const HSL_PATTERN = /^\d{1,3}(?:\.\d+)?\s+\d{1,3}(?:\.\d+)?%\s+\d{1,3}(?:\.\d+)?%$/;
const REQUIRED_ATTRIBUTION = 'Powered by RabiTech';
const ASSET_ROUTE_PREFIX = '/api/branding/assets';

/**
 * How branding learns which edition an organization is on.
 *
 * It read `Organization.tier` until 2026-09-06 — a second column holding a
 * plan code, kept in step with the subscription by hand. The subscription is
 * the row that actually records what was bought, so branding asks it
 * directly (D-18). Only live statuses count: a cancelled subscription still
 * carries a planCode, and honouring it would keep white-label switched on
 * for an organization that has stopped paying for it.
 */
const ORGANIZATION_PLAN_SELECT = {
  subscriptions: {
    where: { status: { in: ['ACTIVE', 'TRIALING'] } },
    select: { planCode: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.OrganizationSelect;

type BrandingWithOrg = OrganizationBranding & {
  organization?: { subscriptions: { planCode: string }[] } | null;
};

/**
 * The edition for a plan code, falling back to the least privileged one.
 *
 * normalizePlanCode throws on a code it does not recognise, and a branding read
 * must not fail with a 500 because a stored code was unexpected. FREE is the
 * safe answer: an unknown code grants nothing.
 */
function editionFor(planCode: string | null | undefined): PlanEntitlements {
  try {
    return getEdition(normalizePlanCode(planCode));
  } catch {
    return getEdition('FREE');
  }
}

/**
 * Whether this tier may replace the "Powered by RabiTech" attribution.
 *
 * Reads the resolved edition. This used to consult a Set of tier names local to
 * this file - a second source of truth that could disagree with the catalogue,
 * so the billing summary could report whiteLabel granted while branding refused
 * it. There is one answer now, and the owner can change it without a deploy.
 */
export function canCustomizeFooter(tier: string | null | undefined): boolean {
  return editionFor(tier).whiteLabel;
}

export function publicBranding(row?: BrandingWithOrg | null): PublicBranding {
  if (!row) return DEFAULT_BRANDING;
  const tier = String(row.organization?.subscriptions?.[0]?.planCode || 'FREE').toUpperCase();
  const footerEditable = canCustomizeFooter(tier);
  return {
    productName: row.productName,
    logoUrl: row.logoUrl,
    faviconUrl: row.faviconUrl,
    primaryHsl: row.primaryHsl,
    accentHsl: row.accentHsl,
    defaultLocale: row.defaultLocale,
    direction: row.direction,
    tier,
    footerText: footerEditable ? row.customFooter || '' : REQUIRED_ATTRIBUTION,
    canCustomizeFooter: footerEditable,
  };
}

function cleanOptionalUrl(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.startsWith(`${ASSET_ROUTE_PREFIX}/`)) return text;
  throw new Error('Branding assets must be uploaded to local branding storage');
}

function cleanHsl(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!HSL_PATTERN.test(text)) throw new Error(`${field} must be an HSL triplet like "262 83% 63%"`);
  const [h, s, l] = text.split(' ');
  if (Number(h) > 360 || Number(s.replace('%', '')) > 100 || Number(l.replace('%', '')) > 100) {
    throw new Error(`${field} is outside the valid HSL range`);
  }
  return text;
}

function cleanDomain(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  const domain = text.replace(/:\d+$/, '');
  if (
    !/^[a-z0-9.-]+$/.test(domain) ||
    domain.includes('..') ||
    domain.startsWith('.') ||
    domain.endsWith('.') ||
    !domain.includes('.') ||
    domain.length > 253
  ) {
    throw new Error('Custom domain is invalid');
  }
  return domain;
}

function cleanCustomFooter(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > 140) throw new Error('Custom footer must be 140 characters or less');
  return text;
}

export function normalizeBrandingInput(input: BrandingInput): BrandingInput {
  const data: BrandingInput = {};
  if (input.productName !== undefined) {
    const productName = String(input.productName || '').trim();
    if (!productName) throw new Error('Product name is required');
    data.productName = productName.slice(0, 80);
  }
  data.logoUrl = cleanOptionalUrl(input.logoUrl);
  data.faviconUrl = cleanOptionalUrl(input.faviconUrl);
  data.primaryHsl = cleanHsl(input.primaryHsl, 'primaryHsl');
  data.accentHsl = cleanHsl(input.accentHsl, 'accentHsl');
  if (input.defaultLocale !== undefined) {
    const locale = String(input.defaultLocale || '').trim().toLowerCase();
    if (!['ar', 'he', 'en'].includes(locale)) throw new Error('defaultLocale must be ar, he, or en');
    data.defaultLocale = locale;
  }
  if (input.direction !== undefined) {
    const direction = String(input.direction || '').trim().toLowerCase();
    if (!['rtl', 'ltr'].includes(direction)) throw new Error('direction must be rtl or ltr');
    data.direction = direction;
  }
  data.customDomain = cleanDomain(input.customDomain);
  data.customFooter = cleanCustomFooter(input.customFooter);
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as BrandingInput;
}

export function assertFooterEntitlement(tier: string, input: BrandingInput): void {
  const edition = editionFor(tier);
  if (Object.prototype.hasOwnProperty.call(input, 'customFooter') && !edition.whiteLabel) {
    throw new Error('Current plan requires Powered by RabiTech attribution');
  }
  // Deliberately does not name a tier. Which editions grant custom domains is
  // now owner-editable, so a message promising "Business or higher" would start
  // lying the first time the catalogue is changed.
  if (input.customDomain && !edition.customDomain) {
    throw new Error('Custom domains are not included in the current plan');
  }
}

export function buildBrandingUpdateData(input: BrandingInput, current?: OrganizationBranding | null): BrandingUpdateData {
  const data = { ...input };
  if (Object.prototype.hasOwnProperty.call(data, 'customDomain') && data.customDomain !== current?.customDomain) {
    return {
      ...data,
      customDomainVerificationToken: data.customDomain ? crypto.randomBytes(24).toString('hex') : null,
      customDomainVerifiedAt: null,
    };
  }
  return data;
}

export async function getPublicBrandingForHost(hostHeader: string | undefined): Promise<PublicBranding> {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  if (!host || ['localhost', '127.0.0.1', '0.0.0.0'].includes(host)) return DEFAULT_BRANDING;
  const row = await runAsPlatform(`branding-public:${host}`, () =>
    prisma.organizationBranding.findUnique({
      where: { customDomain: host },
      include: { organization: { select: ORGANIZATION_PLAN_SELECT } },
    }),
  );
  return publicBranding(row);
}

export type BrandingAssetKind = 'logo' | 'favicon';

export type ValidatedBrandingAsset = {
  ext: 'png' | 'jpg' | 'svg' | 'webp';
  contentType: string;
  body: Buffer;
};

export function brandingUploadRoot(): string {
  return process.env.BRANDING_UPLOAD_DIR || path.resolve(process.cwd(), 'uploads', 'branding');
}

export function signBrandingAsset(organizationId: string, kind: BrandingAssetKind, fileName: string): string {
  const secret = signingSecret();
  return crypto.createHmac('sha256', secret).update(`${organizationId}:${kind}:${fileName}`).digest('hex');
}

export function brandingAssetUrl(organizationId: string, kind: BrandingAssetKind, fileName: string): string {
  return `${ASSET_ROUTE_PREFIX}/${organizationId}/${kind}/${fileName}?sig=${signBrandingAsset(organizationId, kind, fileName)}`;
}

export function verifyBrandingAssetSignature(
  organizationId: string,
  kind: BrandingAssetKind,
  fileName: string,
  signature: string,
): boolean {
  const expected = signBrandingAsset(organizationId, kind, fileName);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function assetFieldForKind(kind: BrandingAssetKind): 'logoUrl' | 'faviconUrl' {
  return kind === 'logo' ? 'logoUrl' : 'faviconUrl';
}

export function validateBrandingAsset(body: Buffer): ValidatedBrandingAsset {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error('Upload body is required');
  if (body.length > 2 * 1024 * 1024) throw new Error('Branding asset must be 2MB or smaller');

  const head = body.subarray(0, 16);
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', contentType: 'image/png', body };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg', body };
  }
  if (
    head.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', contentType: 'image/webp', body };
  }

  const text = body.toString('utf8').trimStart();
  const lower = text.toLowerCase();
  if ((lower.startsWith('<svg') || (lower.startsWith('<?xml') && lower.includes('<svg'))) && lower.includes('</svg')) {
    if (/<script\b/i.test(text) || /\son[a-z]+\s*=/i.test(text)) {
      throw new Error('SVG assets cannot include scripts or event handlers');
    }
    return { ext: 'svg', contentType: 'image/svg+xml', body: Buffer.from(text, 'utf8') };
  }

  throw new Error('Unsupported branding asset type');
}

export async function storeBrandingAsset(
  organizationId: string,
  kind: BrandingAssetKind,
  asset: ValidatedBrandingAsset,
): Promise<string> {
  const fileName = `${crypto.randomUUID()}.${asset.ext}`;
  const dir = path.join(brandingUploadRoot(), organizationId, kind);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fileName), asset.body, { mode: 0o600 });
  return brandingAssetUrl(organizationId, kind, fileName);
}

export function brandingAssetPath(organizationId: string, kind: BrandingAssetKind, fileName: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(organizationId) || !/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
    throw new Error('Invalid asset path');
  }
  return path.join(brandingUploadRoot(), organizationId, kind, fileName);
}
