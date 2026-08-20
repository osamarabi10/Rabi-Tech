'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import api from '@/lib/api';

export default function CheckoutSuccessPage() {
  const params = useSearchParams();
  const externalRef = params.get('externalRef') || '';
  const [status, setStatus] = useState('pending');
  useEffect(() => {
    if (!externalRef) return;
    const load = () => api.get(`/api/billing/checkout-status/${encodeURIComponent(externalRef)}`).then((r) => setStatus(r.data.status)).catch(() => setStatus('pending'));
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [externalRef]);
  return <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground"><p className="text-lg font-semibold">Activation status: {status}</p></main>;
}

