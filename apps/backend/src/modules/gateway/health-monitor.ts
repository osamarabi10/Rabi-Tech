import axios from 'axios';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import { OpenWARawSend, OpenWAService } from '../whatsapp/openwa.service';
import { isConnectedStatus } from '../provisioning/gateway-provider';
import { decryptCredential } from '../../lib/credential-crypto';

/**
 * Gateway health monitoring (H1).
 *
 * The point is to stop learning about outages from customers. The runbook's
 * central fact shapes the whole design: **inbound-broken and outbound-broken are
 * separate faults**, and the outage that actually happened was outbound
 * returning 500 while the session reported perfectly healthy.
 *
 * So there are two probes, at deliberately different frequencies:
 *
 * - **`status`** — one HTTP call to the gateway. Costs nothing, sends nothing,
 *   runs every few minutes. Catches a dead session, a disconnected number, a
 *   stopped container. This does the day-to-day work.
 *
 * - **`selfSend`** — a real WhatsApp message, sent to the channel's **own**
 *   number. This is an INTERNAL PROBE: it is platform traffic, not the
 *   subscriber's, it is never sent to a customer, and it exists only to exercise
 *   the outbound path that `status` cannot see. It runs rarely because a real
 *   message is not free: on an unofficial gateway, frequent identical automated
 *   messages are how a number gets banned, and the number at risk is the one the
 *   platform runs on.
 *
 * The self-send is marked `internal`, which bypasses metering entirely — see
 * `OutboundUsageOptions.internal`. Without that, a 15-minute probe would consume
 * roughly 2,880 messages a month against a Free plan's 100, and would be blocked
 * by the quota ceiling exactly when the system was most stressed.
 */

export type HealthProbe = 'status' | 'selfSend';

export type HealthOutcome = 'ok' | 'failed' | 'skipped';

export type HealthResult = {
  organizationId: string;
  probe: HealthProbe;
  outcome: HealthOutcome;
  /** Why the organization was skipped. Never a fault. */
  reason?: string;
  error?: string;
  latencyMs: number;
};

/**
 * The message body of a self-send probe.
 *
 * Deliberately unbranded. It lands in the subscriber's own WhatsApp as a
 * message-to-self, and a white-label platform should not put its own name on a
 * subscriber's device. It says what it is so nobody who sees it has to guess.
 */
const PROBE_BODY = '🔍 فحص اتصال تلقائي — لا حاجة لأي إجراء';

/** Rows older than this are swept; nothing reads them. */
const RETENTION_DAYS = 7;

/** How many recent results the failure rule considers. */
const WINDOW_SIZE = 3;

/** Failures within the window that trigger an alert. */
const FAILURE_THRESHOLD = 2;

export const ALERT_TYPE = 'GATEWAY_UNHEALTHY';

/**
 * Provisioning states that mean "not connected on purpose".
 *
 * Alerting on these would produce a permanent CRITICAL alert for every
 * suspended subscriber, which is how an alert channel becomes noise nobody
 * reads.
 */
const NOT_A_FAULT = new Set(['PENDING', 'PROVISIONING', 'AWAITING_QR', 'SUSPENDED']);

type Candidate = {
  organizationId: string;
  organizationName: string;
  sessionName: string;
  phoneNumber: string | null;
};

/**
 * Organizations worth probing.
 *
 * Runs in platform scope because it is inherently cross-tenant; every probe it
 * hands out then runs inside that organization's own scope.
 */
async function eligibleOrganizations(): Promise<Candidate[]> {
  const organizations = await prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        channels: {
          where: { kind: 'OPENWA' },
          select: { provisioningState: true, status: true },
        },
        whatsappSessions: {
          where: { isActive: true },
          select: { sessionName: true, phoneNumber: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const candidates: Candidate[] = [];
    for (const organization of organizations) {
      const channel = organization.channels[0];
      if (!channel) continue;
      if (NOT_A_FAULT.has(String(channel.provisioningState))) continue;
      // One session per org, the oldest active one. Probing every session would
      // multiply gateway load for no extra signal — if the gateway is down, one
      // session tells you.
      const session = organization.whatsappSessions[0];
      if (!session) continue;
      candidates.push({
        organizationId: organization.id,
        organizationName: organization.name,
        sessionName: session.sessionName,
        phoneNumber: session.phoneNumber,
      });
    }
  return candidates;
}

/** Record one probe result. Runs inside the organization's own scope. */
async function record(
  organizationId: string,
  probe: HealthProbe,
  ok: boolean,
  latencyMs: number,
  error?: string,
): Promise<void> {
  await prisma.gatewayHealthCheck.create({
    data: {
      organizationId,
      probe,
      ok,
      latencyMs,
      // Gateway errors can be enormous HTML bodies; the useful part is the head.
      error: error ? error.slice(0, 500) : null,
    },
  });
}

/**
 * Whether the recent history is bad enough to alert on.
 *
 * Reads only the same probe kind. Mixing a failed self-send with two healthy
 * status polls would mask exactly the fault the self-send exists to find.
 */
async function shouldAlert(organizationId: string, probe: HealthProbe): Promise<boolean> {
  const recent = await prisma.gatewayHealthCheck.findMany({
    where: { organizationId, probe },
    orderBy: { createdAt: 'desc' },
    take: WINDOW_SIZE,
    select: { ok: true },
  });
  const failures = recent.filter((row) => !row.ok).length;
  return failures >= FAILURE_THRESHOLD;
}

/**
 * Raise or update the alert for one organization.
 *
 * Never opens a second alert: at five-minute polling a three-day outage would
 * otherwise produce close to nine hundred of them, and an alert list nobody can
 * read is the same as no alert list.
 */
async function raiseAlert(candidate: Candidate, probe: HealthProbe, error: string): Promise<void> {
  const open = await prisma.platformAlert.findFirst({
      where: { organizationId: candidate.organizationId, type: ALERT_TYPE, resolvedAt: null },
      select: { id: true },
    });

    const metadata = {
      probe,
      lastError: error.slice(0, 500),
      sessionName: candidate.sessionName,
      observedAt: new Date().toISOString(),
    };

    if (open) {
      await prisma.platformAlert.update({ where: { id: open.id }, data: { metadata } });
      return;
    }

    await prisma.platformAlert.create({
      data: {
        organizationId: candidate.organizationId,
        type: ALERT_TYPE,
        severity: 'CRITICAL',
        message: `WhatsApp gateway unhealthy for ${candidate.organizationName} (${probe} probe)`,
        metadata,
      },
    });

    // Until Slack or email exists, the log is the notification. Marked so it can
    // be grepped and alerted on by whatever watches the container logs.
    logger.error('[GATEWAY_UNHEALTHY] gateway probe failing', {
      organizationId: candidate.organizationId,
      organization: candidate.organizationName,
      probe,
      error: error.slice(0, 500),
    });
}

/**
 * Close any open alert after a good result.
 *
 * Resolved, never deleted — the history is the only record that the outage
 * happened and how long it lasted.
 */
async function resolveAlerts(organizationId: string): Promise<number> {
  const { count } = await prisma.platformAlert.updateMany({
      where: { organizationId, type: ALERT_TYPE, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    if (count) {
      logger.info('[GATEWAY_RECOVERED] gateway probe healthy again', { organizationId, resolved: count });
    }
    return count;
}

/**
 * A channel that answers a probe is not in a failed state.
 *
 * `provisioningState` was only ever set back to ACTIVE by provisioning
 * itself or by an owner editing the channel by hand. So a gateway that failed
 * once and then started working kept saying FAILED for ever — the console
 * showed a red row, a failure reason from weeks ago, and a "retry
 * provisioning" button, for a subscriber whose WhatsApp was fine.
 *
 * Found on a live subscriber whose stored credentials answered `/api/sessions`
 * with a 200 while the console reported "OpenWA did not become ready: 401"
 * from an attempt against a container that no longer exists.
 *
 * Deliberately narrow: only FAILED is cleared. PENDING, PROVISIONING,
 * AWAITING_QR and SUSPENDED all mean something a successful probe does not
 * contradict — a suspended channel that still answers is still suspended.
 */
async function clearStaleFailure(organizationId: string): Promise<boolean> {
  const updated = await prisma.organizationChannel.updateMany({
    where: { organizationId, kind: 'OPENWA', provisioningState: 'FAILED' },
    data: {
      provisioningState: 'ACTIVE',
      failureReason: null,
      failureStep: null,
    },
  });

  if (updated.count > 0) {
    logger.info('Cleared a stale gateway failure after a successful probe', {
      organizationId,
    });
  }
  return updated.count > 0;
}

async function runProbe(candidate: Candidate, probe: HealthProbe): Promise<HealthResult> {
  const startedAt = Date.now();
  const base = { organizationId: candidate.organizationId, probe };

  if (probe === 'selfSend' && !candidate.phoneNumber) {
    // No number means the QR has never been scanned. Not a fault, and retrying
    // forever would alert on a subscriber who has simply not finished setup.
    return { ...base, outcome: 'skipped', reason: 'session has no phone number', latencyMs: 0 };
  }

  try {
    await runAsOrganization(candidate.organizationId, async () => {
      if (probe === 'status') {
        const response = await OpenWAService.getStatus(candidate.sessionName);
        // A 200 is not health. The gateway answers happily while reporting a
        // dead session — which is precisely the shape of fault this feature
        // exists to catch, and checking only for a thrown error would miss it.
        // Reuses the provisioning module's vocabulary so both agree on what
        // "connected" means.
        const state = (response as { data?: { status?: unknown; state?: unknown } })?.data;
        const reported = state?.status ?? state?.state;
        if (!isConnectedStatus(reported)) {
          throw new Error(`session reported status "${String(reported ?? 'unknown')}"`);
        }
        return;
      }
      // INTERNAL PROBE. Destination is our own number. This goes through the
      // raw OpenWA transport rather than ChannelService: it is a probe of the
      // gateway itself, not a message from the tenant, and the raw path does no
      // metering at all - so it cannot bill a subscriber for our health check.
      await OpenWARawSend.sendText(
        candidate.sessionName,
        candidate.phoneNumber!,
        PROBE_BODY,
      );
    });
    const latencyMs = Date.now() - startedAt;
    await runAsOrganization(candidate.organizationId, () =>
      record(candidate.organizationId, probe, true, latencyMs));
    await resolveAlerts(candidate.organizationId);
    // The alert is resolved above; this clears the row that was still
    // asserting the fault the alert was about.
    await clearStaleFailure(candidate.organizationId);
    return { ...base, outcome: 'ok', latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = (error as Error)?.message || String(error);
    await runAsOrganization(candidate.organizationId, () =>
      record(candidate.organizationId, probe, false, latencyMs, message));

    const alerting = await runAsOrganization(candidate.organizationId, () =>
      shouldAlert(candidate.organizationId, probe));
    if (alerting) {
      await raiseAlert(candidate, probe, message);
    } else {
      // One failure is not an outage. Transient network blips are common enough
      // that alerting on the first one trains people to ignore the alert.
      logger.warn('Gateway probe failed (below alert threshold)', {
        organizationId: candidate.organizationId,
        probe,
        error: message,
      });
    }
    return { ...base, outcome: 'failed', error: message, latencyMs };
  }
}

/** Probe one organization by id, for the manual endpoint. */
export async function probeOrganization(
  organizationId: string,
  probe: HealthProbe,
): Promise<HealthResult> {
  return runAsPlatform(`gateway-health:manual:${probe}`, async () => {
  const candidates = await eligibleOrganizations();
  const candidate = candidates.find((entry) => entry.organizationId === organizationId);
  if (!candidate) {
    return {
      organizationId,
      probe,
      outcome: 'skipped',
      reason: 'no active gateway, or the channel is suspended or still provisioning',
      latencyMs: 0,
    };
  }
  return runProbe(candidate, probe);
  });
}

/**
 * Clear provisioning failures that are no longer true.
 *
 * Separate from the session probes above, because it answers a different
 * question. Those ask "is this subscriber's WhatsApp number connected"; this
 * asks "is their gateway reachable at all" — and only the second one decides
 * whether a *provisioning* failure still stands.
 *
 * That distinction is what left a real subscriber stuck. Their channel said
 * FAILED with a 401 from an attempt against a container that no longer
 * exists, while the credentials in that same row answered `/api/sessions`
 * with a 200. It could never self-heal: the session probe skips any
 * organization with no active session, their number was disconnected, so
 * nothing ever re-examined the claim. The console showed a red row and a
 * failure reason from weeks earlier for a gateway that was fine.
 *
 * Only FAILED is touched. PENDING, PROVISIONING and AWAITING_QR are states a
 * reachable gateway does not contradict — a channel waiting for a QR is still
 * waiting for one — and SUSPENDED is a decision, not a fault.
 */
export async function reconcileProvisioningFailures(): Promise<{
  checked: number;
  cleared: number;
}> {
  return runAsPlatform('gateway-health:reconcile-failures', async () => {
    const failed = await prisma.organizationChannel.findMany({
      where: { kind: 'OPENWA', provisioningState: 'FAILED' },
      select: { id: true, organizationId: true, baseUrl: true, apiKeyEnc: true },
    });

    let cleared = 0;
    for (const channel of failed) {
      if (!channel.baseUrl) continue;
      try {
        // One attempt, short timeout. This runs on a schedule; a provider
        // that needs sixty seconds of retries to answer is not healthy, and
        // waiting that long per subscriber would stall the whole pass.
        await axios.get(`${channel.baseUrl}/api/sessions`, {
          headers: { 'X-API-Key': decryptCredential(channel.apiKeyEnc) },
          timeout: 8_000,
        });
      } catch {
        // Still unreachable. The failure stands, and stays on the row.
        continue;
      }

      await prisma.organizationChannel.update({
        where: { id: channel.id },
        data: { provisioningState: 'ACTIVE', failureReason: null, failureStep: null },
      });
      await resolveAlerts(channel.organizationId);
      cleared += 1;
      logger.info('Cleared a stale gateway provisioning failure', {
        organizationId: channel.organizationId,
      });
    }

    return { checked: failed.length, cleared };
  });
}

/** Probe every eligible organization. Called by the repeatable job. */
export async function runHealthChecks(
  probe: HealthProbe,
): Promise<{ checked: number; failed: number; skipped: number }> {
  // ONE platform scope for the whole cycle, not one per organization.
  //
  // Every runAsPlatform() writes a PlatformAuditLog row. Opening a scope per
  // org per probe would add hundreds of rows a day of pure routine noise to the
  // same table that records platform-owner commercial changes — burying the
  // entries someone actually needs to find.
  return runAsPlatform(`gateway-health:${probe}`, async () => {
    const candidates = await eligibleOrganizations();
    let failed = 0;
    let skipped = 0;

    // Sequential on purpose. These calls all hit one gateway process, and
    // firing every subscriber's probe at it simultaneously would be a load
    // spike capable of causing the failure it is trying to detect.
    for (const candidate of candidates) {
      const result = await runProbe(candidate, probe);
      if (result.outcome === 'failed') failed += 1;
      if (result.outcome === 'skipped') skipped += 1;
    }

    // A gateway that has come back deserves its row corrected in the same
    // pass that would have alerted about it.
    await reconcileProvisioningFailures().catch((error) =>
      logger.error('Failed to reconcile provisioning failures', { error: String(error) }),
    );

    return { checked: candidates.length, failed, skipped };
  });
}

/** Drop probe rows past the retention window. */
export async function sweepHealthChecks(): Promise<number> {
  return runAsPlatform('gateway-health:sweep', async () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const { count } = await prisma.gatewayHealthCheck.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  });
}
