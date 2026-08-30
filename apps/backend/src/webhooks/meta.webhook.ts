import crypto from 'crypto';
import { Request, Response } from 'express';
import logger from '../lib/logger';
import { getTenantId, runAsOrganization, runAsPlatform } from '../lib/tenant-context';
import { prisma } from '../prisma';

/**
 * The Meta WhatsApp Cloud API inbound webhook.
 *
 * Every customer's messages arrive at this one URL, signed by one app secret,
 * distinguished only by a phone number id in the body. That makes this the
 * single place in the system where an organization is chosen from data supplied
 * by the outside world rather than from an authenticated session — and
 * therefore the only place a routing mistake delivers one business's customer
 * conversations into another business's inbox.
 *
 * The whole file is arranged around keeping that decision small enough to read
 * in one sitting: verify, resolve, scope, hand off. Nothing else happens out
 * here.
 */

const SIGNATURE_HEADER = 'x-hub-signature-256';

function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Verify Meta's signature over the RAW request bytes.
 *
 * The raw body matters, not a re-serialised object. `JSON.parse` followed by
 * `JSON.stringify` reorders keys, drops insignificant whitespace and renormalises
 * numbers and unicode escapes, so a signature checked against re-serialised JSON
 * fails for legitimate requests and — worse — can be made to pass for bodies
 * that differ from what Meta actually signed. This route is mounted with
 * `express.raw` ahead of the global JSON parser for exactly this reason.
 *
 * Fails closed when META_APP_SECRET is unset. An unsigned webhook that anyone
 * on the internet can POST to is a way to inject messages into any tenant.
 */
export function verifyMetaSignature(rawBody: Buffer, header: unknown): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;

  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== 'string' || !provided.startsWith('sha256=')) return false;

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return timingSafeEquals(provided, expected);
}

export type MetaChangeContext = {
  organizationId: string;
  channelId: string;
  phoneNumberId: string;
  field: string;
  value: Record<string, unknown>;
};

export type MetaChangeHandler = (context: MetaChangeContext) => Promise<void>;

/**
 * Resolve the organization that owns a Meta phone number id.
 *
 * **This is the only function in the system that resolves an organizationId
 * from outside a tenancy scope, and it is deliberately the smallest thing that
 * can do it.** It performs exactly one lookup, keyed on the column that carries
 * a GLOBAL unique index precisely so this question has one answer or none. It
 * returns a row or null, makes no decision about what to do next, and touches
 * nothing else.
 *
 * It runs under platform scope because a tenant scope is what it is trying to
 * establish — there is no organization to run as until this returns. That is
 * the one legitimate use of platform scope on the inbound path, and widening
 * this function is how that stops being true.
 *
 * Note the deliberate absence of a fallback. There is no "closest match", no
 * "first active Meta channel", no defaulting to a single-tenant install. An
 * unrecognised number resolves to null and the payload is dropped, because the
 * only alternative to knowing which business a message belongs to is guessing,
 * and a wrong guess here shows one company's customers to another.
 */
export async function organizationForPhoneNumberId(phoneNumberId: string): Promise<{
  organizationId: string;
  channelId: string;
  wabaId: string;
} | null> {
  if (!phoneNumberId) return null;
  return runAsPlatform('meta-webhook:resolve-phone-number-id', () =>
    prisma.metaChannelCredential.findUnique({
      where: { phoneNumberId },
      select: { organizationId: true, channelId: true, wabaId: true },
    }));
}

/**
 * Where inbound Meta messages will be ingested.
 *
 * Not wired yet, and saying so is the point: the Cloud API payload is a
 * different shape from OpenWA's, and normalising it into contacts,
 * conversations, acks and media is its own step. What is finished is everything
 * outside this function — signature, routing, tenancy — which is the part that
 * cannot be got wrong later without consequences.
 *
 * Anything added here already runs inside runAsOrganization for the resolved
 * tenant, so ordinary prisma calls are scoped like any request handler.
 */
async function ingestChange(context: MetaChangeContext): Promise<void> {
  const value = context.value as { messages?: unknown[]; statuses?: unknown[] };
  logger.info('Meta webhook: change accepted (ingestion not yet wired)', {
    organizationId: getTenantId(),
    channelId: context.channelId,
    field: context.field,
    messages: Array.isArray(value?.messages) ? value.messages.length : 0,
    statuses: Array.isArray(value?.statuses) ? value.statuses.length : 0,
  });
}

/**
 * Walk the payload and run each change inside its own organization's scope.
 *
 * `onChange` is injectable so the isolation gate can observe which scope each
 * change actually entered. Production uses the default.
 */
export async function dispatchMetaWebhookPayload(
  payload: unknown,
  onChange: MetaChangeHandler = ingestChange,
): Promise<void> {
  const body = (payload || {}) as { entry?: unknown };
  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const rawEntry of entries) {
    const entry = (rawEntry || {}) as { id?: unknown; changes?: unknown };
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const rawChange of changes) {
      const change = (rawChange || {}) as { field?: unknown; value?: unknown };
      const value = (change.value || {}) as { metadata?: { phone_number_id?: unknown } };
      const phoneNumberId = String(value.metadata?.phone_number_id || '');

      const resolved = await organizationForPhoneNumberId(phoneNumberId);
      if (!resolved) {
        // Dropped, not guessed. Logged with the id so a real misconfiguration is
        // diagnosable, and returned as 200 upstream so Meta does not retry a
        // payload this platform will never be able to route.
        logger.warn('Meta webhook: unknown phone_number_id, payload dropped', {
          phoneNumberId,
          field: String(change.field || ''),
        });
        continue;
      }

      // Advisory cross-check. Routing is decided by phone_number_id alone,
      // because that is the column with the global unique index and therefore
      // the only field that can answer "whose is this" unambiguously. A WABA id
      // that disagrees means the stored credential has drifted from Meta's view
      // of the account, which is worth knowing loudly and is not a reason to
      // route the message somewhere else.
      if (entry.id && resolved.wabaId && String(entry.id) !== resolved.wabaId) {
        logger.warn('Meta webhook: entry WABA id does not match the stored credential', {
          organizationId: resolved.organizationId,
          phoneNumberId,
        });
      }

      try {
        await runAsOrganization(resolved.organizationId, () => onChange({
          organizationId: resolved.organizationId,
          channelId: resolved.channelId,
          phoneNumberId,
          field: String(change.field || ''),
          value: (change.value || {}) as Record<string, unknown>,
        }));
      } catch (error) {
        // One tenant's failure must not abandon the rest of the batch: Meta
        // packs changes for multiple numbers into a single delivery.
        logger.error('Meta webhook: change handler failed', {
          organizationId: resolved.organizationId,
          phoneNumberId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * GET — Meta's subscription handshake.
 *
 * Meta calls this once when the callback URL is registered and expects the
 * challenge echoed back verbatim. Compared in constant time: the verify token is
 * a shared secret, and a comparison that returns early leaks it a byte at a time
 * to anyone who can call this endpoint, which is everyone.
 */
export function metaWebhookVerifyHandler(req: Request, res: Response) {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) {
    logger.error('Meta webhook verification attempted with META_WEBHOOK_VERIFY_TOKEN unset');
    return res.sendStatus(403);
  }

  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');

  if (mode === 'subscribe' && timingSafeEquals(token, expected)) {
    return res.status(200).send(challenge);
  }

  logger.warn('Meta webhook verification rejected', { mode });
  return res.sendStatus(403);
}

/**
 * POST — inbound events.
 *
 * Order is load-bearing: verify the signature over the raw bytes, answer 200,
 * and only then parse and process. Meta treats a slow or non-200 response as a
 * failure and retries, and repeated retries eventually suspend the
 * subscription — so the acknowledgement must not wait on database work whose
 * duration this code does not control.
 *
 * A body that cannot be parsed, or names a number this platform does not know,
 * has still been acknowledged by then. That is correct: neither is something a
 * retry could fix, and leaving Meta to retry it forever costs the subscription
 * every tenant on this app depends on.
 */
export async function metaWebhookHandler(req: Request, res: Response) {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  if (!verifyMetaSignature(rawBody, req.headers[SIGNATURE_HEADER])) {
    // Not from Meta — or from Meta with a secret this platform does not hold.
    // Answered 401 rather than 200: a forged inbound message is an attempt to
    // write into a tenant, and it is not something to acknowledge.
    logger.warn('Meta webhook: signature rejected', {
      hasHeader: Boolean(req.headers[SIGNATURE_HEADER]),
      bytes: rawBody.length,
    });
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Acknowledge before any processing. Nothing below this line can change the
  // response.
  res.status(200).send();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    logger.warn('Meta webhook: signed body was not valid JSON', { bytes: rawBody.length });
    return;
  }

  setImmediate(() => {
    void dispatchMetaWebhookPayload(payload).catch((error) => {
      logger.error('Meta webhook: dispatch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
