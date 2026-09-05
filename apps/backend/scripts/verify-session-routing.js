/**
 * An outbound message leaves through the gateway of the session it belongs to.
 *
 * ## Why this gate exists
 *
 * Until commit C1 the send path asked the *organization* which channel to use.
 * Two ACTIVE channels raised CHANNEL_AMBIGUOUS, because with two there was
 * genuinely no way to know which of a business's numbers a reply should leave
 * from — and guessing would answer a customer from a number they have never
 * seen. That is unrecoverable and reads as a scam.
 *
 * The invariant that made the guess safe was also the invariant that made a
 * Growth subscriber unable to run OpenWA on one number and Meta's Cloud API on
 * another. Both are gone: the binding lives on WhatsappSession, so ambiguity is
 * impossible by construction rather than caught.
 *
 * This gate builds the state that used to be forbidden — **one organization,
 * two ACTIVE channels of different kinds, two numbers, one bound to each** —
 * and asserts each number resolves its own gateway.
 *
 * ## Why it asserts capabilities and a window refusal, not a wire capture
 *
 * `channelCapabilities(sessionName)` runs `adapter(routingKey)`, which is the
 * one function that chooses a transport; its `kind` is the identity of the
 * adapter the send would use. So a wrong binding cannot pass it.
 *
 * The window assertion is the behavioural half. Meta refuses a first contact
 * outside the 24-hour window and OpenWA has no such rule, so one send raising
 * SERVICE_WINDOW_NEVER_OPENED while the other does not is the two adapters
 * being observably different — with no network and no mock, because
 * `assertSendable` refuses before any transport call.
 *
 * ## The second half: nothing new may be left unbound
 *
 * `WhatsappSession.channelId` is nullable, and the composite foreign key is
 * MATCH SIMPLE — Postgres skips the check entirely when the column is null, so
 * the constraint enforces nothing on precisely the rows that need watching.
 *
 * A null is legacy: migration 20261017090000 left one wherever an organization
 * had no channel to bind to. A null on a row created *after* that migration is
 * a creation path that forgot, and the send path will refuse that number
 * forever with SESSION_NOT_BOUND. The migration's audit row carries the
 * timestamp that tells the two apart; without it this check fails loudly rather
 * than passing on no evidence.
 */
require('./load-env');

const assert = require('assert');
const crypto = require('crypto');

const { prisma } = require('../dist/prisma');
const { runAsPlatform, runAsOrganization } = require('../dist/lib/tenant-context');
const { encryptCredential } = require('../dist/lib/credential-crypto');
const {
  ChannelService,
  channelCapabilities,
  isChannelSendError,
} = require('../dist/modules/channels/channel.service');
const { loadEditionCatalogueOrThrow } = require('../dist/modules/billing/editions.service');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

/** The ChannelSendError code a call raised, or null if it did not raise one. */
async function sendErrorCode(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return isChannelSendError(error) ? error.code : `NOT_A_CHANNEL_ERROR:${error && error.message}`;
  }
}

const stamp = Date.now();
const orgId = `route_org_${stamp}`;
const wsId = `ws_${orgId}`;

async function seed() {
  return runAsPlatform('verify-session-routing:seed', async () => {
    await prisma.organization.create({
      data: { id: orgId, name: `Routing Gate ${stamp}`, slug: `routing-gate-${stamp}`, status: 'ACTIVE' },
    });
    await prisma.workspace.create({
      data: { id: wsId, organizationId: orgId, name: 'Routing Gate', isDefault: true },
    });
    await prisma.organizationConfig.create({ data: { organizationId: orgId } });

    // Both ACTIVE at once. This is the state that used to raise
    // CHANNEL_AMBIGUOUS on every send, and it is the state a Growth subscriber
    // is sold.
    const openwa = await prisma.organizationChannel.create({
      data: {
        organizationId: orgId,
        kind: 'OPENWA',
        baseUrl: 'http://127.0.0.1:1/openwa-gate',
        apiKeyEnc: encryptCredential('routing-gate-key'),
        webhookToken: `route_token_openwa_${stamp}`,
        status: 'ACTIVE',
        managedByProvisioner: false,
      },
    });
    const meta = await prisma.organizationChannel.create({
      data: {
        organizationId: orgId,
        kind: 'WHATSAPP_CLOUD',
        baseUrl: 'https://graph.facebook.com/v21.0',
        apiKeyEnc: '',
        webhookToken: `route_token_meta_${stamp}`,
        status: 'ACTIVE',
        managedByProvisioner: false,
      },
    });
    await prisma.metaChannelCredential.create({
      data: {
        organizationId: orgId,
        channelId: meta.id,
        phoneNumberId: `pn_${stamp}`,
        wabaId: `waba_${stamp}`,
        accessTokenEnc: encryptCredential('routing-gate-token'),
        status: 'ACTIVE',
      },
    });

    const sessions = {};
    for (const [key, channelId, name] of [
      ['openwa', openwa.id, `route-openwa-${stamp}`],
      ['meta', meta.id, `meta-pn_${stamp}`],
      ['unbound', null, `route-unbound-${stamp}`],
    ]) {
      sessions[key] = await prisma.whatsappSession.create({
        data: {
          organizationId: orgId,
          workspaceId: wsId,
          channelId,
          sessionName: name,
          label: key,
          isActive: false,
        },
        select: { id: true, sessionName: true },
      });
    }
    return { openwa, meta, sessions };
  });
}

async function cleanup() {
  await runAsPlatform('verify-session-routing:cleanup', async () => {
    // Sessions before channels: the foreign key is RESTRICT, which is the point
    // of it — a gateway numbers are bound to is not one anybody may delete out
    // from under them, and that includes this script.
    await prisma.whatsappSession.deleteMany({ where: { organizationId: orgId } });
    await prisma.metaChannelCredential.deleteMany({ where: { organizationId: orgId } });
    await prisma.organizationChannel.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
  });
}

async function main() {
  /*
    Without this every entitlement read serves the restricted floor, so the
    OpenWA send below would be refused on quota rather than reaching its
    transport — and "not refused by a service window" would be true for the
    wrong reason. The assertion is about which adapter was chosen; it has to
    fail on the transport, not on a limit.
  */
  await loadEditionCatalogueOrThrow();

  const fixture = await seed();

  try {
    await runAsOrganization(orgId, async () => {
      /* ── 1. each number resolves its own gateway ───────────────────────── */
      const openwaCaps = await channelCapabilities(fixture.sessions.openwa.sessionName);
      const metaCaps = await channelCapabilities(fixture.sessions.meta.sessionName);

      check('the OpenWA number resolves the OpenWA gateway',
        openwaCaps.kind === 'OPENWA', openwaCaps.kind);
      check('the Meta number resolves the Meta gateway, with both channels ACTIVE',
        metaCaps.kind === 'WHATSAPP_CLOUD', metaCaps.kind);
      check('  …so two ACTIVE channels under one organization is no longer ambiguous',
        openwaCaps.kind !== metaCaps.kind,
        'both numbers resolved ' + openwaCaps.kind);

      /* ── 2. the two adapters are observably different ──────────────────── */
      check('the Meta adapter carries its service window',
        metaCaps.requiresServiceWindow === true, String(metaCaps.requiresServiceWindow));
      check('the OpenWA adapter carries none',
        openwaCaps.requiresServiceWindow === false, String(openwaCaps.requiresServiceWindow));

      const metaSend = await sendErrorCode(() =>
        ChannelService.sendText(fixture.sessions.meta.sessionName, '+972500000777', 'gate'));
      check('a first send on the Meta number is refused by its 24-hour window',
        metaSend === 'SERVICE_WINDOW_NEVER_OPENED', String(metaSend));

      const openwaSend = await sendErrorCode(() =>
        ChannelService.sendText(fixture.sessions.openwa.sessionName, '+972500000777', 'gate'));
      check('the same send on the OpenWA number is not refused by any window',
        openwaSend !== 'SERVICE_WINDOW_NEVER_OPENED' && openwaSend !== 'SERVICE_WINDOW_CLOSED',
        String(openwaSend));

      /* ── 3. an unbound number is refused, never guessed ────────────────── */
      const unbound = await sendErrorCode(() =>
        ChannelService.sendText(fixture.sessions.unbound.sessionName, '+972500000777', 'gate'));
      check('an unbound number refuses by name rather than falling back',
        unbound === 'SESSION_NOT_BOUND', String(unbound));

      const unknown = await sendErrorCode(() =>
        ChannelService.sendText(`route-nonexistent-${stamp}`, '+972500000777', 'gate'));
      check('an unknown session name refuses by name too',
        unknown === 'SESSION_UNKNOWN', String(unknown));

      /* ── 4. a switched-off gateway is named, not reported as a fault ───── */
      await runAsPlatform('verify-session-routing:deactivate', () =>
        prisma.organizationChannel.update({
          where: { id: fixture.openwa.id },
          data: { status: 'INACTIVE' },
        }));

      const deactivated = await sendErrorCode(() =>
        ChannelService.sendText(fixture.sessions.openwa.sessionName, '+972500000777', 'gate'));
      check('a number whose gateway is switched off is named, not reported as a gateway fault',
        deactivated === 'CHANNEL_NOT_ACTIVE',
        String(deactivated) + ' — without this the OpenWA transport raises "Active OpenWA channel is not configured", which sends an agent to debug a gateway that is fine');
    });

  } finally {
    await cleanup();
  }

  /*
    Deliberately after cleanup.

    This gate creates an unbound session on purpose, to prove the send path
    refuses one — so counting while the fixture is still in the table counts
    the fixture and fails on it. Asked after the fixture is gone, the question
    is about the real world, which is the only version of it worth answering.
  */
  await unboundCensus();

  await prisma.$disconnect();

  console.log('');
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

async function unboundCensus() {
  await runAsPlatform('verify-session-routing:unbound-audit', async () => {
    const backfill = await prisma.platformAuditLog.findFirst({
      where: { action: 'whatsapp-session.channel-backfilled' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true, afterState: true },
    });

    if (!backfill) {
      check('the backfill audit row exists, so legacy nulls can be told from new ones',
        false,
        'no whatsapp-session.channel-backfilled row — without it this check cannot distinguish a pre-existing null from a creation path that forgot, and passing would be passing on no evidence');
      return;
    }
    check('the backfill audit row exists, so legacy nulls can be told from new ones', true);

    const legacy = await prisma.whatsappSession.count({
      where: { channelId: null, createdAt: { lte: backfill.timestamp } },
    });
    const created = await prisma.whatsappSession.count({
      where: { channelId: null, createdAt: { gt: backfill.timestamp } },
    });

    check('no session created after the backfill is unbound',
      created === 0,
      created + ' unbound session(s) created after ' + backfill.timestamp.toISOString()
        + ' — a creation path is not setting channelId, and the composite FK cannot catch it because it is MATCH SIMPLE');

    console.log('       legacy unbound rows, left by the backfill: ' + legacy
      + ' (recorded leftNull: ' + (backfill.afterState && backfill.afterState.leftNull) + ')');
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
