'use client';

import { Lock } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * What a control looks like when you are not allowed to use it.
 *
 * The pattern across settings was to render the button only for admins, so an
 * agent opening the same page saw a card with nothing in it. There is no way to
 * tell that apart from a card that is genuinely empty, or from a feature the
 * organization has not been given — three unrelated situations, one blank space.
 *
 * Showing the restriction instead answers the question the blank space raises:
 * the capability exists, it is not yours, and here is whose it is. Nothing here
 * grants anything — the server enforces the same rule regardless of what the
 * page renders, which is exactly why saying so out loud is safe.
 */

export function PermissionNotice({
  /** Dictionary key naming the action, e.g. 'إضافة عضو'. */
  action,
  /** Who may perform it. Defaults to the organisation admin. */
  who = 'مدير المؤسسة',
  className,
}: {
  action: string;
  who?: string;
  className?: string;
}) {
  const { t } = useT();

  return (
    <p
      className={cn(
        'flex items-center gap-1.5 text-micro text-muted-foreground',
        className,
      )}
    >
      <Lock className="h-3 w-3 shrink-0" aria-hidden />
      <span>
        {t(action)} — {t('متاح لـ')} {t(who)}
      </span>
    </p>
  );
}
