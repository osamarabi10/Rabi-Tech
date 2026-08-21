'use client';

import { Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBranding } from '@/lib/branding-context';

export function BrandLogo({
  size = 'md',
  showText = true,
  subtitle,
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  showText?: boolean;
  subtitle?: string;
  className?: string;
}) {
  const branding = useBranding();
  const markSize = size === 'lg' ? 'h-14 w-14 rounded-2xl' : size === 'sm' ? 'h-8 w-8 rounded-lg' : 'h-10 w-10 rounded-lg';
  const iconSize = size === 'lg' ? 'h-7 w-7' : 'h-4 w-4';

  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden bg-gradient-to-br from-primary to-[hsl(var(--brand-gradient-to))] text-white shadow-glow-sm',
          markSize,
        )}
      >
        {branding.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={branding.logoUrl} alt="" className="h-full w-full object-contain p-1.5" />
        ) : (
          <Globe className={iconSize} />
        )}
      </div>
      {showText && (
        <div className="min-w-0 leading-tight">
          <p className="truncate text-small font-bold tracking-wide text-foreground">
            {branding.productName}
          </p>
          {subtitle && <p className="truncate text-micro text-muted-foreground">{subtitle}</p>}
        </div>
      )}
    </div>
  );
}
