'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Light / dark / system theme.
 *
 * The class is applied to `<html>` because Tailwind is configured with
 * `darkMode: ['class']`, and the palette lives entirely in CSS variables — so
 * flipping one class re-themes the whole product without a single `dark:`
 * utility in any component.
 *
 * The initial class is set by a blocking inline script in the layout, **not**
 * here. A React effect runs after first paint, so a dark-mode user would see a
 * white flash on every navigation. That flash is the single most noticeable
 * defect a theme toggle can have.
 */

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'rabitech_theme';

/**
 * Runs before paint, inlined into <head>.
 *
 * Deliberately dependency-free and defensive: it executes before anything else
 * on the page, and a throw here would leave the document unstyled.
 */
export const THEME_INIT_SCRIPT = `
(function(){try{
  var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
  var dark = stored === 'dark' ||
    ((!stored || stored === 'system') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList[dark ? 'add' : 'remove']('dark');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}catch(e){}})();
`;

type ThemeContextValue = {
  theme: Theme;
  /** What is actually on screen once `system` is resolved. */
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolved: 'light',
  setTheme: () => {},
});

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function apply(theme: Theme): 'light' | 'dark' {
  const dark = theme === 'dark' || (theme === 'system' && systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  // Tells the browser to render native controls, scrollbars and form widgets in
  // the matching scheme. Without it, a dark page still gets white scrollbars.
  root.style.colorScheme = dark ? 'dark' : 'light';
  return dark ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const stored = (localStorage.getItem(THEME_STORAGE_KEY) as Theme | null) || 'system';
    setThemeState(stored);
    setResolved(apply(stored));
  }, []);

  // Follow the OS while on `system`, so changing it at sunset is reflected
  // without a reload.
  useEffect(() => {
    if (theme !== 'system') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(apply('system'));
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setResolved(apply(next));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
