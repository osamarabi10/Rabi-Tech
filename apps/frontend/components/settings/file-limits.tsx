'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileUp, HardDrive, Paperclip, Image as ImageIcon } from 'lucide-react';
import { fetchSystemLimits, type SystemLimits } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';

/**
 * Files — the sizes this workspace actually enforces.
 *
 * ## Every number here comes from the server
 *
 * The tempting version hardcodes "20 MB" in this file. Then somebody changes
 * the constant that does the rejecting, and the page keeps saying 20 while
 * uploads fail at 15. An operator who is refused at a size the screen promised
 * stops trusting every other number on it — which is a worse outcome than
 * having no page.
 *
 * So the values are served from `/api/system/limits`, which reads the same
 * constants the upload handlers reject with.
 *
 * ## What is deliberately not here
 *
 * Respond.io publishes per-media-type caps — image 5 MB, video 16 MB and so on.
 * Those are WhatsApp's limits, not theirs, and we do not impose any of our own.
 * Repeating them here would state a rule this product does not apply, and the
 * first person to hit WhatsApp's actual behaviour would find our page wrong.
 * When a per-type cap is enforced, it appears here.
 */

const ICONS = {
  snippetAttachment: Paperclip,
  inboundMedia: ImageIcon,
  brandingAsset: HardDrive,
} as const;

function megabytes(bytes: number): string {
  return String(Math.round((bytes / (1024 * 1024)) * 10) / 10);
}

export function FileLimits() {
  const { t } = useT();
  const [limits, setLimits] = useState<SystemLimits | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try { setLimits(await fetchSystemLimits()); }
    catch { setFailed(true); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (failed) return <ErrorState title={t('Could not load the limits')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;
  if (!limits) return <LayoutSkeleton label={t('Loading limits')} className="m-4" />;

  const labels: Record<string, string> = {
    snippetAttachment: t('Saved reply attachments'),
    inboundMedia: t('Incoming media'),
    brandingAsset: t('Logo and branding images'),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b border-border px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">{t('Files')}</h1>
        <p className="mt-1 text-caption text-muted-foreground">
          {t('The sizes this workspace accepts. Anything larger is refused before it is stored.')}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {limits.files.map((file) => {
            const Icon = ICONS[file.key as keyof typeof ICONS] ?? Paperclip;
            return (
              <div key={file.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-small">{labels[file.key] ?? file.key}</span>
                <span className="ms-auto flex items-center gap-3">
                  {file.count !== undefined && (
                    <span className="text-micro text-muted-foreground">
                      {/* The count sits mid-sentence in all three languages, so
                          it survives translation where a trailing fragment
                          would not. */}
                      {t('up to')} <bdi dir="ltr">{file.count}</bdi> {t('files')}
                    </span>
                  )}
                  <span className="font-mono text-small tabular-nums" dir="ltr">
                    {megabytes(file.bytes)} MB
                  </span>
                </span>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-small">{t('Contact import')}</span>
            <span className="ms-auto font-mono text-small tabular-nums" dir="ltr">
              {limits.contactImport.rows.toLocaleString('en-US')} {t('rows')}
            </span>
          </div>
        </div>

        <p className="mt-4 max-w-prose text-caption text-muted-foreground">
          {t('These are read from the checks that do the rejecting, so what you see here is what the system enforces.')}
        </p>
      </div>
    </div>
  );
}
