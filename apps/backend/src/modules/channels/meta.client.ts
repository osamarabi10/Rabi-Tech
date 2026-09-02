import axios, { AxiosError, AxiosInstance } from 'axios';

/**
 * The Meta Graph API client.
 *
 * Deliberately thin: it knows how to call four endpoints and how to turn a Meta
 * error into something this codebase can branch on. It holds no state, caches
 * nothing, and makes no decisions about what a failure *means* — that is
 * meta.service's job, because the same HTTP 400 means "your phone number id is
 * wrong" in one call and "this app is already subscribed" in another.
 */

/**
 * Pinned, never "latest".
 *
 * Meta dates every Graph version and retires it roughly two years on. An
 * unpinned client therefore changes behaviour on Meta's schedule rather than
 * ours, and the change lands in production without a deploy — the failure mode
 * being that inbound webhook payloads quietly change shape and messages stop
 * being parsed. Pinning makes the upgrade an explicit, testable act.
 *
 * The env override exists so a version bump can be trialled without a code
 * change, but the default is the contract: this is the version the webhook
 * parser and the send path were written against.
 */
export const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || 'v21.0';

const BASE_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/**
 * Short on purpose. This runs inside a request an admin is watching, and four
 * sequential calls at 30s each is a two-minute spinner ending in a timeout the
 * browser has already given up on.
 */
const TIMEOUT_MS = 15_000;

/**
 * A Meta API failure, with the fields worth branching on.
 *
 * Meta's own codes are the only reliable signal — the human `message` is
 * localised and reworded between versions, so matching on it is a bug waiting
 * for a Meta copy edit.
 */
export class MetaApiError extends Error {
  readonly httpStatus: number;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly fbtraceId: string | null;

  constructor(
    message: string,
    parts: {
      httpStatus: number;
      code?: number | null;
      subcode?: number | null;
      type?: string | null;
      fbtraceId?: string | null;
    },
  ) {
    super(message);
    this.name = 'MetaApiError';
    this.httpStatus = parts.httpStatus;
    this.code = parts.code ?? null;
    this.subcode = parts.subcode ?? null;
    this.type = parts.type ?? null;
    this.fbtraceId = parts.fbtraceId ?? null;
  }

  /**
   * The token is bad: expired, revoked, or never had the scope. Meta returns
   * 190 for the token itself and 200/10 for a permission the token lacks.
   */
  get isAuthFailure(): boolean {
    return this.code === 190 || this.code === 200 || this.code === 10 || this.httpStatus === 401;
  }

  /** The node does not exist, or this token cannot see it — Meta conflates them. */
  get isUnknownNode(): boolean {
    return this.code === 803 || this.httpStatus === 404;
  }
}

function client(accessToken: string): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    timeout: TIMEOUT_MS,
    // Bearer header, never `?access_token=`. Query strings end up in proxy
    // logs, browser history and error trackers; a System User token in any of
    // those is a business's WhatsApp number in someone else's hands.
    headers: { Authorization: `Bearer ${accessToken}` },
    // Meta returns structured errors with 4xx. Let them through so the shape is
    // read rather than collapsed into "Request failed with status code 400".
    validateStatus: () => true,
  });
}

/**
 * Normalise every outcome into either a value or a MetaApiError.
 *
 * The `raw` response is never returned to a caller and never logged: a Graph
 * error body echoes parts of the request, and this request carries a token.
 */
async function call<T>(
  accessToken: string,
  method: 'get' | 'post',
  path: string,
  params?: Record<string, string>,
  data?: unknown,
): Promise<T> {
  let response;
  try {
    response = await client(accessToken).request({ method, url: path, params, data });
  } catch (error) {
    // Transport-level: DNS, TLS, timeout. Meta never saw the request.
    const axiosError = error as AxiosError;
    throw new MetaApiError(
      axiosError.code === 'ECONNABORTED'
        ? `Meta Graph API did not respond within ${TIMEOUT_MS}ms`
        : `Could not reach the Meta Graph API (${axiosError.code || 'network error'})`,
      { httpStatus: 0 },
    );
  }

  if (response.status >= 200 && response.status < 300) return response.data as T;

  const body = (response.data || {}) as { error?: Record<string, unknown> };
  const metaError = body.error || {};
  throw new MetaApiError(String(metaError.message || `Meta Graph API returned ${response.status}`), {
    httpStatus: response.status,
    code: typeof metaError.code === 'number' ? metaError.code : null,
    subcode: typeof metaError.error_subcode === 'number' ? metaError.error_subcode : null,
    type: typeof metaError.type === 'string' ? metaError.type : null,
    fbtraceId: typeof metaError.fbtrace_id === 'string' ? metaError.fbtrace_id : null,
  });
}

export type MetaPhoneNumber = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  messaging_limit_tier?: string;
};

/** Validation 1: does this phone number id exist, and can this token see it? */
export async function fetchPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
): Promise<MetaPhoneNumber> {
  return call<MetaPhoneNumber>(accessToken, 'get', `/${encodeURIComponent(phoneNumberId)}`, {
    fields: 'id,display_phone_number,verified_name',
  });
}

/**
 * Validation 2: does this token have management access to the WABA, and does
 * the phone number actually belong to it?
 *
 * Listing the WABA's numbers answers both in one call. The second half matters
 * more than it looks: a token can legitimately see a phone number that belongs
 * to a *different* WABA, and subscribing the wrong WABA succeeds while routing
 * nothing — a connection that reports healthy and never delivers a message.
 */
export async function fetchWabaPhoneNumbers(
  wabaId: string,
  accessToken: string,
): Promise<MetaPhoneNumber[]> {
  const data = await call<{ data?: MetaPhoneNumber[] }>(
    accessToken,
    'get',
    `/${encodeURIComponent(wabaId)}/phone_numbers`,
    { fields: 'id,display_phone_number,verified_name', limit: '100' },
  );
  return data.data || [];
}

/**
 * Validation 3: subscribe this app to the WABA's webhooks.
 *
 * This is the call that makes inbound messages arrive. Everything else can
 * succeed without it and the channel will send perfectly while receiving
 * nothing, which presents to the customer as the business ignoring them.
 */
export async function subscribeApp(
  wabaId: string,
  accessToken: string,
): Promise<{ success: boolean }> {
  const data = await call<{ success?: boolean }>(
    accessToken,
    'post',
    `/${encodeURIComponent(wabaId)}/subscribed_apps`,
  );
  // Meta answers `{"success": true}`. A 2xx without it is not a subscription.
  return { success: data.success === true };
}

/** Validation 4: the operational numbers — sending tier and quality rating. */
export async function fetchPhoneNumberStanding(
  phoneNumberId: string,
  accessToken: string,
): Promise<MetaPhoneNumber> {
  return call<MetaPhoneNumber>(accessToken, 'get', `/${encodeURIComponent(phoneNumberId)}`, {
    fields: 'id,quality_rating,messaging_limit_tier,display_phone_number,verified_name',
  });
}

export type MetaTemplateComponent = {
  type: string;
  format?: string;
  text?: string;
  buttons?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

/** The provider-shaped template record used by submit, import, and polling. */
export type MetaTemplateSnapshot = {
  id?: string;
  name?: string;
  language?: string;
  category?: string;
  status?: string;
  components?: MetaTemplateComponent[];
  rejected_reason?: string | null;
  last_updated_time?: string | null;
};

export type MetaTemplateListPage = {
  data?: MetaTemplateSnapshot[];
  paging?: {
    cursors?: { after?: string | null };
    next?: string | null;
  };
};

/** Submit one Utility or Marketing text template to the WABA that owns it. */
export async function createMessageTemplate(
  wabaId: string,
  accessToken: string,
  payload: {
    name: string;
    language: string;
    category: string;
    components: MetaTemplateComponent[];
  },
): Promise<MetaTemplateSnapshot> {
  return call<MetaTemplateSnapshot>(
    accessToken,
    'post',
    `/${encodeURIComponent(wabaId)}/message_templates`,
    undefined,
    payload,
  );
}

/** Read one page of WABA templates; callers own cursor progression and repair. */
export async function listMessageTemplates(
  wabaId: string,
  accessToken: string,
  after?: string,
): Promise<MetaTemplateListPage> {
  return call<MetaTemplateListPage>(
    accessToken,
    'get',
    `/${encodeURIComponent(wabaId)}/message_templates`,
    {
      fields: 'id,name,language,category,status,components,rejected_reason,last_updated_time',
      limit: '100',
      ...(after ? { after } : {}),
    },
  );
}

/**
 * Meta's response to a send.
 *
 * `messages[0].id` is the wamid, and it matters more than it looks: delivery and
 * read receipts arrive later on the webhook keyed by it, so a send that cannot
 * report its own id produces a message whose status can never advance past SENT.
 */
export type MetaSendResponse = {
  messaging_product?: string;
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string }>;
};

/** Meta's own media categories. Anything unrecognised is a document. */
function mediaKind(mimeType: string | null | undefined): 'image' | 'video' | 'audio' | 'document' {
  const type = String(mimeType || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Meta wants a bare international number with no `+` and no `@c.us`.
 *
 * OpenWA addresses carry a `@c.us` suffix and this codebase passes addresses
 * around in whichever form the conversation stored. Normalising at the edge
 * keeps that difference from becoming every caller's problem.
 */
export function toMetaRecipient(address: string): string {
  return String(address || '').replace(/@.*$/, '').replace(/[^\d]/g, '');
}

export async function sendTextMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<MetaSendResponse> {
  return call<MetaSendResponse>(
    accessToken,
    'post',
    `/${encodeURIComponent(phoneNumberId)}/messages`,
    undefined,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toMetaRecipient(to),
      type: 'text',
      // preview_url off: a link preview is generated by fetching the target,
      // which turns every message containing a URL into an outbound request
      // from Meta on the customer's behalf. Not something to enable silently.
      text: { preview_url: false, body },
    },
  );
}

/**
 * A component in an outbound template send.
 *
 * Meta's shape, not a friendlier one. The body's `parameters` fill `{{1}}`,
 * `{{2}}` positionally, and header/button components carry their own. Modelling
 * it faithfully rather than inventing a nicer object matters here: the template
 * was approved in Meta's shape, and a translation layer that gets a position
 * wrong produces a send Meta rejects — which costs the number's quality rating,
 * not just an error.
 */
/**
 * Distinct from `MetaTemplateComponent` above, and deliberately so.
 *
 * That one describes a template's **structure** — the header format, the body
 * text with its `{{1}}` placeholders, the buttons — and is what submit, import
 * and polling exchange with Meta. This one supplies **values** at send time.
 *
 * Conflating them would be a real modelling error rather than a tidiness one:
 * a definition has `text`, a send has `parameters`, and a type that accepts
 * both lets a caller send a template definition as though it were a set of
 * values. Meta rejects that, and a rejected send costs the number's quality
 * rating.
 */
export type MetaTemplateSendComponent = {
  type: 'header' | 'body' | 'button';
  sub_type?: string;
  index?: string;
  parameters?: Array<Record<string, unknown>>;
};

/**
 * Send an approved template.
 *
 * ## Why this is the only way to start a conversation
 *
 * Meta permits free-form messages only inside the 24-hour window that opens
 * when the customer writes. Outside it — which includes *every contact who has
 * never written* — an approved template is the sole permitted message. Without
 * this call a Meta-only workspace can reply and can never initiate: no
 * onboarding, no notification, no re-engagement, no broadcast to a cold list.
 *
 * That is not a missing convenience. GROWTH, BUSINESS and ENTERPRISE are
 * `['WHATSAPP_CLOUD']` only, so it was a ceiling on the three paying tiers.
 */
export async function sendTemplateMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  templateName: string,
  languageCode: string,
  components: MetaTemplateSendComponent[] = [],
): Promise<MetaSendResponse> {
  return call<MetaSendResponse>(
    accessToken,
    'post',
    `/${encodeURIComponent(phoneNumberId)}/messages`,
    undefined,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toMetaRecipient(to),
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        // Omitted entirely when empty. Meta rejects `components: []` on a
        // template that declares no variables, which is most of them.
        ...(components.length ? { components } : {}),
      },
    },
  );
}

export async function sendMediaMessage(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  url: string,
  caption: string | undefined,
  options: { mediaType?: string | null; fileName?: string | null },
): Promise<MetaSendResponse> {
  const kind = mediaKind(options.mediaType);
  // Meta fetches the link itself, so the URL must be publicly reachable. Audio
  // takes no caption and document takes a filename; sending a caption where it
  // is not allowed is rejected for the whole message rather than ignored.
  const payload: Record<string, unknown> = { link: url };
  if (caption && kind !== 'audio') payload.caption = caption;
  if (kind === 'document' && options.fileName) payload.filename = options.fileName;

  return call<MetaSendResponse>(
    accessToken,
    'post',
    `/${encodeURIComponent(phoneNumberId)}/messages`,
    undefined,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toMetaRecipient(to),
      type: kind,
      [kind]: payload,
    },
  );
}
