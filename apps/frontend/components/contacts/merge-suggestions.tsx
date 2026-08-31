'use client';

import { Merge, RefreshCw } from 'lucide-react';
import type { ContactMergeSuggestion } from '@/lib/data';
import { ContactAvatar } from '@/components/contact-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/ui/operational-state';
import { useT } from '@/lib/i18n';

type MergeSuggestionsProps = {
  suggestions: ContactMergeSuggestion[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onReview: (suggestion: ContactMergeSuggestion) => void;
};

export function MergeSuggestions({ suggestions, loading, error, onRetry, onReview }: MergeSuggestionsProps) {
  const { t } = useT();

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border py-3">
        <div>
          <h2 className="text-sm font-semibold">{t('اقتراحات الدمج')}</h2>
          <p className="mt-1 text-caption text-muted-foreground">{t('جهات اتصال تحمل الاسم نفسه وقد تكون مكررة')}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('تحديث اقتراحات الدمج')}
          title={t('تحديث اقتراحات الدمج')}
          onClick={onRetry}
          disabled={loading}
        >
          <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="space-y-3 p-4" aria-label={t('جاري تحميل اقتراحات الدمج')}>
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
        ) : error ? (
          <ErrorState
            compact
            title={t('تعذّر جلب اقتراحات الدمج')}
            description={t('تعذّر جلب اقتراحات الدمج')}
            retryLabel={t('إعادة المحاولة')}
            onRetry={onRetry}
          />
        ) : suggestions.length === 0 ? (
          <EmptyState
            compact
            icon={Merge}
            title={t('لا توجد اقتراحات دمج')}
            description={t('ستظهر هنا جهات الاتصال التي تحمل الاسم نفسه')}
          />
        ) : (
          <div className="divide-y divide-border">
            {suggestions.map((suggestion) => (
              <div key={`${suggestion.primary.id}:${suggestion.secondary.id}`} className="flex min-w-0 flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <ContactAvatar phone={suggestion.primary.phone} label={suggestion.primary.name} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{suggestion.primary.name}</p>
                    <p className="truncate text-caption text-muted-foreground" dir="ltr">{suggestion.primary.phone}</p>
                  </div>
                  <Merge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{suggestion.secondary.name}</p>
                    <p className="truncate text-caption text-muted-foreground" dir="ltr">{suggestion.secondary.phone}</p>
                  </div>
                </div>
                <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => onReview(suggestion)}>
                  <Merge className="size-4" aria-hidden />
                  {t('مراجعة الدمج')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
