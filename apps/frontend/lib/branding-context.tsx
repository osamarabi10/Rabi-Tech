'use client';

import { createContext, useContext } from 'react';
import { Branding, DEFAULT_BRANDING, normalizeBranding } from './branding';

const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

export function BrandingProvider({
  branding,
  children,
}: {
  branding?: Partial<Branding> | null;
  children: React.ReactNode;
}) {
  return (
    <BrandingContext.Provider value={normalizeBranding(branding)}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): Branding {
  return useContext(BrandingContext);
}
