'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

export default function AccessDeniedPage() {
  const { t } = useT();

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <section className="w-full max-w-md text-center" aria-labelledby="access-denied-title">
        <ShieldX className="mx-auto size-10 text-destructive" aria-hidden />
        <h1 id="access-denied-title" className="mt-4 text-lg font-bold">{t('ليس لديك صلاحية للوصول')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('اطلب من مدير المؤسسة منحك الصلاحية المطلوبة')}
        </p>
        <Button className="mt-5" asChild>
          <Link href="/overview">
            <ArrowLeft className="size-4 rtl:hidden" aria-hidden />
            <ArrowRight className="hidden size-4 rtl:block" aria-hidden />
            {t('العودة إلى لوحة التحكم')}
          </Link>
        </Button>
      </section>
    </div>
  );
}
