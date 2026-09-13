#!/usr/bin/env node
/**
 * Automation executes, and something would notice if it stopped.
 *
 * ## Why this gate exists
 *
 * On 2026-09-12 an audit established that the workflow engine is real: a
 * BullMQ queue, a worker started at boot, tenant scope re-established per job,
 * nine triggers dispatching from real events and fifteen of seventeen actions
 * executing. The two that do not execute cannot be saved.
 *
 * And nothing in the sweep would have noticed any of it dying. `verify-workflow-p2.js`
 * is deliberately hermetic - its own header says "No database, no Redis, no
 * queue" - so it asserts that the wiring is *written*: that the dispatcher file
 * mentions a trigger, that the executor has a `case`. Source text proving a
 * branch exists is not evidence the branch runs. It was also registered
 * nowhere, so by the rule that caught a suite shrinking from 157 checks to 21,
 * nobody ran it.
 *
 * The consequence, stated in the audit: delete `startWorkflowWorker()` from
 * index.ts and every gate stays green while automation stops, and the first
 * report arrives from a customer whose escalation never fired. That is the
 * scenario this gate exists to catch.
 *
 * ## What it proves, and the one thing it cannot
 *
 * The engine is exercised end to end against the real database and the real
 * queue: a workflow is stored, an event is dispatched, a job is enqueued, a
 * worker consumes it, and the *effect* is read back out of the database. Not a
 * status field the engine sets about itself - a row the action was supposed to
 * write.
 *
 * The boot wiring is asserted from source, and that is a deliberate second-best.
 * The honest alternative - ask the running backend whether a worker is attached
 * to the queue - would be evidence about a container that may be running an
 * older build than the tree, which is the "suspect the server before the code"
 * trap in reverse. A source assertion is weaker but cannot be satisfied by a
 * stale artifact.
 */
require('./load-env');

const fs = require('fs');
const path = require('path');

require('ts-node/register/transpile-only');

const { prisma } = require('../src/prisma');
const { runAsPlatform, runAsOrganization } = require('../src/lib/tenant-context');
const { refreshEditions } = require('../src/modules/billing/editions.service');
const billing = require('../src/modules/billing/billing.service');
const { dispatchWorkflowEvent, startWorkflowWorker, workflowQueue } = require('../src/workers/workflow.worker');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const STAMP = Date.now();
const SLUG = `automation-${STAMP}`;
const TRIGGER_TAG = `trigger-${STAMP}`;
const EFFECT_TAG = `effect-${STAMP}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearSignupThrottle() {
  await runAsPlatform('automation:clear-throttle', () => prisma.signupThrottleEvent.deleteMany({}));
}

async function cleanup() {
  await runAsPlatform('automation:cleanup', async () => {
    const orgs = await prisma.organization.findMany({
      where: { slug: { startsWith: 'automation-' } }, select: { id: true },
    });
    if (!orgs.length) return;
    const ids = orgs.map((o) => o.id);
    const identityIds = (await prisma.user.findMany({
      where: { organizationId: { in: ids } }, select: { identityId: true },
    })).map((u) => u.identityId);
    await prisma.emailOutbox.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    if (identityIds.length) {
      await prisma.identity.deleteMany({
        where: { id: { in: identityIds }, users: { none: {} }, platformRole: 'NONE' },
      });
    }
    process.stdout.write(`  cleaned up ${orgs.length} organization(s)\n`);
  });
}

/**
 * The boot path still starts the worker.
 *
 * Read from source deliberately - see the header. A queue with no consumer
 * accepts every job and runs none of them, so this is the difference between
 * automation working and automation silently queueing for ever.
 */
function bootStartsTheWorker() {
  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
  const called = /^\s*startWorkflowWorker\(\);/m.test(index);
  check('the server starts the workflow worker at boot',
    called,
    'index.ts does not call startWorkflowWorker(): workflows would be enqueued and never consumed, '
    + 'and no customer-visible error would say so — escalations, auto-tagging and every saved '
    + 'automation would simply stop');
}

/** The hermetic gate is only worth having if the sweep runs it. */
function theHermeticGateIsRegistered() {
  const sweep = fs.readFileSync(path.join(ROOT, 'scripts', 'run-gate-sweep.sh'), 'utf8');
  const manifest = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-gate-sweep.js'), 'utf8');
  const floors = fs.readFileSync(path.join(ROOT, 'scripts', 'gate-floors.js'), 'utf8');
  /*
    Asserted by registered name rather than by script filename.

    The first version of this checked the sweep for "verify-workflow-p2.js" and
    failed after the gate was correctly registered, because it is invoked
    through its npm script - which is deliberate, since it reads dist and the
    npm script rebuilds first. The name is the contract: `run <name>` writes
    <name>.log, and the manifest and floors key on exactly that.
  */
  check('the workflow schema gate is registered in the sweep, the manifest and the floors',
    /^run workflow-schema\s/m.test(sweep) && /'workflow-schema'/.test(manifest) && /'workflow-schema'/.test(floors),
    'verify-workflow-p2.js exists and proves the wiring is declared, but a gate nobody runs is not a gate');
}

async function main() {
  await runAsPlatform('automation:catalogue', () => refreshEditions());
  await cleanup();
  await clearSignupThrottle();

  const created = await billing.createSignup({
    organizationName: SLUG,
    adminName: 'Automation Gate',
    adminEmail: `owner@${SLUG}.example`,
    adminPassword: `Automation-Passw0rd-${STAMP}!`,
    planCode: 'FREE',
    ipAddress: '127.0.0.1',
  });
  const organizationId = created.organizationId;

  /*
    A workflow whose effect is a row rather than a message.

    ADD_TAG was chosen because its result is observable without a gateway, a
    channel or a provider: if the tag exists afterwards, the job was enqueued,
    a worker consumed it, and the executor's branch ran. A SEND_MESSAGE would
    have proved the same thing and needed a paired WhatsApp number to do it.
  */
  const { workflowId, contactId } = await runAsOrganization(organizationId, async () => {
    const workspace = await prisma.workspace.findFirst({
      where: { organizationId }, select: { id: true },
    });
    const contact = await prisma.contact.create({
      data: {
        organizationId,
        workspaceId: workspace.id,
        phone: `97250${String(STAMP).slice(-7)}`,
        name: 'Automation Gate Contact',
      },
      select: { id: true },
    });
    const workflow = await prisma.workflow.create({
      data: {
        organizationId,
        name: `Automation gate ${STAMP}`,
        isActive: true,
        triggerType: 'TAG_ADDED',
        configJson: {
          trigger: { tag: TRIGGER_TAG },
          actions: [{ type: 'ADD_TAG', tag: EFFECT_TAG }],
        },
      },
      select: { id: true },
    });
    return { workflowId: workflow.id, contactId: contact.id };
  });

  const worker = startWorkflowWorker();
  check('the worker starts and attaches to the queue',
    Boolean(worker),
    'startWorkflowWorker() returned null — DISABLE_WORKFLOW_WORKER is set, so this run could not '
    + 'observe execution at all');

  const enqueued = await runAsOrganization(organizationId, () =>
    dispatchWorkflowEvent({ triggerType: 'TAG_ADDED', contactId, payload: { tag: TRIGGER_TAG } }));

  check('a real event enqueues a run for the workflow that matches it',
    enqueued === 1,
    `dispatch reported ${enqueued} run(s) for one matching active workflow`);

  // Consumed, and the effect written. Polled rather than assumed: the whole
  // point is that something else did the work.
  let effect = null;
  let execution = null;
  for (let attempt = 0; attempt < 40 && !effect; attempt += 1) {
    await sleep(250);
    ({ effect, execution } = await runAsOrganization(organizationId, async () => ({
      effect: await prisma.contactTag.findFirst({
        where: { organizationId, contactId, tag: { name: EFFECT_TAG } },
        select: { contactId: true, source: true },
      }),
      execution: await prisma.workflowExecution.findFirst({
        where: { organizationId, workflowId },
        orderBy: { createdAt: 'desc' },
        select: { status: true },
      }),
    })));
  }

  check('a worker consumes the job and runs the workflow to completion',
    execution && execution.status === 'COMPLETED',
    `the execution is ${execution ? execution.status : 'missing'} — a job was enqueued and nothing `
    + 'ran it, which is what a queue with no consumer looks like from the outside');

  check('the action produces its effect in the database, not just a status',
    Boolean(effect) && effect.source === 'WORKFLOW',
    'the tag the workflow was supposed to add does not exist on the contact, so the executor branch '
    + 'did not run even though the wiring says it should');

  bootStartsTheWorker();
  theHermeticGateIsRegistered();

  await worker?.close().catch(() => {});
  await cleanup();
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (error) => {
    try { await cleanup(); } catch (cleanupError) {
      process.stdout.write(`  cleanup after failure did not complete: ${cleanupError && cleanupError.message}\n`);
    }
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await workflowQueue.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
