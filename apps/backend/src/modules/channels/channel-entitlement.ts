import { prisma } from '../../prisma';
import { cheapestUpgradeGranting, getEdition } from '../billing/editions.service';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { ChannelKind } from './channel.types';

/**
 * May this workspace *obtain* a channel of this kind?
 *
 * `allowedChannels` was enforced at exactly two call sites — `/channels/connect`
 * for Meta and `/channels/active` for the switch — while the two paths a
 * workspace actually takes to get a working OpenWA number, gateway provisioning
 * and the QR pairing endpoint, asked nothing about the edition. The switch was
 * guarded and the front door was not.
 *
 * The consequence was not theoretical. GROWTH, BUSINESS and ENTERPRISE carry
 * `autoProvisionGateway: true` with `allowedChannels: ['WHATSAPP_CLOUD']`, so a
 * workspace on any of them had an OpenWA gateway built for it automatically,
 * reached AWAITING_QR, and — because nothing checked — could be paired and sent
 * through normally. That is why trials appeared to work at all while Meta was
 * unconfigured: they were running on a channel the edition forbade and nothing
 * enforced. See D-26 and D-27.
 *
 * ## The grandfather rule, and why it is not an oversight
 *
 * A channel that is already ACTIVE is always permitted, whatever the edition
 * says. Enforcing this retroactively would disconnect live workspaces — ostudio
 * is on ENTERPRISE, which is Meta-only, and has a working OpenWA channel it has
 * been sending through. Cutting off a paying subscriber to correct a rule they
 * never broke is a worse outcome than the inconsistency, and it is not a
 * decision an entitlement check should make on its own.
 *
 * So this bounds the *future*: no new workspace can obtain a channel its edition
 * forbids, and every existing one keeps working. Closing the remaining gap means
 * migrating the affected subscribers deliberately, which is a commercial act
 * rather than a code change.
 */
export type ChannelGrantRefusal = {
  planName: string;
  requiredPlan: string | null;
  kind: ChannelKind;
};

/** Is there already a live channel of this kind? Established rights win. */
async function alreadyEstablished(organizationId: string, kind: ChannelKind): Promise<boolean> {
  const active = await prisma.organizationChannel.findFirst({
    where: { organizationId, kind, status: 'ACTIVE' },
    select: { id: true },
  });
  return active !== null;
}

/**
 * Null when the workspace may have this channel, a refusal when it may not.
 *
 * Deliberately mirrors `channelRefusal` in channels.routes.ts rather than
 * replacing it: that one answers for a *request* the admin just made and can
 * name an upgrade in the response, this one also answers for provisioning,
 * which happens with nobody watching. The upgrade suggestion is carried anyway
 * so the QR endpoint can render the same sentence the switch does.
 */
export async function channelGrantRefusal(
  organizationId: string,
  kind: ChannelKind,
): Promise<ChannelGrantRefusal | null> {
  if (await alreadyEstablished(organizationId, kind)) return null;

  const effective = await resolveEntitlements(organizationId);
  if (getEdition(effective.plan).allowedChannels.includes(kind)) return null;

  return {
    planName: effective.planName,
    requiredPlan: cheapestUpgradeGranting(effective.plan, (edition) =>
      edition.allowedChannels.includes(kind),
    ),
    kind,
  };
}
