'use client';

import { useMemo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { AutoRepliesCard } from '@/components/settings/auto-replies-card';
import { TeamRouting } from '@/components/settings/team-routing';
import { TeamMembers } from '@/components/settings/team-members';
import { SnippetsCard } from '@/components/settings/snippets-card';
import { SubscriptionCard } from '@/components/settings/subscription-card';
import {
  fetchSessions,
  fetchSessionQR,
  disconnectSession,
  fetchTemplates,
  fetchWorkingHours,
  saveWorkingHours,
  fetchKeywords,
  addKeyword,
  deleteKeyword,
  fetchTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  fetchCurrentUsage,
  fetchOrganizationBranding,
  fetchBrandingDomainVerification,
  saveOrganizationBranding,
  uploadBrandingAsset,
  type Session,
  type SessionQR,
  type Template,
  type WorkingHours,
  type Keyword,
  type KeywordCategory,
  type Team,
  type CurrentUsage,
  type UsageMetric,
  type OrganizationBranding,
  type BrandingDomainVerification,
} from '@/lib/data';
import { StatusBadge } from '@/components/status-badge';
import { SettingsSubNavigation } from '@/components/settings/settings-sub-navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { hexToHslTriplet, hslTripletToHex } from '@/lib/branding-colors';
import { renderTemplate } from '@/lib/utils';
import { Activity, CheckCircle2, Clock, Copy, ImageIcon, Loader2, LogOut, Palette, PowerOff, Plus, QrCode, Search, Tags, Trash2, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { PermissionNotice } from '@/components/permission-notice';

const QR_POLL_MS = 5000;

const USAGE_LABELS: Record<UsageMetric, string> = {
  messages_inbound: 'الرسائل الواردة',
  messages_outbound: 'الرسائل الصادرة',
  active_contacts: 'جهات الاتصال النشطة',
  ai_tokens_in: 'رموز الذكاء الاصطناعي الواردة',
  ai_tokens_out: 'رموز الذكاء الاصطناعي الصادرة',
  campaign_sends: 'إرسالات الحملات',
};

const KEYWORD_CATEGORY_LABELS: Record<KeywordCategory, string> = {
  CRITICAL:     'عاجل وشكاوى',
  HIGH:         'أولوية عالية',
  MEDIUM:       'أسئلة ومساعدة',
  LOW:          'أولوية منخفضة',
  LEAD_SALES:   'نية شراء',
  LEAD_INSTALL: 'طلب خدمة',
  LEAD_UPGRADE: 'ترقية أو توسعة',
  LEAD_INQUIRY: 'استفسار عام',
};

const DAY_OPTIONS = [
  { value: 0, label: 'أحد' },
  { value: 1, label: 'اثنين' },
  { value: 2, label: 'ثلاثاء' },
  { value: 3, label: 'أربعاء' },
  { value: 4, label: 'خميس' },
  { value: 5, label: 'جمعة' },
  { value: 6, label: 'سبت' },
];

/** Section anchors for the sticky settings navigation. Order matches page order. */
const SETTINGS_SECTIONS = [
  { id: 'branding',      label: 'العلامة التجارية', adminOnly: true },
  { id: 'subscription',  label: 'الاشتراك', adminOnly: false },
  { id: 'usage',         label: 'الاستخدام الشهري', adminOnly: false },
  { id: 'working-hours', label: 'أوقات الدوام', adminOnly: false },
  { id: 'team-members',  label: 'أعضاء الفريق', adminOnly: false },
  { id: 'snippets',      label: 'القوالب', adminOnly: false },
  { id: 'auto-replies',  label: 'الردود التلقائية', adminOnly: false },
  { id: 'channels',      label: 'قنوات واتساب', adminOnly: false },
  { id: 'keywords',      label: 'الكلمات المفتاحية', adminOnly: false },
  { id: 'teams',         label: 'الفرق', adminOnly: false },
  // A page of its own rather than a section here: the stage list is a small
  // CRUD surface with its own ordering controls, and it is long enough that
  // inlining it would push everything below it off the screen.
  { id: 'lifecycle',     label: 'مراحل العميل', adminOnly: true, href: '/settings/lifecycle' },
];

/**
 * Legacy top-level routes that were folded into this page. They redirect here
 * with `?tab=<name>`, which nothing read — so `/templates`, linked from the
 * composer and from Settings itself, landed at the top of the page with no
 * indication of where its content had gone.
 */
const TAB_TO_SECTION: Record<string, string> = {
  users: 'team-members',
  billing: 'subscription',
  templates: 'snippets',
  snippets: 'snippets',
};

export default function SettingsPage() {
  const { t } = useT();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [qrSession, setQrSession] = useState<Session | null>(null);
  const [qr, setQr] = useState<SessionQR | null>(null);
  const [wh, setWh] = useState<WorkingHours | null>(null);
  const [oohTemplates, setOohTemplates] = useState<Template[]>([]);
  const [welcomeTemplates, setWelcomeTemplates] = useState<Template[]>([]);
  const [savingWh, setSavingWh] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [keywordCategories, setKeywordCategories] = useState<KeywordCategory[]>([]);
  const [newKeywordCategory, setNewKeywordCategory] = useState<KeywordCategory | ''>('');
  const [newKeywordPhrase, setNewKeywordPhrase] = useState('');
  const [savingKeyword, setSavingKeyword] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamSlug, setNewTeamSlug] = useState('');
  const [savingTeam, setSavingTeam] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [usage, setUsage] = useState<CurrentUsage | null>(null);
  const [branding, setBranding] = useState<(OrganizationBranding & { customDomain?: string | null }) | null>(null);
  const [savingBranding, setSavingBranding] = useState(false);
  const [domainVerification, setDomainVerification] = useState<BrandingDomainVerification | null>(null);
  const [uploadingAsset, setUploadingAsset] = useState<'logo' | 'favicon' | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  useEffect(() => {
    try {
      const user = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
      setIsAdmin(user.role === 'ADMIN');
    } catch {
      setIsAdmin(false);
    }
  }, []);

  // Honour ?tab= from the folded-away routes. Deferred a tick so the target
  // section exists before we try to scroll to it.
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    const sectionId = tab ? TAB_TO_SECTION[tab] || tab : null;
    if (!sectionId) return;
    const timer = window.setTimeout(() => {
      document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);
    return () => window.clearTimeout(timer);
  }, []);

  const loadSessions = useCallback(() => {
    fetchSessions().then((list) => {
      setSessions(list);
      const connected = list.find((s) => s.connected);

    });
  }, []);


  const loadWorkingHours = useCallback(() => {
    fetchWorkingHours().then(setWh);
    fetchTemplates({ category: 'OUT_OF_HOURS' }).then(setOohTemplates);
    fetchTemplates({ category: 'AUTO_REPLY' }).then(setWelcomeTemplates);
  }, []);

  const loadKeywords = useCallback(() => {
    fetchKeywords()
      .then((data) => {
        setKeywords(data.keywords);
        setKeywordCategories(data.categories);
      })
      .catch(() => toast.error(t('فشل جلب الكلمات المفتاحية')));
  }, [t]);

  const handleAddKeyword = async () => {
    if (!newKeywordCategory || !newKeywordPhrase.trim()) return;
    setSavingKeyword(true);
    try {
      await addKeyword(newKeywordCategory, newKeywordPhrase.trim());
      setNewKeywordPhrase('');
      loadKeywords();
      toast.success(t('تمت إضافة الكلمة'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل إضافة الكلمة'));
    } finally {
      setSavingKeyword(false);
    }
  };

  const handleDeleteKeyword = async (id: string) => {
    try {
      await deleteKeyword(id);
      setKeywords((prev) => prev.filter((k) => k.id !== id));
    } catch {
      toast.error(t('فشل حذف الكلمة'));
    }
  };

  /**
   * Two distinct outcomes, so the admin picks the one they actually want:
   *   disconnect — stop the session; the SAME number reconnects. Reversible.
   *   unlink     — discard saved credentials so a DIFFERENT number can pair.
   *                Requires a fresh QR scan and cannot be undone from here.
   */
  const handleDisconnect = async (session: Session, unlink: boolean) => {
    const message = unlink
      ? t('فصل الرقم نهائياً؟\n\nرح ينحذف ربط واتساب الحالي وبتحتاج تمسح QR جديد لتربط رقم ثاني.\nالمحادثات القديمة بتضل محفوظة.')
      : t('إيقاف الاتصال مؤقتاً؟\n\nرح تتوقف الرسائل الواردة، بس نفس الرقم بيرجع يتصل تلقائياً.\nالمحادثات القديمة بتضل محفوظة.');
    if (!window.confirm(message)) return;

    setDisconnecting(session.sessionName);
    try {
      await disconnectSession(session.sessionName, { unlink });
      toast.success(
        unlink
          ? t('تم فصل الرقم — اضغط "ربط الجهاز" وامسح QR للرقم الجديد')
          : t('تم إيقاف الاتصال'),
      );
      loadSessions();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشلت العملية'));
    } finally {
      setDisconnecting(null);
    }
  };

  const loadTeams = useCallback(() => {
    fetchTeams()
      .then(setTeams)
      .catch(() => toast.error(t('فشل تحميل الفرق')));
  }, [t]);

  const handleAddTeam = async () => {
    if (!newTeamName.trim()) return;
    setSavingTeam(true);
    try {
      await createTeam({ name: newTeamName.trim(), slug: newTeamSlug.trim() || undefined });
      setNewTeamName('');
      setNewTeamSlug('');
      loadTeams();
      toast.success(t('تمت إضافة الفريق'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل إضافة الفريق'));
    } finally {
      setSavingTeam(false);
    }
  };

  const handleSetDefaultTeam = async (team: Team) => {
    try {
      await updateTeam(team.id, { isDefault: true });
      loadTeams();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل تحديث الفريق'));
    }
  };

  const handleDeleteTeam = async (team: Team) => {
    try {
      await deleteTeam(team.id);
      setTeams((prev) => prev.filter((item) => item.id !== team.id));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل حذف الفريق'));
    }
  };

  useEffect(() => {
    loadSessions();
    loadWorkingHours();
    loadKeywords();
    loadTeams();
    fetchCurrentUsage().then(setUsage).catch(() => setUsage(null));
    fetchOrganizationBranding().then(setBranding).catch(() => setBranding(null));
    fetchBrandingDomainVerification().then(setDomainVerification).catch(() => setDomainVerification(null));
  }, [loadSessions, loadWorkingHours, loadKeywords, loadTeams]);

  useEffect(() => {
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const openQrDialog = useCallback(
    (s: Session) => {
      setQrSession(s);
      setQr(null);
      const poll = async () => {
        try {
          const r = await fetchSessionQR(s.sessionName);
          setQr(r);
          if (r.connected) {
            stopPolling();
            loadSessions();
          }
        } catch {
          setQr({ connected: false, pending: true });
        }
      };
      poll();
      stopPolling();
      pollRef.current = setInterval(poll, QR_POLL_MS);
    },
    [loadSessions, stopPolling]
  );

  const closeQrDialog = useCallback(() => {
    stopPolling();
    setQrSession(null);
    setQr(null);
    loadSessions();
  }, [loadSessions, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const toggleDay = (day: number) => {
    if (!wh) return;
    const days = wh.workDays.includes(day)
      ? wh.workDays.filter((d) => d !== day)
      : [...wh.workDays, day].sort((a, b) => a - b);
    setWh({ ...wh, workDays: days });
  };

  const handleSaveWorkingHours = async () => {
    if (!wh) return;
    setSavingWh(true);
    try {
      const saved = await saveWorkingHours({
        enabled: wh.enabled,
        autoReplyEnabled: wh.autoReplyEnabled,
        timezone: wh.timezone,
        workDays: wh.workDays,
        startTime: wh.startTime,
        endTime: wh.endTime,
        outOfHoursTemplateId: wh.outOfHoursTemplateId,
        welcomeTemplateId: wh.welcomeTemplateId,
      });
      setWh(saved);
      toast.success(t('تم حفظ أوقات الدوام'));
    } catch {
      toast.error(t('فشل حفظ الإعدادات'));
    } finally {
      setSavingWh(false);
    }
  };

  const handleSaveBranding = async () => {
    if (!branding) return;
    setSavingBranding(true);
    try {
      const saved = await saveOrganizationBranding(branding);
      setBranding({ ...branding, ...saved });
      setDomainVerification(await fetchBrandingDomainVerification());
      toast.success(t('تم حفظ الإعدادات'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل حفظ الإعدادات'));
    } finally {
      setSavingBranding(false);
    }
  };

  const handleBrandingAssetUpload = async (kind: 'logo' | 'favicon', file?: File | null) => {
    if (!file) return;
    setUploadingAsset(kind);
    try {
      const saved = await uploadBrandingAsset(kind, file);
      setBranding((current) => (current ? { ...current, ...saved } : saved));
      toast.success(kind === 'logo' ? t('تم رفع الشعار') : t('تم رفع الأيقونة'));
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل الرفع'));
    } finally {
      setUploadingAsset(null);
    }
  };

  const selectedTemplate = oohTemplates.find((t) => t.id === wh?.outOfHoursTemplateId);
  const previewBody =
    selectedTemplate && wh
      ? renderTemplate(selectedTemplate.body, {
          startTime: wh.startTime,
          endTime: wh.endTime,
          workDays: wh.workDays
            .sort((a, b) => a - b)
            .map((d) => DAY_OPTIONS.find((o) => o.value === d)?.label)
            .filter(Boolean)
            .join(' · '),
        })
      : '';

  const visibleSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => !section.adminOnly || isAdmin),
    [isAdmin],
  );

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <h1 className="mb-3 text-base font-extrabold">{t('الإعدادات')}</h1>

      {/*
        Two columns: a persistent numbered sub-navigation beside the content,
        replacing a horizontal anchor strip that scrolled sideways on narrow
        screens and never showed which section you were in.

        The sub-nav is sticky and the sections stay stacked and anchor-linked,
        so a link to #branding still lands and the page still works without
        JavaScript. Below lg the nav returns to a horizontal scroller above the
        content — two columns on a tablet leaves neither one usable.
      */}
      <div className="lg:grid lg:grid-cols-[224px_minmax(0,1fr)] lg:gap-5">
        <SettingsSubNavigation
          sections={visibleSections}
          className="mb-4 hidden lg:sticky lg:top-0 lg:mb-0 lg:flex"
        />

        <nav className="sticky top-0 z-20 -mx-5 mb-4 border-b border-border bg-background/95 px-5 py-2 backdrop-blur lg:hidden">
          <div className="flex gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden">
            {visibleSections.map((s) => (
              <a
                key={s.id}
                href={'href' in s && s.href ? s.href : `#${s.id}`}
                className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t(s.label)}
              </a>
            ))}
          </div>
        </nav>

        <div className="min-w-0">

      {isAdmin && branding && (
        <Card id="branding" className="mb-4 scroll-mt-16">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Palette className="h-4 w-4 text-primary" />
              {t('إعدادات العلامة التجارية')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="grid gap-4 rounded-lg border border-border p-4 md:grid-cols-[1fr_220px]"
              style={
                {
                  '--primary': branding.primaryHsl,
                  '--ring': branding.primaryHsl,
                  '--brand-accent': branding.accentHsl,
                  '--brand-gradient-to': branding.accentHsl,
                } as CSSProperties
              }
            >
              <div className="min-w-0 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground">{t('معاينة مباشرة')}</p>
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary to-[hsl(var(--brand-gradient-to))] text-white">
                    {branding.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={branding.logoUrl} alt="" className="h-full w-full object-contain p-1.5" />
                    ) : (
                      <ImageIcon className="h-5 w-5" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{branding.productName || 'Product name'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {branding.customDomain || 'custom-domain.example'}
                    </p>
                  </div>
                </div>
                {/*
                  A colour preview, not a colour-coded label. The accent chip
                  used to render its own name in the accent colour, which is
                  unreadable whenever a subscriber picks anything light — it
                  measured 3.1:1 with the default. Showing the colour as a
                  filled swatch and the name in normal text is legible for
                  every possible brand colour, which colour-as-text can never
                  be, because the palette does not own that colour.
                */}
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-4 w-4 shrink-0 rounded border border-border"
                      style={{ background: 'hsl(var(--primary))' }}
                      aria-hidden
                    />
                    <span className="text-xs text-muted-foreground">{t('اللون الأساسي')}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-4 w-4 shrink-0 rounded border border-border"
                      style={{ background: 'hsl(var(--brand-accent))' }}
                      aria-hidden
                    />
                    <span className="text-xs text-muted-foreground">{t('لون التمييز')}</span>
                  </span>
                  {/* The primary still gets a real button preview, because a
                      filled button is how the colour is actually used and its
                      own foreground token guarantees the contrast. */}
                  <span className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                    {t('زر إجراء')}
                  </span>
                </div>
                {branding.footerText && (
                  <p className="text-xs text-muted-foreground">{branding.footerText}</p>
                )}
              </div>
              <div className="space-y-2 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">{t('الباقة')}: {branding.tier}</p>
                <p>
                  {branding.canCustomizeFooter
                    ? t('يمكنك تعديل التذييل في باقتك')
                    : t('باقتك الحالية تُلزم بعرض تذييل المنصة')}
                </p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('اسم المنتج')}</Label>
              <Input
                value={branding.productName}
                onChange={(event) => setBranding({ ...branding, productName: event.target.value })}
              />
              </div>
              <div className="space-y-2">
                <Label>{t('النطاق المخصص')}</Label>
              <Input
                dir="ltr"
                value={branding.customDomain || ''}
                onChange={(event) => setBranding({ ...branding, customDomain: event.target.value || null })}
              />
              </div>
              <div className="space-y-2">
                <Label>{t('اللون الأساسي')}</Label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    className="h-9 w-14 p-1"
                    value={hslTripletToHex(branding.primaryHsl)}
                    onChange={(event) => setBranding({ ...branding, primaryHsl: hexToHslTriplet(event.target.value) })}
                  />
                  <Input
                    dir="ltr"
                    value={branding.primaryHsl}
                    onChange={(event) => setBranding({ ...branding, primaryHsl: event.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('اللون الثانوي')}</Label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    className="h-9 w-14 p-1"
                    value={hslTripletToHex(branding.accentHsl)}
                    onChange={(event) => setBranding({ ...branding, accentHsl: hexToHslTriplet(event.target.value) })}
                  />
                  <Input
                    dir="ltr"
                    value={branding.accentHsl}
                    onChange={(event) => setBranding({ ...branding, accentHsl: event.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t('رفع الشعار')}</Label>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  disabled={uploadingAsset !== null}
                  onChange={(event) => handleBrandingAssetUpload('logo', event.target.files?.[0])}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('رفع أيقونة المتصفح')}</Label>
                <Input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  disabled={uploadingAsset !== null}
                  onChange={(event) => handleBrandingAssetUpload('favicon', event.target.files?.[0])}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('اللغة الافتراضية')}</Label>
              <Select
                value={branding.defaultLocale}
                onValueChange={(value) =>
                  setBranding({ ...branding, defaultLocale: value as OrganizationBranding['defaultLocale'] })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">Arabic</SelectItem>
                  <SelectItem value="he">Hebrew</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('الاتجاه')}</Label>
              <Select
                value={branding.direction}
                onValueChange={(value) =>
                  setBranding({ ...branding, direction: value as OrganizationBranding['direction'] })
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rtl">RTL</SelectItem>
                  <SelectItem value="ltr">LTR</SelectItem>
                </SelectContent>
              </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>{t('التذييل المخصص')}</Label>
                <Input
                  value={branding.customFooter || ''}
                  disabled={!branding.canCustomizeFooter}
                  onChange={(event) => setBranding({ ...branding, customFooter: event.target.value || null })}
                />
                {!branding.canCustomizeFooter && (
                  <p className="text-xs text-muted-foreground">
                    FREE and GROWTH keep the required Powered by RabiTech attribution. BUSINESS and ENTERPRISE can replace or remove it.
                  </p>
                )}
              </div>
            </div>

            {branding.customDomain && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-xs font-semibold">{t('توثيق النطاق')}</p>
                <p className="font-mono text-xs" dir="ltr">
                  {domainVerification?.record || branding.customDomainVerificationRecord || t('احفظ النطاق لتوليد سجل TXT')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('الحالة')}: {domainVerification?.verified || branding.customDomainVerified ? t('موثّق') : t('بانتظار DNS')}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSaveBranding} disabled={savingBranding}>
                {savingBranding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Palette className="h-4 w-4" />}
                {savingBranding ? t('جاري الحفظ...') : t('حفظ العلامة التجارية')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div id="subscription" className="mb-4 scroll-mt-16">
        <SubscriptionCard />
      </div>

      <Card id="usage" className="mb-4 scroll-mt-16">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-primary" />
            {t('الاستخدام الشهري')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {usage ? (
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
              {usage.items.map((item) => {
                const current = Number(item.current).toLocaleString();
                const limit = item.limit === null ? t('غير محدود') : Number(item.limit).toLocaleString();
                const color = item.state === 'exceeded'
                  ? 'bg-danger'
                  : item.state === 'warning'
                    ? 'bg-warning'
                    : 'bg-success';
                return (
                  <div key={item.metric} className="min-w-0 space-y-2 border-b border-border pb-3 last:border-0 sm:[&:nth-last-child(-n+2)]:border-0 xl:[&:nth-last-child(-n+3)]:border-0">
                    <div className="flex items-start justify-between gap-3 text-xs">
                      <span className="font-medium">{t(USAGE_LABELS[item.metric])}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground" dir="ltr">
                        {current} / {limit}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-sm bg-muted" role="meter" aria-valuenow={item.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                      <div className={cn('h-full transition-[width]', color)} style={{ width: `${item.percent ?? 0}%` }} />
                    </div>
                    {item.state === 'warning' && <p className="text-caption text-warning">{t('قريب من الحد الشهري')}</p>}
                    {item.state === 'exceeded' && <p className="text-caption font-medium text-danger">{t('وصلت للحد الشهري')}</p>}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-20 items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="working-hours" className="mb-4 scroll-mt-16">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Clock className="h-4 w-4 text-primary" />
            {t('أوقات الدوام والرد التلقائي')}
          </CardTitle>
          {wh && (
            <StatusBadge
              label={wh.isOpenNow ? t('مفتوح الآن') : t('مغلق الآن')}
              color={wh.isOpenNow ? 'hsl(var(--status-resolved))' : 'hsl(var(--status-pending))'}
            />
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {wh ? (
            <>
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">{t('الرد التلقائي')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('تشغيل أو إيقاف جميع الردود التلقائية على الرسائل الواردة')}
                  </p>
                </div>
                <Button
                  variant={wh.autoReplyEnabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setWh({ ...wh, autoReplyEnabled: !wh.autoReplyEnabled })}
                >
                  {wh.autoReplyEnabled ? t('مفعّل') : t('موقوف')}
                </Button>
              </div>

              <div className="space-y-2">
                <Label>{t('رسالة الترحيب (للعملاء الجدد)')}</Label>
                <Select
                  value={wh.welcomeTemplateId ?? '__default__'}
                  onValueChange={(v) => setWh({ ...wh, welcomeTemplateId: v === '__default__' ? null : v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">{t('الافتراضية — قائمة الأقسام')}</SelectItem>
                    {welcomeTemplates.map((tmpl) => (
                      <SelectItem key={tmpl.id} value={tmpl.id}>
                        {tmpl.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {wh.welcomeTemplate && (
                  <Textarea
                    readOnly
                    className="min-h-20 bg-muted/50 text-xs leading-relaxed"
                    value={wh.welcomeTemplate.body}
                  />
                )}
                <p className="text-caption text-muted-foreground">
                  أنشئ قالباً من فئة <strong>AUTO_REPLY</strong> في{' '}
                  <a href="/templates" className="text-primary underline">
                    {t('القوالب')}
                  </a>{' '}
                  ثم اختره هنا
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">{t('تفعيل أوقات الدوام')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('خارج الدوام يُرسل قالب تلقائي للعميل')}
                  </p>
                </div>
                <Button
                  variant={wh.enabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setWh({ ...wh, enabled: !wh.enabled })}
                >
                  {wh.enabled ? t('مفعّل') : t('معطّل')}
                </Button>
              </div>

              <div className="space-y-2">
                <Label>{t('أيام العمل')}</Label>
                <div className="flex flex-wrap gap-2">
                  {DAY_OPTIONS.map((d) => (
                    <Button
                      key={d.value}
                      type="button"
                      size="sm"
                      variant={wh.workDays.includes(d.value) ? 'default' : 'outline'}
                      className="h-8 min-w-[52px]"
                      onClick={() => toggleDay(d.value)}
                    >
                      {t(d.label)}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>{t('بداية الدوام')}</Label>
                  <Input
                    type="time"
                    value={wh.startTime}
                    onChange={(e) => setWh({ ...wh, startTime: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('نهاية الدوام')}</Label>
                  <Input
                    type="time"
                    value={wh.endTime}
                    onChange={(e) => setWh({ ...wh, endTime: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('قالب خارج الدوام')}</Label>
                <Select
                  value={wh.outOfHoursTemplateId || ''}
                  onValueChange={(v) => setWh({ ...wh, outOfHoursTemplateId: v || null })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('اختر قالباً...')} />
                  </SelectTrigger>
                  <SelectContent>
                    {oohTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-caption text-muted-foreground">
                  عدّل النص من صفحة{' '}
                  <a href="/templates" className="text-primary underline">
                    {t('القوالب')}
                  </a>{' '}
                  — استخدم {'{{startTime}}'} · {'{{endTime}}'} · {'{{workDays}}'}
                </p>
              </div>

              {previewBody && (
                <div className="space-y-2">
                  <Label>{t('معاينة الرسالة')}</Label>
                  <Textarea
                    readOnly
                    className="min-h-28 bg-muted/50 text-xs leading-relaxed"
                    value={previewBody}
                  />
                </div>
              )}

              <Button onClick={handleSaveWorkingHours} disabled={savingWh || wh.workDays.length === 0}>
                {savingWh ? t('جاري الحفظ...') : t('حفظ أوقات الدوام')}
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('جاري التحميل...')}</p>
          )}
        </CardContent>
      </Card>

      <Card id="channels" className="mb-4 scroll-mt-16">
        <CardHeader>
          <CardTitle className="text-sm">{t('جلسات واتساب')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0 p-0 px-6 pb-4">
          {sessions.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">{t('لا توجد جلسات')}</p>
          )}
          {sessions.map((s, i) => (
            <div key={s.sessionName}>
              <div className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm">{s.label}</p>
                  <p className="text-xs text-muted-foreground">{s.sessionName}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!s.connected && isAdmin && (
                    <Button size="sm" variant="outline" onClick={() => openQrDialog(s)}>
                      <QrCode className="me-1.5 h-4 w-4" />
                      {t('ربط الجهاز')}
                    </Button>
                  )}
                  {isAdmin && (
                    <>
                      {s.connected && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={disconnecting === s.sessionName}
                          onClick={() => handleDisconnect(s, false)}
                          title={t('نفس الرقم بيرجع يتصل تلقائياً')}
                        >
                          {disconnecting === s.sessionName ? (
                            <Loader2 className="me-1.5 h-4 w-4 animate-spin" />
                          ) : (
                            <PowerOff className="me-1.5 h-4 w-4" />
                          )}
                          {t('إيقاف مؤقت')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={disconnecting === s.sessionName}
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => handleDisconnect(s, true)}
                        title={t('احذف الربط لتقدر تربط رقم ثاني')}
                      >
                        <LogOut className="me-1.5 h-4 w-4" />
                        {t('فصل الرقم')}
                      </Button>
                    </>
                  )}
                  {!isAdmin && <PermissionNotice action="إدارة القناة" />}
                  <StatusBadge
                    label={s.connected ? t('متصل') : t('غير متصل')}
                    color={s.connected ? 'hsl(var(--success))' : 'hsl(var(--danger))'}
                  />
                </div>
              </div>
              {i < sessions.length - 1 && <Separator />}
            </div>
          ))}
        </CardContent>
      </Card>


      <div id="team-members" className="mb-4 scroll-mt-16">
        <TeamMembers isAdmin={isAdmin} teams={teams} />
      </div>

      <div id="snippets" className="mb-4 scroll-mt-16">
        <SnippetsCard isAdmin={isAdmin} teams={teams} />
      </div>

      <div id="auto-replies" className="mb-4 scroll-mt-16">
        <AutoRepliesCard isAdmin={isAdmin} />
      </div>

      <Card id="keywords" className="mb-4 scroll-mt-16">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Tags className="h-4 w-4 text-primary" />
            {t('الكلمات المفتاحية')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={newKeywordCategory}
              onValueChange={(v) => setNewKeywordCategory(v as KeywordCategory)}
            >
              <SelectTrigger className="sm:w-56">
                <SelectValue placeholder={t('اختر الفئة')} />
              </SelectTrigger>
              <SelectContent>
                {keywordCategories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {KEYWORD_CATEGORY_LABELS[c] || c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={newKeywordPhrase}
              onChange={(e) => setNewKeywordPhrase(e.target.value)}
              placeholder={t('اكتب كلمة أو عبارة...')}
              onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword()}
            />
            <Button
              onClick={handleAddKeyword}
              disabled={savingKeyword || !newKeywordCategory || !newKeywordPhrase.trim()}
            >
              <Plus className="h-4 w-4" />
              {t('إضافة')}
            </Button>
          </div>

          {keywords.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('لا توجد كلمات مفتاحية مخصصة')}</p>
          ) : (
            <div className="space-y-3">
              {keywordCategories
                .filter((c) => keywords.some((k) => k.category === c))
                .map((c) => (
                  <div key={c}>
                    <p className="mb-1.5 text-xs font-bold text-muted-foreground">
                      {KEYWORD_CATEGORY_LABELS[c] || c}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {keywords
                        .filter((k) => k.category === c)
                        .map((k) => (
                          <span
                            key={k.id}
                            className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 ps-3 pe-1.5 text-xs"
                          >
                            {k.phrase}
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5"
                              onClick={() => handleDeleteKeyword(k.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </span>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="teams" className="mb-4 scroll-mt-16">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Users className="h-4 w-4 text-primary" />
            {t('الفرق')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isAdmin && <PermissionNotice action="إدارة الفرق" />}
          {isAdmin && (
            <div className="grid gap-2 sm:grid-cols-[1fr_180px_auto]">
              <Input
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                placeholder={t('اسم الفريق')}
              />
              <Input
                value={newTeamSlug}
                onChange={(e) => setNewTeamSlug(e.target.value)}
                placeholder="slug"
                dir="ltr"
              />
              <Button onClick={handleAddTeam} disabled={savingTeam || !newTeamName.trim()}>
                <Plus className="h-4 w-4" />
                {t('إضافة')}
              </Button>
            </div>
          )}

          <div className="grid gap-2 md:grid-cols-2">
            {teams.map((team) => (
              <div
                key={team.id}
                className="rounded-md border border-border bg-muted/20 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: team.color }} />
                    <p className="truncate text-sm font-semibold">{team.name}</p>
                    {team.isDefault && <StatusBadge label={t('افتراضي')} color="hsl(var(--success))" className="text-micro" />}
                  </div>
                  <p className="mt-1 truncate font-mono text-micro text-muted-foreground" dir="ltr">
                    {team.slug}
                  </p>
                  <p className="mt-1 text-caption text-muted-foreground">
                    {(team._count?.members || 0)} {t('أعضاء')} · {(team._count?.conversations || 0)} {t('محادثات')}
                  </p>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 items-center gap-1">
                    {!team.isDefault && (
                      <Button size="sm" variant="ghost" onClick={() => handleSetDefaultTeam(team)}>
                        {t('افتراضي')}
                      </Button>
                    )}
                    {!team.isDefault && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => handleDeleteTeam(team)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
                </div>
                {isAdmin && <TeamRouting team={team} onSaved={loadTeams} />}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

        </div>
      </div>

      {/* Portalled, so it sits outside the settings grid rather than inside a
          column that would constrain it. */}
      <Dialog open={!!qrSession} onOpenChange={(open) => !open && closeQrDialog()}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">ربط واتساب — {qrSession?.label}</DialogTitle>
            <DialogDescription className="text-xs">
              من هاتفك: واتساب ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-[280px] items-center justify-center">
            {qr?.connected ? (
              <div className="flex flex-col items-center gap-3 text-success">
                <CheckCircle2 className="h-12 w-12" />
                <p className="text-sm font-bold">{t('تم الربط بنجاح!')}</p>
              </div>
            ) : qr?.qrCode ? (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qr.qrCode}
                  alt="WhatsApp QR"
                  className="h-64 w-64 rounded-lg bg-white p-2"
                />
                <p className="text-xs text-muted-foreground">
                  يتجدد الرمز تلقائياً كل {QR_POLL_MS / 1000} ثانية
                </p>
              </div>
            ) : qr?.reconnecting ? (
              /*
                The gateway still holds this phone's saved credentials, so it is
                reconnecting the same number and will never show a QR. Saying so
                beats spinning forever — and tells the admin the one thing that
                actually unblocks them.
              */
              <div className="flex flex-col items-center gap-3 text-center">
                <Loader2 className="h-7 w-7 animate-spin text-warning" />
                <p className="text-sm font-medium">{t('جارٍ إعادة الاتصال بنفس الرقم…')}</p>
                <p className="max-w-[280px] text-xs text-muted-foreground">
                  {t('واتساب لسا محتفظ بربط هذا الجهاز. إذا بدك تربط رقم ثاني، افتح واتساب على الجوال ← الأجهزة المرتبطة ← احذف هذا الجهاز، وبعدها ارجع اضغط "ربط الجهاز".')}
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p className="text-xs">{t('جارٍ تجهيز رمز الربط…')}</p>
                {qr?.state && (
                  <p className="font-mono text-micro opacity-50">{qr.state}</p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
