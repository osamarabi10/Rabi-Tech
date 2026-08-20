'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import api from '@/lib/api';

export default function VerifyEmailPage() {
  const params = useSearchParams();
  const [message, setMessage] = useState('Verifying email...');
  useEffect(() => {
    api.get(`/api/billing/verify-email?token=${encodeURIComponent(params.get('token') || '')}`)
      .then(() => setMessage('Email verified. You can sign in now. Paid gateways will activate after owner approval.'))
      .catch((error) => setMessage(error?.response?.data?.error || 'Verification failed'));
  }, [params]);
  return <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground"><p className="max-w-md text-center text-lg font-semibold">{message}</p></main>;
}

