'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Inbox list density.
 *
 * The conversation list is the one surface an agent stares at all day, and how
 * many threads fit on screen without scrolling is a real working preference,
 * not decoration. Three steps rather than a slider, because the useful choices
 * are discrete: "fit as many as possible", "the default", and "I want room to
 * read the preview line".
 *
 * Persisted per browser rather than per user record: it is a property of the
 * screen someone is sitting at, and the same person on a laptop and a wall
 * display wants different answers.
 */

export type Density = 'compact' | 'comfortable' | 'spacious';

const STORAGE_KEY = 'rabitech_density';

type DensityCtx = {
  density: Density;
  setDensity: (value: Density) => void;
};

const Ctx = createContext<DensityCtx>({ density: 'comfortable', setDensity: () => {} });

export function DensityProvider({ children }: { children: React.ReactNode }) {
  const [density, setDensityState] = useState<Density>('comfortable');

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY) as Density | null;
    if (saved === 'compact' || saved === 'comfortable' || saved === 'spacious') {
      setDensityState(saved);
    }
  }, []);

  const setDensity = useCallback((value: Density) => {
    window.localStorage.setItem(STORAGE_KEY, value);
    setDensityState(value);
  }, []);

  const value = useMemo(() => ({ density, setDensity }), [density, setDensity]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDensity(): DensityCtx {
  return useContext(Ctx);
}

/**
 * The classes each step applies to a conversation row.
 *
 * Logical properties throughout (`py`/`px`/`gap`, and `ms`/`me` where sides
 * differ), so the same values hold in Arabic and Hebrew without a mirrored set.
 * Compact also drops the preview line's leading, which is where the height
 * actually goes — trimming padding alone barely moves the row.
 */
export const DENSITY_CLASSES: Record<
  Density,
  { row: string; gap: string; avatar: string; preview: string; showPreview: boolean }
> = {
  compact: {
    row: 'px-2.5 py-1.5',
    gap: 'gap-2',
    avatar: 'h-7 w-7',
    preview: 'leading-tight',
    // The preview line is the single biggest contributor to row height, so the
    // densest step trades it away rather than shrinking everything into
    // illegibility.
    showPreview: false,
  },
  comfortable: {
    row: 'px-3 py-3',
    gap: 'gap-2.5',
    avatar: 'h-9 w-9',
    preview: 'leading-normal',
    showPreview: true,
  },
  spacious: {
    row: 'px-4 py-4',
    gap: 'gap-3',
    avatar: 'h-10 w-10',
    preview: 'leading-relaxed',
    showPreview: true,
  },
};
