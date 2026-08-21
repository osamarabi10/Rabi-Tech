'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Papa from 'papaparse';
import { ArrowLeft, CheckCircle2, FileUp, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchCustomFieldDefinitions,
  importContacts,
  type CustomFieldDefinition,
  type ImportRow,
  type ImportSummary,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { displayE164, previewPhone, PHONE_REASON_LABELS } from '@/lib/phone-preview';

/**
 * Bulk contact import.
 *
 * Three steps, in this order for a reason: a user must see what their file
 * actually contains *before* they are asked to affirm that everyone in it
 * consented. Asking for the affirmation first would make it a reflex.
 *
 * The preview validation is a courtesy — the server re-validates every row and
 * refuses the whole import without the affirmation.
 */

/** Standard destinations. Anything else maps to a tenant custom field. */
const STANDARD_FIELDS = ['phone', 'name', 'email', 'lifecycleStage'] as const;
type StandardField = (typeof STANDARD_FIELDS)[number];

const PREVIEW_ROWS = 8;

/** Guess the destination from a header name, so a tidy file needs no mapping. */
function guessField(header: string): string {
  const value = header.trim().toLowerCase();
  if (/(phone|mobile|whatsapp|tel|رقم|هاتف|جوال)/.test(value)) return 'phone';
  if (/(mail|بريد|ايميل|إيميل)/.test(value)) return 'email';
  if (/(name|اسم)/.test(value)) return 'name';
  if (/(stage|lifecycle|مرحلة)/.test(value)) return 'lifecycleStage';
  return '';
}

export default function ContactImportPage() {
  const { t } = useT();
  const fileInput = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [countryCode, setCountryCode] = useState('');
  const [tag, setTag] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [fields, setFields] = useState<CustomFieldDefinition[]>([]);

  useEffect(() => {
    fetchCustomFieldDefinitions().then(setFields).catch(() => setFields([]));
  }, []);

  const parse = useCallback((file: File) => {
    setSummary(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (result) => {
        const parsedHeaders = (result.meta.fields || []).filter(Boolean);
        setFileName(file.name);
        setHeaders(parsedHeaders);
        setRows(result.data as Record<string, string>[]);
        setMapping(Object.fromEntries(parsedHeaders.map((header) => [header, guessField(header)])));
        // Re-affirming is required for each file: a checkbox ticked for one list
        // says nothing about the next one.
        setConsent(false);
      },
      error: () => toast.error(t('تعذّر قراءة الملف')),
    });
  }, [t]);

  const phoneHeader = useMemo(
    () => Object.keys(mapping).find((header) => mapping[header] === 'phone') || '',
    [mapping],
  );

  /** Every row's validity, computed once and reused by the preview and the tally. */
  const validated = useMemo(() => rows.map((row) => {
    if (!phoneHeader) return { ok: false as const, reason: 'no_phone_column' as const };
    return previewPhone(row[phoneHeader], countryCode);
  }), [rows, phoneHeader, countryCode]);

  const validCount = validated.filter((entry) => entry.ok).length;
  const invalidCount = validated.length - validCount;

  const buildRows = (): ImportRow[] => rows.map((row) => {
    const out: ImportRow = { customFields: {} };
    for (const [header, destination] of Object.entries(mapping)) {
      if (!destination) continue;
      const value = row[header] ?? '';
      if ((STANDARD_FIELDS as readonly string[]).includes(destination)) {
        out[destination as StandardField] = value;
      } else {
        out.customFields![destination] = value;
      }
    }
    return out;
  });

  const submit = async () => {
    setSubmitting(true);
    try {
      const result = await importContacts({
        rows: buildRows(),
        consentAffirmed: consent,
        defaultCountryCode: countryCode || undefined,
        tag: tag.trim() || null,
      });
      setSummary(result);
      toast.success(t('اكتمل الاستيراد'));
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || t('تعذّر الاستيراد'));
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = consent && validCount > 0 && !submitting;

  return (
    <div className="mx-auto max-w-4xl p-5">
      <div className="mb-4 flex items-center gap-2">
        <Button size="icon" variant="ghost" asChild>
          <Link href="/contacts"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <h1 className="text-lg font-bold">{t('استيراد جهات الاتصال')}</h1>
      </div>

      {summary ? (
        <ImportResult summary={summary} onReset={() => { setSummary(null); setRows([]); setHeaders([]); setFileName(''); }} t={t} />
      ) : (
        <div className="space-y-4">
          {/* Step 1 — file */}
          <Card>
            <CardContent className="p-4">
              <p className="mb-2 text-xs font-semibold">{t('١. اختر ملف CSV')}</p>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) parse(file);
                }}
                onClick={() => fileInput.current?.click()}
                className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed border-border py-8 transition-colors hover:border-primary/60"
              >
                <FileUp className="h-6 w-6 text-muted-foreground" />
                <p className="text-xs text-muted-foreground">
                  {fileName || t('اسحب الملف هنا أو انقر للاختيار')}
                </p>
                {rows.length > 0 && (
                  <p className="text-caption text-muted-foreground">
                    {rows.length} {t('صف')} · {headers.length} {t('عمود')}
                  </p>
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => { const file = e.target.files?.[0]; if (file) parse(file); }}
              />
            </CardContent>
          </Card>

          {headers.length > 0 && (
            <>
              {/* Step 2 — mapping */}
              <Card>
                <CardContent className="space-y-3 p-4">
                  <p className="text-xs font-semibold">{t('٢. اربط الأعمدة')}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {headers.map((header) => (
                      <div key={header} className="flex items-center gap-2">
                        <span className="w-1/2 truncate text-caption text-muted-foreground" title={header}>
                          {header}
                        </span>
                        <select
                          value={mapping[header] || ''}
                          onChange={(e) => setMapping((m) => ({ ...m, [header]: e.target.value }))}
                          className="select-field select-field-sm flex-1"
                        >
                          <option value="">{t('تجاهل')}</option>
                          <option value="phone">{t('الهاتف')}</option>
                          <option value="name">{t('الاسم')}</option>
                          <option value="email">{t('البريد الإلكتروني')}</option>
                          <option value="lifecycleStage">{t('المرحلة')}</option>
                          {fields.map((field) => (
                            <option key={field.slug} value={field.slug}>{field.name}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label className="text-xs">{t('رمز الدولة الافتراضي')}</Label>
                      <Input
                        value={countryCode}
                        onChange={(e) => setCountryCode(e.target.value)}
                        placeholder="972"
                        dir="ltr"
                      />
                      <p className="text-micro text-muted-foreground">
                        {t('يُستخدم للأرقام المحلية التي تبدأ بصفر')}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('وسم للمستوردين')}</Label>
                      <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder={t('اختياري')} />
                    </div>
                  </div>

                  {!phoneHeader && (
                    <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-caption text-destructive">
                      {t('يجب ربط عمود واحد بالهاتف')}
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Preview */}
              <Card>
                <CardContent className="p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold">{t('معاينة')}</p>
                    <p className="text-caption">
                      <span className="text-success-vivid">{validCount} {t('صالح')}</span>
                      {invalidCount > 0 && (
                        <span className="ms-2 text-destructive">{invalidCount} {t('غير صالح')}</span>
                      )}
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-caption">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="p-1 text-start">#</th>
                          <th className="p-1 text-start">{t('الهاتف')}</th>
                          <th className="p-1 text-start">{t('الاسم')}</th>
                          <th className="p-1 text-start">{t('الحالة')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, PREVIEW_ROWS).map((row, index) => {
                          const result = validated[index];
                          const nameHeader = Object.keys(mapping).find((h) => mapping[h] === 'name');
                          return (
                            <tr key={index} className={cn('border-t border-border', !result.ok && 'bg-destructive/5')}>
                              <td className="p-1 text-muted-foreground">{index + 1}</td>
                              <td className="numeric p-1 font-mono" dir="ltr">
                                {result.ok ? displayE164(result.phone) : (phoneHeader ? row[phoneHeader] : '—')}
                              </td>
                              <td className="truncate p-1">{nameHeader ? row[nameHeader] : '—'}</td>
                              <td className="p-1">
                                {result.ok
                                  ? <span className="text-success-vivid">✓</span>
                                  : <span className="text-destructive">{t(PHONE_REASON_LABELS[result.reason])}</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {rows.length > PREVIEW_ROWS && (
                    <p className="mt-2 text-micro text-muted-foreground">
                      {t('تُعرض أول صفوف فقط — يتم التحقق من كل الصفوف عند الاستيراد.')}
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Step 3 — consent */}
              <Card>
                <CardContent className="space-y-3 p-4">
                  <p className="text-xs font-semibold">{t('٣. إقرار الموافقة')}</p>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-caption leading-relaxed">
                      {t('أؤكد أن جميع جهات الاتصال في هذا الملف وافقت صراحةً على استقبال رسائل من مؤسستنا.')}
                    </span>
                  </label>
                  <p className="text-micro text-muted-foreground">
                    {t('جهات الاتصال التي سبق أن ألغت الاشتراك تبقى ملغاة ولا يعيدها الاستيراد.')}
                  </p>

                  <Button onClick={submit} disabled={!canSubmit} className="w-full">
                    {submitting ? <Loader2 className="me-1 h-4 w-4 animate-spin" /> : <Upload className="me-1 h-4 w-4" />}
                    {t('استيراد')} {validCount > 0 ? `(${validCount})` : ''}
                  </Button>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ImportResult({
  summary, onReset, t,
}: {
  summary: ImportSummary;
  onReset: () => void;
  t: (key: string) => string;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-success-vivid" />
          <p className="text-sm font-semibold">{t('اكتمل الاستيراد')}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t('الإجمالي')} value={summary.total} />
          <Stat label={t('جديدة')} value={summary.created} tone="ok" />
          <Stat label={t('محدّثة')} value={summary.updated} />
          <Stat label={t('فشلت')} value={summary.failed} tone={summary.failed ? 'bad' : undefined} />
        </div>

        {summary.skippedOptedOut > 0 && (
          <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1.5 text-caption text-warning">
            {summary.skippedOptedOut} {t('جهة اتصال بقيت ملغاة الاشتراك ولم يغيّرها الاستيراد.')}
          </p>
        )}

        {summary.errors.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            <table className="w-full text-caption">
              <tbody>
                {summary.errors.map((error, index) => (
                  <tr key={index} className="border-b border-border last:border-0">
                    <td className="w-16 p-1.5 text-muted-foreground">{t('صف')} {error.row}</td>
                    <td className="p-1.5">{error.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex gap-2">
          <Button variant="outline" onClick={onReset}>{t('استيراد ملف آخر')}</Button>
          <Button asChild><Link href="/contacts">{t('عرض جهات الاتصال')}</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'bad' }) {
  return (
    <div className="rounded-md border border-border p-2 text-center">
      <p className={cn(
        'numeric font-mono text-lg font-bold',
        tone === 'ok' && 'text-success-vivid',
        tone === 'bad' && 'text-destructive',
      )}>
        {value}
      </p>
      <p className="text-micro text-muted-foreground">{label}</p>
    </div>
  );
}
