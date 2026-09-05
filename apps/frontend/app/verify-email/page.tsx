'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import api from '@/lib/api';

export default function VerifyEmailPage() {
  const params = useSearchParams();
  const [message, setMessage] = useState('Verifying email...');
  useEffect(() => {
    api.get(`/api/billing/verify-email?token=${encodeURIComponent(params.get('token') || '')}`)
      /*
        The old copy promised the gateway would activate "after owner
        approval". Manual activation was removed in b8755d82, and provisioning
        no longer waits on verification at all (docs/DECISIONS.md D-8) — a paid
        gateway is queued at signup. The sentence described a step that no
        longer exists, on the one screen a customer reaches by acting on an
        instruction we gave them.
      */
      .then(() => setMessage('Email verified. You can sign in now.'))
      .catch((error) => setMessage(error?.response?.data?.error || 'Verification failed'));
  }, [params]);
  return <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground"><p className="max-w-md text-center text-lg font-semibold">{message}</p></main>;
}

