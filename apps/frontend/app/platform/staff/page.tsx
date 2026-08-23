'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Plus, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Support advisors, and exactly what each of them may do.
 *
 * Before this page, `platformRole` was set by the seed script and nothing else.
 * Hiring an advisor meant an UPDATE against the production database, and
 * answering "who can see every subscriber in the system?" meant reading a table
 * by hand.
 *
 * ## The permission list is the interface
 *
 * Each permission says what it lets somebody do and, where it matters, what it
 * costs — "their customers stop being answered" rather than "suspend gateway".
 * An owner ticking boxes is deciding what a person can do to a paying
 * subscriber, and the label is the only place that decision gets explained.
 *
 * The catalogue comes from the server rather than being duplicated here, so a
 * permission added to the backend appears without anyone remembering this file.
 */

type StaffMember = {
  id: string;
  email: string;
  platformRole: 'OWNER' | 'SUPPORT';
  platformPermissions: string[];
  platformDisabledAt: string | null;
  createdAt: string;
};

type Catalogue = Record<string, { label: string; detail: string }>;

export default function PlatformStaff() {
  const router = useRouter();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [catalogue, setCatalogue] = useState<Catalogue>({});
  const [suggested, setSuggested] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [granted, setGranted] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/api/platform/staff');
      setStaff(data.staff ?? []);
      setCatalogue(data.catalogue ?? {});
      setSuggested(data.suggested ?? []);
    } catch (error: any) {
      if ([401, 403].includes(error?.response?.status)) {
        router.replace('/login');
        return;
      }
      toast.error('Could not load staff');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const openAdd = () => {
    setEmail('');
    setPassword('');
    // Offered, not applied silently: a default that is quietly correct teaches
    // nobody what they just granted.
    setGranted(suggested);
    setAddOpen(true);
  };

  const create = async () => {
    setBusy('create');
    try {
      await api.post('/api/platform/staff', { email, password, permissions: granted });
      toast.success('Advisor added');
      setAddOpen(false);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not add the advisor');
    } finally {
      setBusy(null);
    }
  };

  const togglePermission = async (member: StaffMember, permission: string) => {
    const next = member.platformPermissions.includes(permission)
      ? member.platformPermissions.filter((p) => p !== permission)
      : [...member.platformPermissions, permission];
    setBusy(member.id);
    try {
      const { data } = await api.patch(`/api/platform/staff/${member.id}`, { permissions: next });
      setStaff((prev) => prev.map((m) => (m.id === member.id ? { ...m, ...data } : m)));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not change access');
    } finally {
      setBusy(null);
    }
  };

  const toggleDisabled = async (member: StaffMember) => {
    setBusy(member.id);
    try {
      const { data } = await api.patch(`/api/platform/staff/${member.id}`, {
        disabled: !member.platformDisabledAt,
      });
      setStaff((prev) => prev.map((m) => (m.id === member.id ? { ...m, ...data } : m)));
      toast.success(member.platformDisabledAt ? 'Advisor re-enabled' : 'Advisor disabled');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not change the account');
    } finally {
      setBusy(null);
    }
  };

  const permissionKeys = Object.keys(catalogue);

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Link
        href="/platform"
        className="inline-flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
        Platform control
      </Link>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Staff</h1>
          <p className="mt-1 text-caption text-muted-foreground">
            Who can see and touch subscriber workspaces, and exactly how much.
          </p>
        </div>
        <Button onClick={openAdd} disabled={loading}>
          <UserPlus className="me-1.5 h-3.5 w-3.5" />
          Add advisor
        </Button>
      </div>

      {loading ? (
        <p className="mt-8 flex items-center gap-2 text-caption text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          {staff.map((member) => {
            const isOwner = member.platformRole === 'OWNER';
            const disabled = !!member.platformDisabledAt;
            return (
              <section
                key={member.id}
                className={cn(
                  'rounded-lg border border-border bg-card p-5',
                  disabled && 'opacity-70',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold">
                      <span className="truncate" dir="ltr">{member.email}</span>
                      {isOwner && (
                        <span className="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-micro font-semibold text-primary">
                          <ShieldCheck className="h-3 w-3" />
                          Owner
                        </span>
                      )}
                      {disabled && (
                        <span className="shrink-0 rounded-md bg-danger/10 px-2 py-0.5 text-micro font-semibold text-danger">
                          Disabled
                        </span>
                      )}
                    </p>
                    {isOwner && (
                      <p className="mt-1 text-caption text-muted-foreground">
                        Holds everything, always. Not editable here — there is no version of this
                        product where the owner can be locked out of it.
                      </p>
                    )}
                  </div>

                  {!isOwner && (
                    <Button
                      size="sm"
                      variant={disabled ? 'outline' : 'ghost'}
                      onClick={() => toggleDisabled(member)}
                      disabled={busy !== null}
                      className={cn(!disabled && 'text-danger')}
                    >
                      <UserMinus className="me-1.5 h-3.5 w-3.5" />
                      {disabled ? 'Re-enable' : 'Disable'}
                    </Button>
                  )}
                </div>

                {!isOwner && (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {permissionKeys.map((key) => {
                      const on = member.platformPermissions.includes(key);
                      return (
                        <label
                          key={key}
                          className={cn(
                            'flex cursor-pointer items-start gap-2 rounded-md border p-2.5 transition-colors',
                            on ? 'border-primary/40 bg-primary/5' : 'border-border',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                            checked={on}
                            disabled={busy !== null || disabled}
                            onChange={() => togglePermission(member, key)}
                          />
                          <span className="min-w-0">
                            <span className="block text-caption font-medium">
                              {catalogue[key]?.label ?? key}
                            </span>
                            {/*
                              The consequence, not the endpoint. An owner ticking
                              this is deciding what somebody can do to a paying
                              customer.
                            */}
                            <span className="mt-0.5 block text-micro leading-4 text-muted-foreground">
                              {catalogue[key]?.detail}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add a support advisor</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="staff-email">Email</Label>
              <Input
                id="staff-email"
                className="mt-1"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="advisor@example.com"
              />
              <p className="mt-1 text-micro text-muted-foreground">
                An address that already has a workspace account is promoted rather than duplicated.
              </p>
            </div>
            <div>
              <Label htmlFor="staff-password">Password</Label>
              <Input
                id="staff-password"
                className="mt-1"
                dir="ltr"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {/*
                Longer than a tenant user's, and said out loud: this account can
                read every subscriber in the system.
              */}
              <p className="mt-1 text-micro text-muted-foreground">
                At least 12 characters — this account can read every subscriber.
              </p>
            </div>

            <div>
              <p className="text-caption font-medium">Access</p>
              <div className="mt-2 grid max-h-64 gap-2 overflow-y-auto pe-1">
                {permissionKeys.map((key) => (
                  <label
                    key={key}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-md border p-2.5',
                      granted.includes(key) ? 'border-primary/40 bg-primary/5' : 'border-border',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                      checked={granted.includes(key)}
                      onChange={() =>
                        setGranted((prev) =>
                          prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-caption font-medium">
                        {catalogue[key]?.label ?? key}
                      </span>
                      <span className="mt-0.5 block text-micro leading-4 text-muted-foreground">
                        {catalogue[key]?.detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={busy !== null || !email.trim() || password.length < 12}>
              {busy === 'create' && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              <Plus className="me-1.5 h-3.5 w-3.5" />
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
