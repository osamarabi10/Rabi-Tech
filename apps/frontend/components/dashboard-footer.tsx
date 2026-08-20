'use client';

import { useBranding } from '@/lib/branding-context';

export function DashboardFooter() {
  const branding = useBranding();
  if (!branding.footerText) return null;

  return (
    <footer className="shrink-0 border-t border-border px-5 py-2 text-center text-[11px] text-muted-foreground">
      {branding.footerText}
    </footer>
  );
}
