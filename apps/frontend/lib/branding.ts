import type { CSSProperties } from 'react';

export type Branding = {
  productName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryHsl: string;
  accentHsl: string;
  defaultLocale: 'ar' | 'he' | 'en';
  direction: 'rtl' | 'ltr';
  tier: string;
  footerText: string;
  canCustomizeFooter: boolean;
};

export const DEFAULT_BRANDING: Branding = {
  productName: 'RabiTech',
  logoUrl: null,
  faviconUrl: null,
  // Must track --primary / --brand-accent in globals.css. These are injected as
  // inline custom properties at runtime, so a stale value here silently wins
  // over the stylesheet and the theme never actually changes.
  primaryHsl: '217 100% 50%',  /* #0066FF */
  accentHsl: '200 72% 49%',    /* #229ED9 */
  defaultLocale: 'ar',
  direction: 'rtl',
  tier: 'FREE',
  footerText: 'Powered by RabiTech',
  canCustomizeFooter: false,
};

export function brandingApiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
}

function absoluteBrandingAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/api/branding/assets/')) return new URL(url, brandingApiBase()).toString();
  return url;
}

export function normalizeBranding(value: Partial<Branding> | null | undefined): Branding {
  return {
    productName: value?.productName || DEFAULT_BRANDING.productName,
    logoUrl: absoluteBrandingAssetUrl(value?.logoUrl) ?? DEFAULT_BRANDING.logoUrl,
    faviconUrl: absoluteBrandingAssetUrl(value?.faviconUrl) ?? DEFAULT_BRANDING.faviconUrl,
    primaryHsl: value?.primaryHsl || DEFAULT_BRANDING.primaryHsl,
    accentHsl: value?.accentHsl || DEFAULT_BRANDING.accentHsl,
    defaultLocale: value?.defaultLocale || DEFAULT_BRANDING.defaultLocale,
    direction: value?.direction || DEFAULT_BRANDING.direction,
    tier: value?.tier || DEFAULT_BRANDING.tier,
    footerText: value?.footerText ?? DEFAULT_BRANDING.footerText,
    canCustomizeFooter: Boolean(value?.canCustomizeFooter),
  };
}

export function brandingCssVars(branding: Branding): CSSProperties {
  return {
    '--primary': branding.primaryHsl,
    '--ring': branding.primaryHsl,
    '--glow-primary': branding.primaryHsl,
    '--brand-accent': branding.accentHsl,
    '--brand-gradient-to': branding.accentHsl,
  } as CSSProperties;
}

export async function fetchPublicBranding(host?: string): Promise<Branding> {
  try {
    const url = new URL('/api/branding/public', brandingApiBase());
    if (host) url.searchParams.set('host', host);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return DEFAULT_BRANDING;
    return normalizeBranding(await response.json());
  } catch {
    return DEFAULT_BRANDING;
  }
}
