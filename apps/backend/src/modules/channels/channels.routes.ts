import { Router } from 'express';
import { auditLog } from '../../lib/audit';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { ChannelKind } from './channel.types';
import { channelCapabilities, isChannelSendError, setActiveChannelKind } from './channel.service';
import { verifyToken } from '../auth/auth.middleware';
import { detectMimeType } from '../../utils/mime';
import { readMessageMedia, verifyMessageMediaSignature } from './meta-media';
import {
  connectMetaChannel,
  disconnectMetaChannel,
  getMetaChannel,
} from './meta.service';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { cheapestUpgradeGranting, getEdition } from '../billing/editions.service';

/**
 * Whether this workspace's edition may connect a channel kind.
 *
 * `allowedChannels` shipped identical on all five editions, unread by anything,
 * with the PATCH endpoint refusing to set it — a toggle that granted nothing.
 * This is the enforcement point that makes it mean something, and a Meta-only
 * edition possible.
 *
 * Returns the cheapest edition that would allow the kind, so the refusal can
 * name what to buy rather than only what is forbidden. Read from the catalogue
 * by ladder position, never hardcoded.
 *
 * The two catalogue reads below are deliberately different, and archiving is
 * what makes the difference matter. getEdition() resolves what this workspace
 * already has and must see archived editions, or a subscriber on a withdrawn
 * plan loses a channel they are still paying for. getEditions() names what they
 * could buy and must not, so no archivedAt test belongs here - the published
 * set already excludes them. If every granting edition has been archived,
 * requiredPlan falls to null and the refusal names no upgrade at all, which is
 * right: better to say only what is forbidden than to advertise something
 * nobody can purchase.
 */
async function channelRefusal(
  organizationId: string,
  kind: ChannelKind,
): Promise<{ planName: string; requiredPlan: string | null } | null> {
  const effective = await resolveEntitlements(organizationId);
  if (getEdition(effective.plan).allowedChannels.includes(kind)) return null;
  /*
    Only an edition that is actually an upgrade. Channels are granted downward
    since the narrowing - OPENWA is allowed by FREE and STANDARD only - so
    "first in ladder order" would tell an ENTERPRISE subscriber to upgrade to
    Free. See cheapestUpgradeGranting; both callers of this already render the
    null case without a suggestion.
  */
  return {
    planName: effective.planName,
    requiredPlan: cheapestUpgradeGranting(effective.plan, (edition) => edition.allowedChannels.includes(kind)),
  };
}

/**
 * Tenant-facing channel configuration.
 *
 * Admin-only throughout. Connecting a channel hands this platform a credential
 * that sends as the business to its own customers; that is not a supervisor's
 * decision, and reading the connection reveals which number the workspace
 * operates from.
 */
const router = Router();

/**
 * Serve inbound media that was downloaded from Meta at ingest.
 *
 * Deliberately ahead of verifyToken, and authorised by an unguessable HMAC in
 * the URL rather than by a session — the same pattern as snippet assets, for
 * the same reason: an <img> tag cannot send an Authorization header, and the
 * alternative is either public files or media that does not render.
 *
 * The signature covers organization and storage key together, so a valid
 * signature for one tenant's file is not a valid signature for another's, and
 * a wrong signature is answered 404 rather than 403 — there is no reason to
 * confirm that a file exists to someone who cannot name it correctly.
 */
router.get('/media/:organizationId/:storageKey', async (req, res) => {
  const { organizationId, storageKey } = req.params;
  if (!verifyMessageMediaSignature(organizationId, storageKey, String(req.query.sig || ''))) {
    return res.status(404).json({ error: 'Not found' });
  }
  const body = await readMessageMedia(organizationId, storageKey);
  if (!body) return res.status(404).json({ error: 'Not found' });

  // Sniffed rather than trusted: the stored mime type came from Meta, and
  // echoing an attacker-influenced content type is how an image becomes script.
  res.setHeader('Content-Type', detectMimeType(body));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.send(body);
});

router.use(verifyToken);

/** The organization's Meta channel, or null. Never includes the access token. */
router.get('/meta', requireAdmin, async (_req, res) => {
  const channel = await getMetaChannel();
  res.json({ channel });
});

router.post('/meta/connect', requireAdmin, async (req: any, res) => {
  const refused = await channelRefusal(req.user!.organizationId, 'WHATSAPP_CLOUD');
  if (refused) {
    return res.status(402).json({
      error: refused.requiredPlan
        ? `باقة ${refused.planName} لا تشمل قناة واتساب الرسمية. رقّي إلى ${refused.requiredPlan} لتفعيلها.`
        : `باقة ${refused.planName} لا تشمل قناة واتساب الرسمية.`,
      code: 'PLAN_UPGRADE_REQUIRED',
      capability: 'WHATSAPP_CLOUD',
      requiredPlan: refused.requiredPlan,
    });
  }

  const outcome = await connectMetaChannel({
    phoneNumberId: req.body?.phoneNumberId,
    wabaId: req.body?.wabaId,
    businessPortfolioId: req.body?.businessPortfolioId,
    accessToken: req.body?.accessToken,
  });

  if (!outcome.ok) {
    await auditLog({
      userId: req.user?.id,
      action: 'channel.meta.connect.rejected',
      resource: 'OrganizationChannel',
      resourceId: 'WHATSAPP_CLOUD',
      // The failing step and code only. The submitted ids are not recorded on a
      // rejection: a mistyped "phone number id" is very often the access token
      // pasted into the wrong box, and an audit trail is the last place that
      // should be the first durable copy of someone's credential.
      description: `${outcome.problem.step}: ${outcome.problem.code}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    // 422, not 400. The request was well-formed; it was the credentials or the
    // Meta-side configuration that did not hold up.
    return res.status(422).json({
      error: outcome.problem.message,
      code: outcome.problem.code,
      step: outcome.problem.step,
    });
  }

  await auditLog({
    userId: req.user?.id,
    action: 'channel.meta.connect',
    resource: 'OrganizationChannel',
    resourceId: 'WHATSAPP_CLOUD',
    // Identifiers only. The token is never written anywhere but the vault.
    description: `phoneNumberId=${outcome.channel.phoneNumberId}`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  return res.json({
    channel: outcome.channel,
    // A connection that succeeded with a caveat still succeeded. The caveat is
    // reported alongside rather than as a failure, so the UI can show both.
    warning: outcome.warning
      ? { message: outcome.warning.message, code: outcome.warning.code, step: outcome.warning.step }
      : null,
  });
});

router.delete('/meta', requireAdmin, async (req: any, res) => {
  const removed = await disconnectMetaChannel();
  if (removed) {
    await auditLog({
      userId: req.user?.id,
      action: 'channel.meta.disconnect',
      resource: 'OrganizationChannel',
      resourceId: 'WHATSAPP_CLOUD',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
  }
  res.json({ removed });
});

/**
 * What the organization's channel can do.
 *
 * Not admin-only, unlike the rest of this file. The composer and the campaign
 * builder need it to decide what to offer an agent, and an agent who cannot
 * read it gets a UI that offers actions the server will refuse - which is the
 * failure this endpoint exists to prevent. Nothing here is a secret: it
 * describes the shape of the channel, never its credentials.
 */
router.get('/capabilities', async (_req, res) => {
  try {
    res.json({ capabilities: await channelCapabilities() });
  } catch (error) {
    // A workspace mid-switch, or with two active channels, has no single answer.
    // Reported as a named state rather than a 500, so the UI can say so.
    if (isChannelSendError(error)) {
      return res.status(409).json({
        error: error.userMessage,
        code: error.code,
        capabilities: null,
      });
    }
    throw error;
  }
});

/**
 * Choose which channel this workspace sends through.
 *
 * A switch, not a toggle: exactly one channel is active afterwards, and the
 * transaction behind it is why a send in flight never sees zero.
 */
router.post('/active', requireAdmin, async (req: any, res) => {
  const kind = String(req.body?.kind || '') as ChannelKind;
  if (kind !== 'OPENWA' && kind !== 'WHATSAPP_CLOUD') {
    return res.status(400).json({ error: 'نوع القناة غير معروف.', code: 'CHANNEL_KIND_UNKNOWN' });
  }

  // Activating a channel is the same grant as connecting one, so it is the
  // same gate. Checking only /meta/connect would leave a tenant able to switch
  // to a channel their edition does not include.
  const refused = await channelRefusal(req.user!.organizationId, kind);
  if (refused) {
    return res.status(402).json({
      error: refused.requiredPlan
        ? `باقة ${refused.planName} لا تشمل هذه القناة. رقّي إلى ${refused.requiredPlan} لتفعيلها.`
        : `باقة ${refused.planName} لا تشمل هذه القناة.`,
      code: 'PLAN_UPGRADE_REQUIRED',
      capability: kind,
      requiredPlan: refused.requiredPlan,
    });
  }

  try {
    await setActiveChannelKind(kind);
  } catch (error) {
    if (isChannelSendError(error)) {
      return res.status(422).json({ error: error.userMessage, code: error.code });
    }
    throw error;
  }

  await auditLog({
    userId: req.user?.id,
    action: 'channel.activated',
    resource: 'OrganizationChannel',
    resourceId: kind,
    description: `active channel set to ${kind}`,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  return res.json({ activeKind: kind, capabilities: await channelCapabilities() });
});

export default router;
