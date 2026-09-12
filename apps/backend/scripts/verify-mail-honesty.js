#!/usr/bin/env node
/**
 * Queue what we promise, and promise only what we queued.
 *
 * ## Two halves of one property
 *
 * **Signup never queued its verification email.** `createSignup` wrote the
 * token and handed the link back on the response; only `resendVerification`
 * ever called `queueMail`. With no transport configured that is invisible -
 * nothing was going to arrive either way - and it becomes a silent failure the
 * moment a real provider is configured: the outbox would simply never contain
 * the one message every new customer needs.
 *
 * **The invitation path decided what to tell the customer from the environment's
 * name.** `NODE_ENV !== 'production'` chose whether to return the invite link,
 * so in production with a log provider the link was withheld at exactly the
 * moment it was the recipient's only way in - and the UI said "Invitation
 * sent". The correct implementation was one file away: `resendVerification`
 * returns `delivered: provider.delivers` and hands back the URL when it cannot
 * deliver, and the banner renders that honestly.
 *
 * Nothing forced the two to be the same function. That is the second instance
 * of the shape found on 2026-09-12, after the currency formatters.
 *
 * ## Why a SENT row rather than `delivers`
 *
 * `provider.delivers` is a property of the configured class - a claim that
 * configuration exists, which is what `channel-viability.ts` already taught us
 * proves nothing. An `EmailOutbox` row at `status = 'SENT'` with a `sentAt` is
 * a message this system actually handed off: observed, already stored, no new
 * table. This gate asserts against the claim where the claim is what the code
 * reads, and records the evidence shape in D-33 for the canary that will need
 * it.
 */
require('./load-env');

const fs = require('fs');
const path = require('path');

require('ts-node/register/transpile-only');

const { prisma } = require('../src/prisma');
const { runAsPlatform } = require('../src/lib/tenant-context');
const billing = require('../src/modules/billing/billing.service');
const invitations = require('../src/modules/system/user-invitations.service');
const { getMailProvider } = require('../src/modules/mail/mail.provider');
const { refreshEditions } = require('../src/modules/billing/editions.service');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const STAMP = Date.now();
const SLUG = `mailhonesty-${STAMP}`;
const EMAIL = `owner@${SLUG}.example`;
const INVITEE = `invitee-${STAMP}@${SLUG}.example`;

async function clearSignupThrottle() {
  await runAsPlatform('mail-honesty:clear-throttle', async () => {
    const { count } = await prisma.signupThrottleEvent.deleteMany({});
    if (count) process.stdout.write(`  cleared ${count} signup throttle event(s)\n`);
  });
}

async function cleanup() {
  await runAsPlatform('mail-honesty:cleanup', async () => {
    const orgs = await prisma.organization.findMany({
      where: { slug: { startsWith: 'mailhonesty-' } }, select: { id: true },
    });
    if (orgs.length) {
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
    }
    // Invitation mail carries no organization on some paths; clear by address.
    await prisma.emailOutbox.deleteMany({ where: { toEmail: { contains: 'mailhonesty-' } } });
    if (orgs.length) process.stdout.write(`  cleaned up ${orgs.length} organization(s)\n`);
  });
}

/**
 * What a caller is told about a message it asked us to send.
 *
 * Read from the source because the property is which *condition* decides it. A
 * behavioural check would have to run the process twice under two values of
 * NODE_ENV to see the difference, and would still not say why it differed.
 */
function nothingDecidesDeliveryFromTheEnvironment() {
  const invite = fs.readFileSync(
    path.join(ROOT, 'src', 'modules', 'system', 'user-invitations.service.ts'), 'utf8');

  check('the invitation path does not decide what to tell the customer from NODE_ENV',
    !/NODE_ENV[\s\S]{0,80}inviteUrl/.test(invite),
    'the link is withheld by the environment\'s name rather than by whether mail can be delivered, '
    + 'so production with a log provider hides the recipient\'s only way in');

  check('the invitation path reports what the transport can actually do',
    /delivers/.test(invite),
    'it returns no delivery state at all, so a caller cannot tell a queued message from a sent one');
}

async function main() {
  // An unloaded catalogue resolves to the deny-everything floor, and signup
  // would be refused for a reason that has nothing to do with mail.
  await runAsPlatform('mail-honesty:catalogue', () => refreshEditions());
  await cleanup();
  await clearSignupThrottle();

  const created = await billing.createSignup({
    organizationName: SLUG,
    adminName: 'Mail Honesty Gate',
    adminEmail: EMAIL,
    adminPassword: `Mail-Honesty-Passw0rd-${STAMP}!`,
    planCode: 'FREE',
    ipAddress: '127.0.0.1',
  });

  const queuedAtSignup = await runAsPlatform('mail-honesty:read', () =>
    prisma.emailOutbox.findMany({
      where: { organizationId: created.organizationId, kind: 'email-verification' },
      select: { id: true, toEmail: true, status: true },
    }));

  check('signing up queues the verification email it tells the customer to expect',
    queuedAtSignup.length === 1,
    `${queuedAtSignup.length} verification message(s) in the outbox after one signup — `
    + 'the link is rendered on the response and nothing is queued, so a customer who closes that '
    + 'tab has no second copy and a configured provider would deliver nothing');

  check('it queues exactly one, addressed to the administrator who signed up',
    queuedAtSignup.length === 1 && queuedAtSignup[0].toEmail === EMAIL,
    `addressed to ${queuedAtSignup.map((m) => m.toEmail).join(', ') || 'nobody'}`);

  /*
    Resending must not double-post the same message: the outbox deduplicates by
    key, and a verification resend deliberately carries no dedupe key because
    each one supersedes the last. So the count grows by exactly one, and this
    asserts the signup queue did not consume the key resend needs.
  */
  await billing.resendVerification(created.organizationId);
  const afterResend = await runAsPlatform('mail-honesty:read', () =>
    prisma.emailOutbox.count({
      where: { organizationId: created.organizationId, kind: 'email-verification' },
    }));
  check('a resend adds one more rather than colliding with the signup message',
    afterResend === queuedAtSignup.length + 1,
    `outbox holds ${afterResend} verification messages after one signup and one resend`);

  const invitation = await runAsPlatform('mail-honesty:invite', () =>
    invitations.issueUserInvitation({
      organizationId: created.organizationId,
      email: INVITEE,
      name: 'Invited Person',
      role: 'AGENT',
      invitedByName: 'Mail Honesty Gate',
      primaryTeamId: null,
    }));

  const delivers = getMailProvider().delivers;
  check('an invitation says whether it can be delivered, rather than implying it was',
    typeof invitation.delivered === 'boolean' && invitation.delivered === delivers,
    `the invitation result carries delivered=${JSON.stringify(invitation.delivered)} `
    + `while the configured provider delivers=${delivers}`);

  check('when the transport cannot deliver, the caller is handed the link instead',
    delivers ? invitation.inviteUrl == null : typeof invitation.inviteUrl === 'string',
    delivers
      ? 'a delivering provider should not need to hand the link back'
      : 'the provider delivers nothing and no link was returned, so the invitation is unreachable');

  nothingDecidesDeliveryFromTheEnvironment();

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
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
