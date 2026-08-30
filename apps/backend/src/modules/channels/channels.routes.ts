import { Router } from 'express';
import { auditLog } from '../../lib/audit';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { ChannelKind } from './channel.types';
import { channelCapabilities, isChannelSendError, setActiveChannelKind } from './channel.service';
import { verifyToken } from '../auth/auth.middleware';
import {
  connectMetaChannel,
  disconnectMetaChannel,
  getMetaChannel,
} from './meta.service';

/**
 * Tenant-facing channel configuration.
 *
 * Admin-only throughout. Connecting a channel hands this platform a credential
 * that sends as the business to its own customers; that is not a supervisor's
 * decision, and reading the connection reveals which number the workspace
 * operates from.
 */
const router = Router();

router.use(verifyToken);

/** The organization's Meta channel, or null. Never includes the access token. */
router.get('/meta', requireAdmin, async (_req, res) => {
  const channel = await getMetaChannel();
  res.json({ channel });
});

router.post('/meta/connect', requireAdmin, async (req: any, res) => {
  const outcome = await connectMetaChannel({
    phoneNumberId: req.body?.phoneNumberId,
    wabaId: req.body?.wabaId,
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
