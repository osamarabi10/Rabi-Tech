import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { Providers } from '@/components/providers';
import { brandingCssVars, fetchPublicBranding } from '@/lib/branding';

async function brandingForRequest() {
  const headerList = await headers();
  return fetchPublicBranding(
    headerList.get('x-rabitech-public-host') || headerList.get('host') || undefined,
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const branding = await brandingForRequest();
  return {
    title: `${branding.productName} - Dashboard`,
    description: `${branding.productName} Operations Dashboard`,
    icons: branding.faviconUrl ? { icon: branding.faviconUrl } : undefined,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const branding = await brandingForRequest();
  return (
    <html lang={branding.defaultLocale} dir={branding.direction} className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={brandingCssVars(branding)}>
        <Providers branding={branding}>{children}</Providers>
      </body>
    </html>
  );
}
