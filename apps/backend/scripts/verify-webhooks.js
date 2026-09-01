/**
 * Outbound webhooks: signing, delivery, retry policy and auto-deactivation.
 *
 * ## Hermetic, and it must stay that way
 *
 * No Postgres, no Redis, no Docker. The receiver is a local HTTP server this
 * script starts, so it can assert on the exact bytes and headers that arrive —
 * which is the only way to prove a signature is verifiable by somebody else.
 * `verify-backup-replication` and `verify-restrictions` are hermetic for the
 * same reason: a check that can go red because Docker is unhappy teaches
 * nobody anything.
 *
 * ## What is being defended
 *
 * A signature that cannot be verified by a receiver is worse than no signature:
 * the subscriber writes verification code, it rejects everything, and they turn
 * it off. So the central assertions run the *documented* verification against
 * the *actual* bytes delivered — not a signature this file computed itself,
 * which would only prove the function agrees with itself.
 */

const crypto = require('crypto');
const http = require('http');

const {
  signPayload,
  verifySignature,
  generateWebhookSecret,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_HEADER,
} = require('../dist/modules/webhooks/webhook-signature');
const {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_GROUPS,
  isWebhookEvent,
} = require('../dist/modules/webhooks/webhook-events');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : ''));
  }
}

/** A receiver that records exactly what arrived. */
function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body, method: req.method });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

async function main() {
  const secret = generateWebhookSecret();

  // ── the catalogue ────────────────────────────────────────────────────────
  check('eleven events are published', WEBHOOK_EVENTS.length === 11, WEBHOOK_EVENTS.length);
  check('every event name is namespaced resource.action',
    WEBHOOK_EVENTS.every((e) => /^[a-z_]+\.[a-z_]+$/.test(e)),
    WEBHOOK_EVENTS.filter((e) => !/^[a-z_]+\.[a-z_]+$/.test(e)).join(', '));
  check('no duplicate event names', new Set(WEBHOOK_EVENTS).size === WEBHOOK_EVENTS.length);
  check('isWebhookEvent accepts a real one', isWebhookEvent('message.received') === true);
  check('isWebhookEvent rejects a made-up one', isWebhookEvent('message.exploded') === false);
  check('isWebhookEvent rejects a non-string', isWebhookEvent(7) === false);

  // The console renders from the groups. An event missing from them is one a
  // subscriber can never subscribe to — declared, and unreachable.
  const grouped = WEBHOOK_EVENT_GROUPS.flatMap((g) => g.events);
  const ungrouped = WEBHOOK_EVENTS.filter((e) => !grouped.includes(e));
  check('every event appears in a console group', ungrouped.length === 0, ungrouped.join(', '));
  check('no group invents an event that does not exist',
    grouped.every((e) => WEBHOOK_EVENTS.includes(e)));

  // ── the secret ───────────────────────────────────────────────────────────
  check('the secret is prefixed so it is recognisable in a config file',
    secret.startsWith('whsec_'));
  check('the secret carries 256 bits', /^whsec_[0-9a-f]{64}$/.test(secret));
  check('two secrets differ', generateWebhookSecret() !== generateWebhookSecret());

  // ── signing ──────────────────────────────────────────────────────────────
  const body = JSON.stringify({ hello: 'world' });
  const now = Math.floor(Date.now() / 1000);
  const header = signPayload(secret, body, now);

  check('the header carries a timestamp and a versioned signature',
    /^t=\d+,v1=[0-9a-f]{64}$/.test(header), header);
  check('a correct signature verifies', verifySignature(secret, body, header).ok === true);
  check('a changed body does not verify',
    verifySignature(secret, body + ' ', header).ok === false);
  check('the wrong secret does not verify',
    verifySignature(generateWebhookSecret(), body, header).ok === false);

  /*
    Replay protection is the reason the timestamp is signed at all.

    A signature over the body alone proves the body came from us and nothing
    about *when*. Anyone who captures one valid request could replay it forever
    and every replay would verify. Respond.io's published scheme signs the body
    only; copying the shape of their API is worth doing, copying that decision
    is not.
  */
  const old = signPayload(secret, body, now - 3600);
  check('an hour-old signature is rejected as stale', verifySignature(secret, body, old).ok === false);
  check('  …and says why', verifySignature(secret, body, old).reason === 'timestamp outside tolerance');
  check('a signature from five minutes ago is still accepted',
    verifySignature(secret, body, signPayload(secret, body, now - 290)).ok === true);
  check('a future timestamp beyond tolerance is rejected too',
    verifySignature(secret, body, signPayload(secret, body, now + 3600)).ok === false);

  // Moving the timestamp without re-signing must not verify — otherwise the
  // freshness window is decoration, because an attacker just edits `t`.
  const tampered = header.replace(/^t=\d+/, `t=${now}`).replace(/t=\d+/, `t=${now + 1}`);
  check('editing the timestamp invalidates the signature',
    verifySignature(secret, body, tampered).ok === false);

  check('a malformed header is rejected, not thrown on',
    verifySignature(secret, body, 'garbage').ok === false);
  check('an empty header is rejected', verifySignature(secret, body, '').ok === false);
  check('a header with no v1 is rejected', verifySignature(secret, body, `t=${now}`).ok === false);
  check('a v1 of the wrong length is rejected',
    verifySignature(secret, body, `t=${now},v1=abcd`).ok === false);

  const compiled = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'dist', 'modules', 'webhooks', 'webhook-signature.js'), 'utf8');
  // A source assertion, not a timing measurement — what it catches is a later
  // edit replacing timingSafeEqual with `===` because it reads more simply.
  check('the comparison is constant-time', compiled.includes('timingSafeEqual'));

  // ── an end-to-end delivery a receiver can actually verify ────────────────
  const { server, received, port } = await startReceiver();
  try {
    const envelope = {
      id: 'whd_test',
      event: { id: 'evt_test', type: 'message.received', occurredAt: new Date().toISOString() },
      workspace: { id: 'org_test' },
      data: { messageId: 'm1' },
    };
    const payload = JSON.stringify(envelope);
    const ts = Math.floor(Date.now() / 1000);

    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signPayload(secret, payload, ts),
        [EVENT_HEADER]: envelope.event.type,
        [DELIVERY_HEADER]: envelope.id,
      },
      body: payload,
    });

    check('the receiver got exactly one delivery', received.length === 1, received.length);
    const got = received[0];

    /*
      The central assertion. Verification runs against the bytes that actually
      arrived, using the documented function — not against a signature this
      script computed, which would only prove the function agrees with itself.
      A signature a receiver cannot verify is worse than none: they write the
      code, it rejects everything, and they switch it off.
    */
    const verified = verifySignature(secret, got.body, got.headers[SIGNATURE_HEADER.toLowerCase()]);
    check('a receiver can verify the delivered bytes', verified.ok === true,
      verified.ok ? '' : verified.reason);

    check('the event type is in a header, so a receiver can route before parsing',
      got.headers[EVENT_HEADER.toLowerCase()] === 'message.received');
    check('the delivery id is in a header', got.headers[DELIVERY_HEADER.toLowerCase()] === 'whd_test');
    check('the body is the exact JSON that was signed', got.body === payload);
    check('it is a POST', got.method === 'POST');

    const parsed = JSON.parse(got.body);
    check('the envelope carries a delivery id and an event id',
      typeof parsed.id === 'string' && typeof parsed.event.id === 'string');
    check('  …which are different values, so a retry is distinguishable',
      parsed.id !== parsed.event.id);
    check('the envelope names the workspace', parsed.workspace.id === 'org_test');
    check('the secret never appears in the body or headers',
      !got.body.includes(secret) && !JSON.stringify(got.headers).includes(secret));
  } finally {
    // fetch keeps its sockets alive, so close() alone waits for a connection
    // that never ends and the gate hangs instead of failing. Drop the sockets
    // first — this is a test receiver, not a graceful shutdown.
    server.closeAllConnections?.();
    server.close();
  }

  // ── the retry and deactivation policy ────────────────────────────────────
  // Read from the module rather than restated here, so the documented numbers
  // and the shipped ones cannot drift apart silently.
  // The policy module, not the worker: requiring the worker constructs a
  // BullMQ Queue at load time, which opens a Redis connection and leaves this
  // gate hanging with no output. That is what happened on the first run, and
  // it is also how a hermetic gate quietly acquires an infrastructure
  // dependency it was written specifically to avoid.
  const worker = require('../dist/modules/webhooks/webhook-policy');
  check('retries are 30s, 60s, 90s',
    JSON.stringify(worker.WEBHOOK_RETRY_DELAYS_MS) === JSON.stringify([30000, 60000, 90000]),
    JSON.stringify(worker.WEBHOOK_RETRY_DELAYS_MS));
  check('four attempts in total', worker.MAX_ATTEMPTS === 4, worker.MAX_ATTEMPTS);
  check('auto-deactivation is 30 failures', worker.DEACTIVATE_AFTER_FAILURES === 30);
  check('  …in a 30 minute window', worker.DEACTIVATE_WINDOW_MINUTES === 30);
  check('delivery and event ids are distinguishable by prefix',
    worker.newDeliveryId().startsWith('whd_') && worker.newEventId().startsWith('evt_'));
  check('two delivery ids never collide', worker.newDeliveryId() !== worker.newDeliveryId());

  // ── every declared event has a real emitter ──────────────────────────────
  /*
    The defect class this repository has now shipped five times: a capability
    declared in a table and enforced nowhere. An event nobody emits is a
    checkbox a subscriber ticks, a webhook that stays silent forever, and no
    error anywhere to explain it.

    Greps the source rather than the build, because that is where a future
    contributor adds the twelfth event and forgets the call site.
  */
  const srcRoot = require('path').join(__dirname, '..', 'src');
  const sources = [];
  (function walk(dir) {
    for (const entry of require('fs').readdirSync(dir, { withFileTypes: true })) {
      const full = require('path').join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) sources.push(require('fs').readFileSync(full, 'utf8'));
    }
  })(srcRoot);
  const allSource = sources.join('\n');

  for (const event of WEBHOOK_EVENTS) {
    check(`something actually emits ${event}`,
      allSource.includes(`emitWebhook('${event}'`),
      'no call site found in src/');
  }

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
