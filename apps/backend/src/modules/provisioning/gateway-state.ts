import { GatewayProvisioningState } from '@prisma/client';
import logger from '../../lib/logger';
import { runAsPlatform } from '../../lib/tenant-context';
import { prisma } from '../../prisma';

/**
 * The one place a gateway observation becomes channel state.
 *
 * Four components watch a gateway — the provisioning worker's monitor step, the
 * `session.disconnected` webhook, the health monitor's probes, and the
 * reconcile loop that schedules the first of those. Until 2026-09-06 every one
 * of them could see a disconnect and **not one wrote it down**:
 *
 *   - the health monitor raised a `PlatformAlert` and left the row alone;
 *   - the webhook emitted a socket event and queued a monitor only for
 *     *connect*-ish states;
 *   - `monitorConnection` touched `lastCheckedAt` and returned false;
 *   - the reconcile loop did not select ACTIVE channels at all, so a live
 *     tenant was never monitored again after it paired.
 *
 * Meanwhile two separate places promoted `FAILED -> ACTIVE` on a good probe.
 * The state machine only ever climbed. A tenant whose WhatsApp dropped kept a
 * channel reading ACTIVE for ever, the product kept saying Connected, and every
 * send failed silently — observed on organization `mark`, paired 07:02,
 * dropped by 07:27, still ACTIVE at 11:00 with `lastCheckedAt` frozen at the
 * moment it connected.
 *
 * That is the mirror of the defect that opened the 2026-09-05 session, where
 * the product said Disconnected for a gateway that was paired. This direction
 * is worse: the customer believes it.
 *
 * Fixing one branch would have left three. This module is the mechanism, and
 * all four call it.
 */

/** Session states that mean a human has a working WhatsApp link. */
const CONNECTED = ['connected', 'authenticated', 'working', 'ready'];

/**
 * States that mean, definitely, that there is no pairing right now.
 *
 * `qr_ready` is the important one: the gateway is displaying a QR code, which
 * is precisely "somebody must scan this again".
 */
const UNPAIRED = ['qr_ready', 'disconnected', 'failed', 'action_required', 'stopped'];

/**
 * States that are on the way somewhere and mean nothing yet.
 *
 * Demoting on these would flap a healthy tenant every time its container
 * restarted, so they are treated as no evidence at all — as is an unreachable
 * gateway, which says the container is down, not that the pairing is gone. A
 * gateway that is merely unreachable does not need a human with a phone; a
 * `qr_ready` one does, and that difference is the whole point of the split.
 */
const TRANSIENT = ['created', 'initializing', 'starting', 'authenticating'];

export type ObservationSource = 'monitor' | 'webhook' | 'health-probe';

export interface GatewayObservation {
  /** The gateway's own status word, when we have one. */
  reported?: string | null;
  /** Set when the observation is an authoritative event rather than a poll. */
  connected?: boolean;
  source: ObservationSource;
}

export type ObservationOutcome = 'promoted' | 'demoted' | 'unchanged' | 'no-evidence';

export function isConnectedState(value: unknown): boolean {
  return CONNECTED.includes(String(value ?? '').toLowerCase());
}

export function isUnpairedState(value: unknown): boolean {
  return UNPAIRED.includes(String(value ?? '').toLowerCase());
}

export function isTransientState(value: unknown): boolean {
  return TRANSIENT.includes(String(value ?? '').toLowerCase());
}

/**
 * Promote a channel to ACTIVE and resolve what the outage opened.
 *
 * Exported because provisioning's own success path is the same transition, and
 * two copies of it is how the promote and demote halves drifted apart in the
 * first place.
 */
export async function markGatewayActive(organizationId: string): Promise<void> {
  await runAsPlatform(`gateway-state:${organizationId}:connected`, async () => {
    await prisma.$transaction(async (tx) => {
      await tx.organizationChannel.update({
        where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
        data: {
          status: 'ACTIVE',
          provisioningState: 'ACTIVE',
          provisioningStep: 'COMPLETE',
          failureReason: null,
          failureStep: null,
          connectedAt: new Date(),
          lastCheckedAt: new Date(),
          suspendedAt: null,
        },
      });
      await tx.organization.update({ where: { id: organizationId }, data: { status: 'ACTIVE' } });
      await tx.platformAlert.updateMany({
        where: { organizationId, type: 'GATEWAY_PROVISIONING_FAILED', resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
    });
  });
}

/**
 * Record what a gateway was just observed to be doing.
 *
 * Returns what it changed, so a caller can log or count it. Writes nothing when
 * the observation carries no evidence about pairing.
 *
 * **Only ACTIVE is demoted.** PENDING, PROVISIONING, AWAITING_QR, SUSPENDED and
 * FAILED all already mean something an unpaired reading does not contradict —
 * the same reasoning `clearStaleFailure` gives for only ever clearing FAILED.
 * A suspended gateway that reports no session is still suspended.
 *
 * The demotion target is AWAITING_QR rather than FAILED because it is the
 * truth: the gateway is up and asking to be scanned. It also puts the channel
 * back under the pairing window, so a tenant nobody re-scans is eventually
 * retired with a reason instead of being polled for ever.
 */
export async function recordGatewayObservation(
  organizationId: string,
  observation: GatewayObservation,
): Promise<ObservationOutcome> {
  const { reported, source } = observation;
  const connected = observation.connected ?? isConnectedState(reported);
  const unpaired = observation.connected === false || isUnpairedState(reported);

  if (!connected && !unpaired) {
    // Transient, unknown, or the gateway did not answer. Not evidence.
    return 'no-evidence';
  }

  return runAsPlatform(`gateway-state:${organizationId}:observe`, async () => {
    const channel = await prisma.organizationChannel.findFirst({
      where: { organizationId, kind: 'OPENWA' },
      select: { id: true, provisioningState: true },
    });
    if (!channel) return 'no-evidence' as ObservationOutcome;

    if (connected) {
      if (channel.provisioningState === GatewayProvisioningState.ACTIVE) {
        await prisma.organizationChannel.update({
          where: { id: channel.id },
          data: { lastCheckedAt: new Date() },
        });
        return 'unchanged';
      }
      await markGatewayActive(organizationId);
      logger.info('Gateway observed connected; channel promoted', {
        organizationId, source, from: channel.provisioningState, reported: reported ?? null,
      });
      return 'promoted';
    }

    if (channel.provisioningState !== GatewayProvisioningState.ACTIVE) {
      await prisma.organizationChannel.update({
        where: { id: channel.id },
        data: { lastCheckedAt: new Date() },
      });
      return 'unchanged';
    }

    await prisma.organizationChannel.update({
      where: { id: channel.id },
      data: {
        provisioningState: GatewayProvisioningState.AWAITING_QR,
        provisioningStep: 'AWAIT_CONNECTION',
        status: 'PENDING',
        lastCheckedAt: new Date(),
        failureStep: null,
        failureReason:
          'The WhatsApp session is no longer connected. Scan the QR code again to reconnect this number.',
      },
    });
    // Loud on purpose: this is a paying tenant who can no longer send or
    // receive, and until this existed the only trace was a probe warning.
    logger.warn('[GATEWAY_DISCONNECTED] channel demoted from ACTIVE', {
      organizationId, source, reported: reported ?? null,
    });
    return 'demoted';
  });
}
