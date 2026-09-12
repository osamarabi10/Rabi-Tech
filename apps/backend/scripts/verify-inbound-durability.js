/**
 * An inbound message that was not durably accepted must not be reported as accepted.
 *
 * ## Why this gate exists
 *
 * `queueIncomingMessage` catches every enqueue failure and returns
 * (`incoming-message.worker.ts`). Its comment — "Don't throw — webhook already
 * returned 200 to OpenWA" — is false: the call is awaited inside the webhook
 * handler, *before* the response is sent.
 *
 * The consequence is not that the failure goes unrecorded. It is worse. The
 * webhook's own catch exists to record exactly this case, and says so:
 * "Inbound health that read only the response code would show a flawless 100%
 * while every message was being dropped." Because the enqueue failure never
 * reaches that catch, `recordDelivery` runs on the success path instead and
 * writes ok=true, statusCode=200 for a message nothing will ever process.
 *
 * So a Redis fault does not merely lose a customer's first message to a
 * business. It files that loss as a delivered message. The instrument reports
 * the opposite of what happened, which is the one defect shape this project
 * keeps paying for.
 *
 * ## Why it asserts a non-2xx response, and not only the log row
 *
 * Answering 200 also discards a durability guarantee the sender already
 * provides. Read out of the running gateway image (openwa 0.23.2), not from
 * documentation:
 *
 *   - `dist/modules/webhook/utils/deliver-once.js` — `if (!ok) throw new
 *     Error('HTTP ${status}: ${statusText}')`. A non-2xx response throws.
 *   - `dist/modules/webhook/webhook-delivery.service.js` — that throw is caught
 *     and, while `attempt < webhook.retryCount`, it sleeps `retryDelay *
 *     attempt` and re-posts. This platform registers `retryCount: 3`
 *     (`openwa.service.ts`), so a 503 buys three attempts.
 *   - `webhook-outbox.service.js` / `webhook-reconciler.service.js` — the event
 *     is held as state 'pending' and a sweep replays stale rows with their
 *     stored payload and idempotency key.
 *
 * Redelivery is safe here because the queue job id is
 * `${organizationId}--${waMessageId}`: the same message cannot be processed
 * twice. Answering 200 to an enqueue that failed therefore throws away three
 * retries and a reconciler replay, for a message we know we dropped.
 *
 * The narrow claim, and the only one asserted: an enqueue failure — a message
 * never accepted — must be answered with a non-2xx and recorded as failed. A
 * processing failure after acceptance keeps its 200, deliberately, because a
 * retry storm during an incident is its own outage.
 */
require('./load-env');

const express = require('express');

const { prisma } = require('../dist/prisma');
const { runAsPlatform, runAsOrganization } = require('../dist/lib/tenant-context');
const { encryptCredential } = require('../dist/lib/credential-crypto');
const incomingMessageWorker = require('../dist/workers/incoming-message.worker');
const openwaWebhook = require('../dist/webhooks/openwa.webhook');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const stamp = Date.now();
const orgId = `inbound_org_${stamp}`;
const wsId = `ws_${orgId}`;
const webhookToken = `inbound_token_${stamp}`;
const sessionName = `inbound-gate-${stamp}`;
const waMessageId = `false_${stamp}@c.us_GATE${stamp}`;

async function seed() {
  return runAsPlatform('verify-inbound-durability:seed', async () => {
    await prisma.organization.create({
      data: { id: orgId, name: `Inbound Gate ${stamp}`, slug: `inbound-gate-${stamp}`, status: 'ACTIVE' },
    });
    await prisma.workspace.create({
      data: { id: wsId, organizationId: orgId, name: 'Inbound Gate', isDefault: true },
    });
    await prisma.organizationConfig.create({ data: { organizationId: orgId } });
    await prisma.organizationChannel.create({
      data: {
        organizationId: orgId,
        kind: 'OPENWA',
        baseUrl: 'http://127.0.0.1:1/openwa-gate',
        apiKeyEnc: encryptCredential('inbound-gate-key'),
        webhookToken,
        status: 'ACTIVE',
        managedByProvisioner: false,
      },
    });
  });
}

async function cleanup() {
  await runAsPlatform('verify-inbound-durability:cleanup', async () => {
    await prisma.webhookDeliveryLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.organizationChannel.deleteMany({ where: { organizationId: orgId } });
    await prisma.organizationConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.workspace.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
  });
}

/**
 * Mount the real router on a bare app.
 *
 * The property lives in the router and in what it calls, so this points at the
 * artifact that carries it rather than at a copy of the handler.
 */
function startServer() {
  const app = express();
  app.use(express.json());
  app.use(openwaWebhook.default || openwaWebhook.openwaWebhookRouter || openwaWebhook.router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  await cleanup();
  await seed();

  // The failure a Redis hiccup produces, at the one call that makes a message
  // durable. Nothing else is stubbed: the handler, the tenant scope, the
  // delivery log and the response are all the real ones.
  const realAdd = incomingMessageWorker.incomingMessageQueue.add;
  incomingMessageWorker.incomingMessageQueue.add = async () => {
    throw new Error('forced by verify-inbound-durability: queue unreachable');
  };

  const { server, port } = await startServer();
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/webhooks/openwa/${webhookToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'message.received',
        session: sessionName,
        data: {
          message: {
            id: { _serialized: waMessageId },
            from: '972500000001@c.us',
            body: 'I would like to book a table for tonight',
            type: 'chat',
            fromMe: false,
            contact: { pushName: 'Gate Customer' },
          },
        },
      }),
    });
  } finally {
    incomingMessageWorker.incomingMessageQueue.add = realAdd;
    await new Promise((resolve) => server.close(resolve));
  }

  check('the gateway is told the message was not accepted, so its retry and outbox can act',
    response.status >= 500,
    `responded ${response.status} — a message that was never queued was acknowledged as received, `
    + 'which ends three gateway retries and the reconciler replay that would have recovered it');

  const row = await runAsOrganization(orgId, () =>
    prisma.webhookDeliveryLog.findFirst({
      where: { organizationId: orgId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { ok: true, statusCode: true, errorMessage: true, eventType: true },
    }),
  );

  if (!row) {
    check('the delivery is recorded at all', false, 'no INBOUND webhookDeliveryLog row was written for this request');
  } else {
    check('inbound health records the dropped message as failed, not delivered',
      row.ok === false,
      `recorded ok=${row.ok} statusCode=${row.statusCode} for a message that was dropped — `
      + 'this is the row inbound health reads, and it is reporting the opposite of what happened');

    check('the recorded reason names the enqueue, so an operator can tell it from a processing failure',
      typeof row.errorMessage === 'string' && /queue|enqueue/i.test(row.errorMessage),
      `errorMessage=${JSON.stringify(row.errorMessage)} — an audit-shaped failure must not be `
      + 'indistinguishable from a transient service error');
  }

  await cleanup();
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Importing the router pulls in every queue the handler can reach, and each
 * holds an open Redis connection this script did not open for itself. The
 * result is decided and written by the time this runs, so the exit is
 * explicit: a gate that prints its summary and then hangs stalls the sweep and
 * reports nothing.
 */
async function shutdown() {
  try { await incomingMessageWorker.incomingMessageQueue.close(); } catch { /* already closed */ }
  try { await prisma.$disconnect(); } catch { /* already disconnected */ }
  process.exit(process.exitCode || 0);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(shutdown);
