/**
 * Cloud API payload -> the inbound job this product already processes.
 *
 * Pure and database-free on purpose. Everything downstream of it — contact
 * upsert, one-thread-per-contact, auto-replies, assignment, the socket emit —
 * already exists and is exercised daily by OpenWA. The riskiest thing this step
 * could do is grow a second copy of that logic for a second channel, so it does
 * the opposite: it translates a payload into the shape the existing pipeline
 * consumes, and then gets out of the way.
 */

/** Media-bearing types carry an object with an `id` to fetch. */
const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker', 'voice'] as const;

/**
 * Types this product cannot render as a message, listed rather than assumed.
 *
 * They are NOT dropped. Silence is indistinguishable from a system that lost
 * the message, and an agent who sees nothing replies as though nothing was
 * sent — while the customer sits looking at a location they shared.
 *
 * What gets stored is the **type**, never a sentence. A stored English string
 * like "[location]" cannot be translated afterwards, which is precisely the
 * defect flagged in the Respond.io review of `[Deleted Workflow]`. An Arabic
 * organization must read Arabic, so the type is stored and the copy is rendered.
 */
const PLACEHOLDER_TYPES = [
  'location', 'contacts', 'interactive', 'button', 'order',
  'system', 'reaction', 'unsupported', 'unknown',
] as const;

export type MetaInboundMessage = {
  /** Customer's number, digits only, matching the existing normalisation. */
  phone: string;
  contactName?: string;
  body: string;
  waMessageId: string;
  /** Present only for media types; the caller exchanges it for bytes. */
  mediaId?: string;
  /** Meta's own type, e.g. image/document/location. Stored, never rendered raw. */
  metaType: string;
  fileName?: string | null;
  mimeType?: string | null;
  /** True when the type has no representation here and needs placeholder copy. */
  placeholder: boolean;
  timestamp: Date;
};

export type MetaInboundStatus = {
  waMessageId: string;
  /** Already mapped onto this product's MessageStatus vocabulary. */
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
};

/** Meta sends unix seconds as a string. */
function toDate(value: unknown): Date {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

/** Match the normalisation the rest of the product already applies. */
function normalizePhone(value: unknown): string {
  return String(value ?? '').replace(/@.*$/, '').replace(/^\+/, '').replace(/[^\d]/g, '');
}

const STATUS_MAP: Record<string, MetaInboundStatus['status']> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

/**
 * Extract the inbound messages from one `changes[].value`.
 *
 * Meta never echoes messages the business sent, so unlike the OpenWA webhook
 * there is no `fromMe` case to filter — anything in `messages[]` came from a
 * customer.
 */
export function normalizeMetaMessages(value: unknown): MetaInboundMessage[] {
  const body = (value || {}) as {
    messages?: unknown[];
    contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];

  // contacts[] carries the WhatsApp profile name, keyed by wa_id.
  const names = new Map<string, string>();
  for (const contact of body.contacts || []) {
    if (contact?.wa_id && contact.profile?.name) names.set(String(contact.wa_id), contact.profile.name);
  }

  const out: MetaInboundMessage[] = [];
  for (const raw of messages) {
    const message = (raw || {}) as Record<string, any>;
    const waMessageId = String(message.id || '');
    const from = String(message.from || '');
    if (!waMessageId || !from) continue;

    const metaType = String(message.type || 'unknown').toLowerCase();
    const base = {
      phone: normalizePhone(from),
      contactName: names.get(from),
      waMessageId,
      metaType,
      timestamp: toDate(message.timestamp),
    };

    if (metaType === 'text') {
      out.push({ ...base, body: String(message.text?.body || ''), placeholder: false });
      continue;
    }

    if ((MEDIA_TYPES as readonly string[]).includes(metaType)) {
      const media = (message[metaType] || {}) as Record<string, any>;
      out.push({
        ...base,
        // A caption is the customer's own words about the file and belongs in
        // the message body, exactly as OpenWA's caption does.
        body: String(media.caption || ''),
        mediaId: media.id ? String(media.id) : undefined,
        fileName: media.filename ? String(media.filename) : null,
        mimeType: media.mime_type ? String(media.mime_type) : null,
        placeholder: false,
      });
      continue;
    }

    // Everything else: recorded as its type, with no body. The agent sees that
    // something arrived and what kind of thing it was, in their own language.
    out.push({
      ...base,
      body: '',
      metaType: (PLACEHOLDER_TYPES as readonly string[]).includes(metaType) ? metaType : 'unsupported',
      placeholder: true,
    });
  }
  return out;
}

/** Extract delivery receipts for messages this product sent. */
export function normalizeMetaStatuses(value: unknown): MetaInboundStatus[] {
  const body = (value || {}) as { statuses?: unknown[] };
  const statuses = Array.isArray(body.statuses) ? body.statuses : [];

  const out: MetaInboundStatus[] = [];
  for (const raw of statuses) {
    const entry = (raw || {}) as Record<string, any>;
    const waMessageId = String(entry.id || '');
    const status = STATUS_MAP[String(entry.status || '').toLowerCase()];
    // An unmapped status is skipped rather than guessed: writing the wrong one
    // is worse than writing none, because the ack ladder only moves forward.
    if (waMessageId && status) out.push({ waMessageId, status });
  }
  return out;
}
