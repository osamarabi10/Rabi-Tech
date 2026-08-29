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
): Promise<T> {
  let response;
  try {
    response = await client(accessToken).request({ method, url: path, params });
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
