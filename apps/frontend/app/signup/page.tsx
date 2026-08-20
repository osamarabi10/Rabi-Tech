'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { MailCheck } from 'lucide-react';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function SignupPage() {
  const params = useSearchParams();
  const [form, setForm] = useState({
    organizationName: '',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
    planCode: params.get('plan') || 'FREE',
  });
  const [result, setResult] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      const { data } = await api.post('/api/billing/signup', form);
      setResult(data);
    } finally {
      setSaving(false);
    }
  };
  return (
    <main className="min-h-screen bg-background px-6 py-12 text-foreground">
      <section className="mx-auto max-w-xl">
        <h1 className="text-3xl font-bold">Create your RabiTech workspace</h1>
        {!result ? (
          <div className="mt-6 space-y-4 rounded-md border border-border bg-card p-5">
            <div className="space-y-1.5"><Label>Organization</Label><Input value={form.organizationName} onChange={(e) => setForm({ ...form, organizationName: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Your name</Label><Input value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Email</Label><Input dir="ltr" type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>Password</Label><Input dir="ltr" type="password" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} /></div>
            {/*
              The plan comes from the pricing page. It used to be a free-text
              field, which let anyone type a plan code that does not exist —
              show the choice instead, and send them back to pricing to change it.
            */}
            <div className="space-y-1.5">
              <Label>Plan</Label>
              <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2">
                <span className="font-mono text-sm font-semibold" dir="ltr">{form.planCode}</span>
                <Link href="/pricing" className="text-xs text-primary underline">Change plan</Link>
              </div>
            </div>
            <Button className="w-full" disabled={saving} onClick={submit}>{saving ? 'Creating...' : 'Create workspace'}</Button>
          </div>
        ) : (
          <div className="mt-6 rounded-md border border-border bg-card p-5">
            <MailCheck className="h-8 w-8 text-primary" />
            <h2 className="mt-4 text-xl font-bold">Verify your email</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Email verification is required before any WhatsApp gateway can be provisioned. Free workspaces do not auto-provision a gateway.
            </p>
            <div className="mt-4 space-y-2">
              <Button asChild variant="outline" className="w-full"><a href={result.verificationUrl}>Open verification link</a></Button>
              {result.checkoutUrl && <Button asChild className="w-full"><a href={result.checkoutUrl}>Continue activation</a></Button>}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

