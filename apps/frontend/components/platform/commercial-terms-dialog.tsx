'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * Commercial terms for one subscriber — the owner's lever for enterprise deals.
 *
 * Platform console, so **English only and no `t()` calls**: this screen has one
 * user. The single Arabic string is the `عرض خاص` badge, kept verbatim because
 * it is the same badge the tenant sees and should be recognisable across both.
 *
 * Every row shows *plan default → effective* so the owner can see what they are
 * changing from. Without that the dialog is a set of empty boxes and the only
 * way to know the current allowance is to go and look it up.
 */

type CommercialOrg = {
  id: string;
  name: string;
  tier: string;
  planOverride: string | null;
  macQuotaOverride: number | null;
  discountPercent: number | null;
  creditCents: number;
  overrideReason: string | null;
  overrideExpiresAt: string | null;
  overrideSetBy: string | null;
  /** Resolved server-side; null when that identity no longer exists. */
  overrideSetByEmail: string | null;
  overrideSetAt: string | null;
};

type Effective = {
  plan: string;
  planName: string;
  planOfRecord: string;
  source: 'override' | 'subscription' | 'tier';
  limits: Record<string, number | null>;
  seatLimit: number | null;
  isOverridden: boolean;
  override: { expired: boolean; expiresAt: string | null; creditCents: number };
  listPriceCents: number;
  effectivePriceCents: number;
};

const PLANS = ['FREE', 'GROWTH', 'BUSINESS', 'ENTERPRISE'];

/** `null` renders as "Unlimited", never as 1,000,000,000. */
function showLimit(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Unlimited';
  return value.toLocaleString('en-US');
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** ISO timestamp → the `yyyy-MM-dd` a date input needs. */
function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

export function CommercialTermsDialog({
  subscriberId,
  subscriberName,
  onClose,
  onSaved,
}: {
  subscriberId: string | null;
  subscriberName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [org, setOrg] = useState<CommercialOrg | null>(null);

  const [planOverride, setPlanOverride] = useState('');
  const [macQuota, setMacQuota] = useState('');
  const [discount, setDiscount] = useState('');
  // Held in whole dollars. An owner typing "50" into a field labelled "cents"
  // meaning $50 is a 100x error waiting to happen, so the conversion lives at
  // the edge and the label says what the number means.
  const [creditDollars, setCreditDollars] = useState('');
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const load = useCallback(async () => {
    if (!subscriberId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/api/platform/subscribers/${subscriberId}/commercials`);
      setOrg(data.organization);
      setEffective(data.effective);
      setPlanOverride(data.organization.planOverride ?? '');
      setMacQuota(data.organization.macQuotaOverride?.toString() ?? '');
      setDiscount(data.organization.discountPercent?.toString() ?? '');
      setCreditDollars(data.organization.creditCents ? (data.organization.creditCents / 100).toString() : '');
      setReason(data.organization.overrideReason ?? '');
      setExpiresAt(toDateInput(data.organization.overrideExpiresAt));
    } catch {
      toast.error('Could not load commercial terms');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [subscriberId, onClose]);

  useEffect(() => { void load(); }, [load]);

  const wantsOverride = Boolean(planOverride || macQuota || discount || expiresAt);
  const canSave = !saving && (!wantsOverride || reason.trim().length > 0);

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.patch(`/api/platform/subscribers/${subscriberId}/commercials`, {
        planOverride: planOverride || null,
        macQuotaOverride: macQuota === '' ? null : Number(macQuota),
        discountPercent: discount === '' ? null : Number(discount),
        creditCents: creditDollars === '' ? 0 : Math.round(Number(creditDollars) * 100),
        overrideReason: reason.trim() || null,
        // A date input gives a bare day; send end-of-day UTC so an override set
        // to expire "on the 30th" lasts through the 30th rather than dying at
        // midnight as it begins.
        overrideExpiresAt: expiresAt ? `${expiresAt}T23:59:59.999Z` : null,
      });
      setEffective(data.effective);
      setOrg(data.organization);
      toast.success('Commercial terms updated');
      onSaved();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || 'Could not save commercial terms');
    } finally {
      setSaving(false);
    }
  };

  const clearAll = () => {
    setPlanOverride(''); setMacQuota(''); setDiscount(''); setExpiresAt('');
    setReason(reason || 'Cleared commercial override');
  };

  return (
    <Dialog open={Boolean(subscriberId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Commercial terms — {subscriberName}
            {effective?.isOverridden && (
              <Badge variant="secondary" className="text-[10px]">عرض خاص</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading || !effective ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Current state. Without this the owner is editing blind. */}
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              <div className="grid grid-cols-2 gap-y-1">
                <span className="text-muted-foreground">Plan of record</span>
                <span className="font-medium">{effective.planOfRecord}</span>
                <span className="text-muted-foreground">Effective plan</span>
                <span className="font-medium">
                  {effective.plan}
                  <span className="ms-1 text-muted-foreground">(from {effective.source})</span>
                </span>
                <span className="text-muted-foreground">MAC quota</span>
                <span className="font-medium">{showLimit(effective.limits.active_contacts)}</span>
                <span className="text-muted-foreground">Seats</span>
                <span className="font-medium">{showLimit(effective.seatLimit)}</span>
                <span className="text-muted-foreground">Price</span>
                <span className="font-medium">
                  {effective.effectivePriceCents !== effective.listPriceCents && (
                    <span className="me-1 text-muted-foreground line-through">
                      {money(effective.listPriceCents)}
                    </span>
                  )}
                  {money(effective.effectivePriceCents)}/mo
                </span>
                {effective.override.creditCents > 0 && (
                  <>
                    <span className="text-muted-foreground">Credit</span>
                    <span className="font-medium">{money(effective.override.creditCents)}</span>
                  </>
                )}
              </div>
              {effective.override.expired && (
                <p className="mt-2 text-[11px] text-amber-600">
                  An override is recorded but expired on{' '}
                  {effective.override.expiresAt?.slice(0, 10)} — it is no longer applied.
                  The values are kept so the deal stays on record.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Plan override</Label>
                <select
                  value={planOverride}
                  onChange={(event) => setPlanOverride(event.target.value)}
                  className="select-field w-full"
                >
                  <option value="">None — use plan of record</option>
                  {PLANS.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">MAC quota</Label>
                <Input
                  type="number"
                  min={0}
                  value={macQuota}
                  onChange={(event) => setMacQuota(event.target.value)}
                  placeholder={`Plan default (${showLimit(effective.limits.active_contacts)})`}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Discount %</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={discount}
                  onChange={(event) => setDiscount(event.target.value)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Credit ($)</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={creditDollars}
                  onChange={(event) => setCreditDollars(event.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">
                Expiry <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                One expiry governs plan, MAC and discount together. Credit never expires.
              </p>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">
                Reason {wantsOverride && <span className="text-destructive">*</span>}
              </Label>
              <Textarea
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why these terms differ from the published plan"
              />
              <p className="text-[11px] text-muted-foreground">
                Recorded in the platform audit log. Never shown to the subscriber.
              </p>
            </div>

            {org?.overrideSetAt && (
              <p className="text-[11px] text-muted-foreground">
                Last changed {new Date(org.overrideSetAt).toLocaleString('en-GB')}
                {org.overrideSetByEmail ? ` by ${org.overrideSetByEmail}` : ''}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={clearAll} disabled={saving || loading}>
            Clear overrides
          </Button>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!canSave || loading}>
            {saving && <Loader2 className="me-1 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
