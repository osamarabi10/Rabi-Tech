'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import {
  fetchContactCustomFields,
  fetchCustomFieldDefinitions,
  type CustomFieldDefinition,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The tenant's own contact fields, editable where the contact is.
 *
 * A subscriber could define custom fields in settings and then fill them from
 * exactly one place: a CSV import. The panel that shows a contact — the one
 * screen an agent is looking at while the customer tells them the thing worth
 * recording — could not write to them.
 *
 * Saved per field on blur rather than behind a form button. There is no
 * submit here to press, and a section of inputs with one distant Save is how
 * edits get lost when the agent clicks away to answer the message.
 */

type Values = Record<string, string | null>;

function inputTypeFor(dataType: CustomFieldDefinition['dataType']): string {
  if (dataType === 'number') return 'number';
  if (dataType === 'date') return 'date';
  return 'text';
}

export function CustomFieldsSection({
  contactId,
  onSaved,
}: {
  contactId: string;
  onSaved?: (slug: string, value: string | null) => void;
}) {
  const { t } = useT();
  const [definitions, setDefinitions] = useState<CustomFieldDefinition[] | null>(null);
  const [values, setValues] = useState<Values>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCustomFieldDefinitions()
      .then((next) => {
        if (!cancelled) setDefinitions(next);
      })
      .catch(() => {
        if (!cancelled) setDefinitions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * This contact's values, fetched here rather than carried on the
   * conversation.
   *
   * `Conv` is built for a list of hundreds of rows and has no business
   * hauling every custom field of every contact so that one open panel can
   * read one of them.
   */
  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    fetchContactCustomFields(contactId)
      .then((next) => {
        if (!cancelled) setValues(next);
      })
      .catch(() => {
        if (!cancelled) setValues({});
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const save = async (definition: CustomFieldDefinition, next: string) => {
    const trimmed = next.trim();
    const previous = values[definition.slug] ?? '';
    if (trimmed === previous.trim()) return;

    setSaving(definition.slug);
    try {
      await api.put(`/api/contacts/${contactId}/custom-fields/${definition.slug}`, {
        value: trimmed || null,
      });
      setValues((current) => ({ ...current, [definition.slug]: trimmed || null }));
      onSaved?.(definition.slug, trimmed || null);
    } catch (err: any) {
      // The server's message names the field and what it expected — a list
      // field says which values it takes. Replacing that with "save failed"
      // leaves the agent guessing at a rule they cannot see.
      toast.error(err?.response?.data?.error ?? t('فشل الحفظ'));
      setValues((current) => ({ ...current, [definition.slug]: previous }));
    } finally {
      setSaving(null);
    }
  };

  // Nothing configured. No heading over an empty space — this product's whole
  // vocabulary is subscriber-defined, and a tenant with no custom fields should
  // not be told they have a custom fields section.
  if (!definitions || definitions.length === 0) return null;

  return (
    <div className="border-b border-border p-4">
      <p className="mb-2 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
        {t('حقول مخصصة')}
      </p>

      <dl className="space-y-2 text-caption">
        {definitions.map((definition) => {
          const value = values[definition.slug] ?? '';
          const busy = saving === definition.slug;

          return (
            <div key={definition.id} className="flex items-center gap-2">
              <dt
                className="w-20 shrink-0 truncate text-muted-foreground"
                title={definition.description || definition.name}
              >
                {definition.name}
              </dt>
              <dd className="min-w-0 flex-1">
                {definition.dataType === 'list' && definition.allowedValues.length > 0 ? (
                  <select
                    value={value}
                    disabled={busy}
                    onChange={(event) => save(definition, event.target.value)}
                    className="w-full rounded border border-border bg-card px-1.5 py-0.5 text-caption disabled:opacity-50"
                  >
                    <option value="">{t('غير محدد')}</option>
                    {definition.allowedValues.map((allowed) => (
                      <option key={allowed} value={allowed}>
                        {allowed}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    // Keyed on the contact so an uncontrolled input does not
                    // carry the previous contact's text into the next one.
                    key={`${contactId}:${definition.id}:${value}`}
                    type={inputTypeFor(definition.dataType)}
                    defaultValue={value}
                    disabled={busy}
                    // Numbers and dates read left-to-right whatever the
                    // interface language is doing.
                    dir={definition.dataType === 'text' ? 'auto' : 'ltr'}
                    onBlur={(event) => save(definition, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    className={cn(
                      'w-full rounded border border-border bg-card px-1.5 py-0.5 text-caption',
                      'disabled:opacity-50',
                      definition.dataType !== 'text' && 'numeric font-mono tabular-nums',
                    )}
                  />
                )}
              </dd>
              {busy && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
            </div>
          );
        })}
      </dl>
    </div>
  );
}
