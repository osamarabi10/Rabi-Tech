/** Replace {{placeholders}} in template body. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

export type DynamicMessageContext = {
  contact: {
    id: string;
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
    countryCode?: string | null;
    customFields?: Record<string, string | null | undefined>;
  };
  assignee?: { id?: string; name?: string | null; email?: string | null } | null;
  timezone?: string;
  now?: Date;
};

function currentParts(now: Date, timezone: string): Record<string, string> {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    const time = `${values.hour}:${values.minute}:${values.second}`;
    return { current_date: date, current_time: time, current_datetime: `${date} ${time}` };
  } catch {
    return currentParts(now, 'UTC');
  }
}

/** Resolve Respond.io-style variables at the final send boundary. */
export function renderDynamicVariables(body: string, context: DynamicMessageContext): string {
  const contactName = context.contact.name
    || [context.contact.firstName, context.contact.lastName].filter(Boolean).join(' ')
    || '';
  const contact: Record<string, string | null | undefined> = {
    id: context.contact.id,
    name: contactName,
    firstname: context.contact.firstName,
    lastname: context.contact.lastName,
    email: context.contact.email,
    phone: context.contact.phone,
    country: context.contact.countryCode,
    ...(context.contact.customFields || {}),
  };
  const assignee: Record<string, string | null | undefined> = {
    id: context.assignee?.id,
    name: context.assignee?.name,
    email: context.assignee?.email,
  };
  const system = currentParts(context.now || new Date(), context.timezone || 'Asia/Jerusalem');

  return body
    .replace(/\$contact(?!\.)\b/g, contactName || '$contact')
    .replace(/\$(contact|assignee|system)\.([a-zA-Z0-9_]+)/g, (original, group: string, rawKey: string) => {
      const key = rawKey.toLowerCase();
      const source = group === 'contact' ? contact : group === 'assignee' ? assignee : system;
      const value = source[key];
      return value === undefined || value === null || value === '' ? original : String(value);
    });
}
