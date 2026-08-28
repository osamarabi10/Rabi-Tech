'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Download, KeyRound, Loader2, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ToggleCard } from '@/components/ui/feedback-primitives';
import { ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import {
  changeCurrentPassword,
  disableTwoFactor,
  enableTwoFactor,
  fetchCurrentProfile,
  setAgentAway,
  startTwoFactorSetup,
  updateCurrentProfile,
  type CurrentProfile,
  type TwoFactorSetup,
} from '@/lib/data';
import { useT, type Locale } from '@/lib/i18n';
import { useTheme, type Theme } from '@/lib/theme';

export default function PersonalSettingsPage() {
  const { t, setLocale } = useT();
  const { setTheme } = useTheme();
  const router = useRouter();
  const [profile, setProfile] = useState<CurrentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);
  const [twoFactorMode, setTwoFactorMode] = useState<'enable' | 'disable'>('enable');
  const [twoFactorPassword, setTwoFactorPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorSetup, setTwoFactorSetup] = useState<TwoFactorSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [twoFactorBusy, setTwoFactorBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setProfile(await fetchCurrentProfile());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const saved = await updateCurrentProfile({
        name: profile.name,
        phone: profile.phone,
        avatarUrl: profile.avatarUrl,
        locale: profile.locale,
        theme: profile.theme,
      });
      setProfile((current) => current ? { ...current, ...saved } : saved);
      const stored = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
      localStorage.setItem('rabitech_user', JSON.stringify({ ...stored, ...saved }));
      setLocale(saved.locale as Locale);
      setTheme(saved.theme as Theme);
      toast.success(t('تم حفظ الملف الشخصي'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('تعذر حفظ الملف الشخصي'));
    } finally {
      setSaving(false);
    }
  };

  const changePresence = async (away: boolean) => {
    if (!profile) return;
    const previous = profile.isAway;
    setProfile({ ...profile, isAway: away });
    try {
      await setAgentAway(away);
    } catch {
      setProfile({ ...profile, isAway: previous });
      toast.error(t('تعذر تحديث حالة التواجد'));
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 8 || newPassword !== confirmPassword) return;
    setChangingPassword(true);
    try {
      await changeCurrentPassword(currentPassword, newPassword);
      localStorage.clear();
      router.replace('/login');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('تعذر تغيير كلمة السر'));
    } finally {
      setChangingPassword(false);
    }
  };

  const resetTwoFactorDialog = () => {
    setTwoFactorPassword('');
    setTwoFactorCode('');
    setTwoFactorSetup(null);
    setRecoveryCodes([]);
    setRecoveryConfirmed(false);
    setTwoFactorBusy(false);
  };

  const openTwoFactorDialog = (enable: boolean) => {
    resetTwoFactorDialog();
    setTwoFactorMode(enable ? 'enable' : 'disable');
    setTwoFactorOpen(true);
  };

  const beginTwoFactorSetup = async () => {
    if (!twoFactorPassword) return;
    setTwoFactorBusy(true);
    try {
      setTwoFactorSetup(await startTwoFactorSetup(twoFactorPassword));
      setTwoFactorPassword('');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('تعذر بدء إعداد المصادقة الثنائية'));
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const confirmTwoFactorSetup = async () => {
    if (!twoFactorSetup || !twoFactorCode) return;
    setTwoFactorBusy(true);
    try {
      const result = await enableTwoFactor(twoFactorSetup.setupToken, twoFactorCode);
      setRecoveryCodes(result.recoveryCodes);
      setProfile((current) => current ? { ...current, twoFactorEnabled: true } : current);
      setTwoFactorCode('');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('تعذر تفعيل المصادقة الثنائية'));
    } finally {
      setTwoFactorBusy(false);
    }
  };

  const turnOffTwoFactor = async () => {
    if (!twoFactorPassword || !twoFactorCode) return;
    setTwoFactorBusy(true);
    try {
      await disableTwoFactor(twoFactorPassword, twoFactorCode);
      localStorage.clear();
      router.replace('/login');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('تعذر إيقاف المصادقة الثنائية'));
      setTwoFactorBusy(false);
    }
  };

  const finishTwoFactorSetup = () => {
    if (!recoveryConfirmed) return;
    localStorage.clear();
    router.replace('/login');
  };

  const copyRecoveryCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      toast.success(t('تم نسخ رموز الاسترداد'));
    } catch {
      toast.error(t('تعذر نسخ رموز الاسترداد'));
    }
  };

  const downloadRecoveryCodes = () => {
    const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rabitech-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="flex-1 overflow-y-auto p-5"><LayoutSkeleton label={t('جاري التحميل...')} rows={7} /></div>;
  if (loadError || !profile) return <div className="flex-1 overflow-y-auto p-5"><ErrorState title={t('تعذر تحميل الملف الشخصي')} retryLabel={t('إعادة المحاولة')} onRetry={load} /></div>;

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="border-b border-border px-5 py-4">
        <h1 className="text-base font-bold">{t('الملف الشخصي')}</h1>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-5">
        <section className="border-b border-border pb-6" aria-labelledby="profile-details-title">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <Avatar className="size-20 border border-border">
              {profile.avatarUrl && <AvatarImage src={profile.avatarUrl} alt="" />}
              <AvatarFallback className="text-xl font-bold">{profile.name.charAt(0)}</AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
              <h2 id="profile-details-title" className="sr-only">{t('بيانات الملف الشخصي')}</h2>
              <div className="space-y-1.5"><Label htmlFor="profile-name">{t('الاسم')}</Label><Input id="profile-name" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></div>
              <div className="space-y-1.5"><Label htmlFor="profile-email">{t('البريد الإلكتروني')}</Label><Input id="profile-email" value={profile.email || ''} readOnly dir="ltr" /></div>
              <div className="space-y-1.5"><Label htmlFor="profile-phone">{t('الهاتف')}</Label><Input id="profile-phone" value={profile.phone || ''} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} dir="ltr" /></div>
              <div className="space-y-1.5"><Label htmlFor="profile-avatar">{t('رابط الصورة الشخصية')}</Label><Input id="profile-avatar" value={profile.avatarUrl || ''} onChange={(event) => setProfile({ ...profile, avatarUrl: event.target.value })} dir="ltr" inputMode="url" /></div>
            </div>
          </div>
        </section>

        <section className="border-b border-border py-6" aria-labelledby="preferences-title">
          <h2 id="preferences-title" className="text-sm font-semibold">{t('تفضيلات الواجهة')}</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('اللغة')}</Label>
              <Select value={profile.locale} onValueChange={(value) => setProfile({ ...profile, locale: value as CurrentProfile['locale'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="ar">العربية</SelectItem><SelectItem value="he">עברית</SelectItem><SelectItem value="en">English</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('المظهر')}</Label>
              <div className="grid grid-cols-3 rounded-md border border-border p-0.5" role="group" aria-label={t('المظهر')}>
                {(['light', 'dark', 'system'] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={profile.theme === value} onClick={() => setProfile({ ...profile, theme: value })} className={`rounded px-2 py-1.5 text-caption ${profile.theme === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}>
                    {t(value === 'light' ? 'فاتح' : value === 'dark' ? 'داكن' : 'حسب النظام')}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4"><ToggleCard title={t('وضع الغياب')} description={t('أوقف التعيين التلقائي وأعد توزيع المحادثات المفتوحة عند غيابك')} checked={profile.isAway} onCheckedChange={changePresence} /></div>
        </section>

        <section className="border-b border-border py-6" aria-labelledby="security-title">
          <h2 id="security-title" className="text-sm font-semibold">{t('الأمان')}</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5"><Label htmlFor="current-password">{t('كلمة السر الحالية')}</Label><Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="new-password">{t('كلمة السر الجديدة')}</Label><Input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="confirm-password">{t('تأكيد كلمة السر')}</Label><Input id="confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></div>
          </div>
          {confirmPassword && newPassword !== confirmPassword && <p className="mt-2 text-caption text-destructive">{t('كلمتا السر غير متطابقتين')}</p>}
          <Button variant="outline" className="mt-4" disabled={changingPassword || !currentPassword || newPassword.length < 8 || newPassword !== confirmPassword} onClick={changePassword}>
            {changingPassword ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{t('تغيير كلمة السر')}
          </Button>
          <ToggleCard className="mt-4" title={t('المصادقة الثنائية')} description={t('استخدم رمزاً مؤقتاً من تطبيق مصادقة عند تسجيل الدخول')} checked={profile.twoFactorEnabled} onCheckedChange={openTwoFactorDialog} />
        </section>

        <div className="flex justify-end pt-5">
          <Button onClick={save} disabled={saving || profile.name.trim().length < 2}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{t('حفظ')}
          </Button>
        </div>
      </div>

      <Dialog open={twoFactorOpen} onOpenChange={(open) => {
        if (!open && recoveryCodes.length > 0) return;
        setTwoFactorOpen(open);
        if (!open) resetTwoFactorDialog();
      }}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-md"
          showClose={recoveryCodes.length === 0}
          onEscapeKeyDown={(event) => recoveryCodes.length > 0 && event.preventDefault()}
          onPointerDownOutside={(event) => recoveryCodes.length > 0 && event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {t(recoveryCodes.length > 0 ? 'احفظ رموز الاسترداد' : twoFactorMode === 'enable' ? 'تفعيل المصادقة الثنائية' : 'إيقاف المصادقة الثنائية')}
            </DialogTitle>
            <DialogDescription>
              {t(recoveryCodes.length > 0
                ? 'يظهر كل رمز مرة واحدة فقط. خزّنها في مكان آمن قبل تسجيل الدخول من جديد.'
                : twoFactorMode === 'enable'
                  ? 'اربط حسابك بتطبيق مصادقة. سنسجل خروج جميع الجلسات بعد التفعيل.'
                  : 'أدخل كلمة السر ورمزاً من تطبيق المصادقة أو رمز استرداد. سنسجل خروج جميع الجلسات.')}
            </DialogDescription>
          </DialogHeader>

          {recoveryCodes.length > 0 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y border-border py-4 font-mono text-sm" dir="ltr">
                {recoveryCodes.map((code) => <code key={code}>{code}</code>)}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={copyRecoveryCodes}><Copy className="size-4" />{t('نسخ الرموز')}</Button>
                <Button type="button" variant="outline" size="sm" onClick={downloadRecoveryCodes}><Download className="size-4" />{t('تنزيل')}</Button>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 size-4 accent-primary" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.target.checked)} />
                <span>{t('حفظت رموز الاسترداد في مكان آمن')}</span>
              </label>
              <DialogFooter><Button onClick={finishTwoFactorSetup} disabled={!recoveryConfirmed}>{t('تسجيل الخروج والمتابعة')}</Button></DialogFooter>
            </div>
          ) : twoFactorMode === 'disable' ? (
            <div className="space-y-4">
              <div className="space-y-1.5"><Label htmlFor="disable-2fa-password">{t('كلمة السر الحالية')}</Label><Input id="disable-2fa-password" type="password" autoComplete="current-password" value={twoFactorPassword} onChange={(event) => setTwoFactorPassword(event.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="disable-2fa-code">{t('رمز التحقق أو الاسترداد')}</Label><Input id="disable-2fa-code" dir="ltr" autoComplete="one-time-code" value={twoFactorCode} onChange={(event) => setTwoFactorCode(event.target.value)} /></div>
              <DialogFooter><Button variant="destructive" onClick={turnOffTwoFactor} disabled={twoFactorBusy || !twoFactorPassword || !twoFactorCode}>{twoFactorBusy && <Loader2 className="size-4 animate-spin" />}{t('إيقاف المصادقة الثنائية')}</Button></DialogFooter>
            </div>
          ) : twoFactorSetup ? (
            <div className="space-y-4">
              <div className="flex justify-center"><img src={twoFactorSetup.qrDataUrl} alt={t('رمز QR لإعداد تطبيق المصادقة')} className="size-56 border border-border bg-white p-1" /></div>
              <div className="space-y-1.5">
                <Label>{t('المفتاح اليدوي')}</Label>
                <code className="block break-all border-y border-border py-2 text-center font-mono text-sm" dir="ltr">{twoFactorSetup.secret}</code>
              </div>
              <div className="space-y-1.5"><Label htmlFor="enable-2fa-code">{t('رمز التحقق')}</Label><Input id="enable-2fa-code" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={twoFactorCode} onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, ''))} /></div>
              <DialogFooter><Button onClick={confirmTwoFactorSetup} disabled={twoFactorBusy || twoFactorCode.length !== 6}>{twoFactorBusy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}{t('تحقق وفعّل')}</Button></DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5"><Label htmlFor="setup-2fa-password">{t('كلمة السر الحالية')}</Label><Input id="setup-2fa-password" type="password" autoComplete="current-password" value={twoFactorPassword} onChange={(event) => setTwoFactorPassword(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && beginTwoFactorSetup()} /></div>
              <DialogFooter><Button onClick={beginTwoFactorSetup} disabled={twoFactorBusy || !twoFactorPassword}>{twoFactorBusy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}{t('متابعة')}</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
