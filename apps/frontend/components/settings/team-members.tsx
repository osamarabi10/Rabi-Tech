'use client';

import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Users, Trash2, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchSystemUsers,
  createSystemUser,
  deleteSystemUser,
  fetchSeatUsage,
  type SystemUser,
  type SeatUsage,
  type Team,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const ROLES = [
  { value: 'SUPERVISOR', label: 'مشرف' },
  { value: 'AGENT',      label: 'وكيل' },
  { value: 'VIEWER',     label: 'مشاهد' },
  { value: 'FINANCE',    label: 'محاسبة' },
];

const EMPTY = { name: '', email: '', password: '', role: 'AGENT', primaryTeamId: '' };

export function TeamMembers({ isAdmin, teams }: { isAdmin: boolean; teams: Team[] }) {
  const { t } = useT();
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [seats, setSeats] = useState<SeatUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([
        fetchSystemUsers(),
        fetchSeatUsage().catch(() => null),
      ]);
      setUsers(u);
      setSeats(s);
    } catch {
      // Settings has many cards; one failing shouldn't spam the whole page.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      toast.error(t('الاسم والبريد وكلمة المرور مطلوبة'));
      return;
    }
    setSaving(true);
    try {
      await createSystemUser({
        name: form.name,
        email: form.email,
        password: form.password,
        role: form.role,
        primaryTeamId: form.primaryTeamId || null,
      });
      toast.success(t('تمت إضافة المستخدم'));
      setForm(EMPTY);
      setOpen(false);
      load();
    } catch (err: any) {
      const data = err?.response?.data;
      // A refused seat is a plan decision, not a failure — say so plainly.
      toast.error(data?.error || t('فشل إضافة المستخدم'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (user: SystemUser) => {
    try {
      await deleteSystemUser(user.id);
      toast.success(t('تم حذف المستخدم'));
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل حذف المستخدم'));
    }
  };

  const pct = seats?.limit ? Math.min(100, (seats.used / seats.limit) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-primary" />
            {t('أعضاء الفريق')}
          </CardTitle>
          {isAdmin && (
            <Button size="sm" onClick={() => setOpen(true)} disabled={seats?.atLimit}>
              <UserPlus className="h-3.5 w-3.5" />
              {t('إضافة عضو')}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Seat meter — the ceiling is visible before it is hit, not after. */}
        {seats && (
          <div className={cn(
            'rounded-md border px-3 py-2',
            seats.atLimit ? 'border-warning/40 bg-warning/15' : 'border-border bg-muted/30',
          )}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                {t('المقاعد')} · {t('باقة')} {seats.planName}
              </span>
              {/* The count is data and stays high-contrast; the warning hue lives
                  in the icon and message below, where it isn't load-bearing. */}
              <span className="font-mono font-semibold text-foreground">
                {seats.used} / {seats.limit ?? '∞'}
              </span>
            </div>
            {seats.limit !== null && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
                <div
                  className={cn('h-full rounded-full transition-all', seats.atLimit ? 'bg-warning' : 'bg-primary')}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
            {seats.atLimit && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-warning">
                <ShieldAlert className="h-3 w-3 shrink-0" />
                {t('وصلت للحد الأقصى — رقّي الباقة لإضافة أعضاء')}
              </p>
            )}
          </div>
        )}

        {loading && (
          <p className="py-4 text-center text-xs text-muted-foreground">{t('جاري التحميل...')}</p>
        )}

        {!loading && users.map((u) => (
          <div key={u.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
              {u.name?.charAt(0) || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{u.name}</p>
              <p className="truncate text-[10px] text-muted-foreground" dir="ltr">{u.email}</p>
            </div>
            {u.primaryTeam && (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
                style={{ backgroundColor: `${u.primaryTeam.color}1A`, color: u.primaryTeam.color, borderColor: `${u.primaryTeam.color}40` }}
              >
                {u.primaryTeam.name}
              </span>
            )}
            <span className="shrink-0 text-[10px] text-muted-foreground">{u.role}</span>
            {isAdmin && u.role !== 'ADMIN' && (
              <button
                onClick={() => remove(u)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                aria-label={t('حذف')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('إضافة عضو')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('الاسم')}</Label>
              <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('البريد الإلكتروني')}</Label>
              <Input type="email" dir="ltr" value={form.email}
                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('كلمة المرور')}</Label>
              <Input type="password" dir="ltr" value={form.password}
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('الدور')}</Label>
                <Select value={form.role} onValueChange={(v) => setForm((p) => ({ ...p, role: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{t(r.label)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('الفريق')}</Label>
                <Select value={form.primaryTeamId || 'none'}
                  onValueChange={(v) => setForm((p) => ({ ...p, primaryTeamId: v === 'none' ? '' : v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('بدون')}</SelectItem>
                    {teams.map((tm) => (
                      <SelectItem key={tm.id} value={tm.id}>{tm.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('إلغاء')}</Button>
            <Button onClick={create} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('إضافة')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
