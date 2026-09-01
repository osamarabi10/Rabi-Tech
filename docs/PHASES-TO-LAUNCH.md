# Phases to launch

The remaining work, ordered by what stands between RabiTech and its first paying
customer. Written 2026-08-23, after the trial system shipped.

Every claim here was measured against the running system, not remembered. Where
something is broken, the measurement is quoted.

---

## The one thing to understand first

**A customer who wants to pay cannot.** Checkout is a stub:
`manual.provider.ts` returns a `checkoutUrl` pointing at
`/contact-us-to-activate`. So the funnel that now exists ends in a wall:

> sign up → 3 hours of the full product → trial expires → redirected to
> `/pricing` → pick a plan → **a "contact us" page**

The paywall works. The payment does not exist. Everything in F1 and F2 below is
about that sentence, and nothing else on this page matters until it is false.

---

## F0 — Owner-only · blocks every paying customer

Nobody but the account owner can do these. They are not development work.

- [ ] **F0.1 Decide the payment provider.** Merchant-of-record
      (Paddle / LemonSqueezy — they handle VAT, no company entity needed) versus
      direct (Stripe or an Israeli gateway — needs an entity and VAT handling).
      **This blocks F2 entirely.** Nothing else on this list is as expensive to
      delay, because the work behind it is a week and cannot start.
- [ ] **F0.2 Rotate the database password**, `OPENWA_API_KEY` off
      `dev-admin-key`, then set `ALLOW_INSECURE_SECRETS=0`.
      Verify: the boot log stops printing `RUNNING WITH INSECURE SECRETS`.
      It prints it on every boot today.
- [ ] **F0.3 Domain, VPS, TLS.** A reverse proxy in front of frontend and
      backend; `FRONTEND_URL`, `APP_BASE_URL`, `FRONTEND_PUBLIC_URL` set to the
      https origin. Verify: login over https, and the socket connects.
      The product runs on `http://localhost` today.
- [ ] **F0.4 Terms of service and a privacy policy**, linked from `/pricing`
      and `/signup`. A trial that collects a business's customer conversations
      without either is not a trial anyone's lawyer will approve.

---

## F1 — Finish the owner console · ✅ done 2026-08-23

The backend has 27 platform endpoints. The console is **one page**. Several
features that exist and work are unreachable by the person who owns the
business.

- [x] **F1.1 Dunning controls.** Done: a settings page carrying the grace
      period and a "run now" button that says it acts on real subscribers
      before it is pressed rather than after.
      What it replaced: `GET/PATCH /api/platform/dunning/settings` and
      `POST /api/platform/dunning/run` have no UI at all. This is the
      overdue → deadline → suspend automation that was specifically asked for;
      the grace period is configurable in the database and nowhere else.
- [x] **F1.2 Trial controls.** Done: length and plan, with a plan that grants
      no gateway refused rather than honoured.
      What it replaced: Same story, newer: trial length is a
      `PlatformSetting` with no control surface. The owner can extend one
      subscriber's trial from the table but cannot change what every new signup
      gets.
- [x] **F1.3 Revenue summary.** Done — and MRR turned out to be overstating
      itself, counting every open trial at full list price. Fixed, and covered
      by a gate check so it cannot come back.
      What it replaced: `GET /api/platform/billing/summary` returns
      platform-wide figures nothing renders. The owner has no view of what the
      business earns.
- [x] **F1.4 Commercial history.** Done: shown under the terms, with the
      reason and not only the timestamp.
      What it replaced: `GET /subscribers/:id/commercials/history`
      records who granted which discount and why. The audit trail is written and
      unreadable.
- [x] **F1.5 A console home.** Done: money first, then what needs a person,
      with each block hidden when it is empty.
      What it replaced: There is no landing view — signing in as the
      owner drops you into a subscriber table. Needs: subscribers by state,
      trials expiring today, gateways down, unpaid invoices, MRR.
- [x] **F1.6 Gateway channel editing.** Done, offered only on hand-configured
      gateways where the endpoint accepts it. Closing it also surfaced a bug:
      the actions menu was disabling every *billing* action on exactly those
      subscribers.
      What it replaced: `PATCH /subscribers/:id/openwa-channel`
      is API-only.

**Done when:** every platform endpoint is reachable from the console or
deliberately listed here as not worth a control, and the dunning grace period can
be changed by a person rather than a query.

---

## F2 — Payments live · ~1 week · **blocked on F0.1**

Follows [BILLING-PROVIDER-GUIDE.md](BILLING-PROVIDER-GUIDE.md). Activation is
already automatic; only checkout is missing.

- [ ] **F2.1 Provider class** implementing `PaymentProvider`, mapping events to
      `PaymentEventKind`. The Stripe mapping table is already written.
- [ ] **F2.2 Registry line and env** — `PAYMENT_PROVIDER`, keys, webhook secret,
      in `.env` **and** in `docker-compose.yml`, or they do not exist in the
      container.
- [ ] **F2.3 Webhook** pointed at `https://<domain>/api/billing/webhook`.
- [ ] **F2.4 A sandbox purchase, end to end** — and specifically the path this
      product now depends on: an expired trial converting to a paid plan and
      regaining access on the next request.
- [ ] **F2.5 Replace `/contact-us-to-activate`** with the real checkout
      redirect.
- [ ] **F2.6 Failure paths** — `payment_failed` → PAST_DUE → dunning →
      suspension, walked through in sandbox rather than assumed.

**Done when:** a person who is not us can sign up, run out of trial, pay, and
keep working — without anyone touching the database.

---

## F3 — Close the open defects · ✅ done 2026-08-23

Two things found while building other things. Both are recorded in
[TODO.md](TODO.md); neither is hypothetical.

- [x] **F3.1 `firstResponseAt` backfill over-counts.** Fixed, and it was
      worse than this note said: 3 of 4 rows, not 2, and skewed both ways.
      One row reported 14.9 minutes where the truth was 2305.5, because the
      stamped "response" predated the customer's first message by 8.6
      hours. Migration `20260905090000_first_response_correction`.
      Original note: The M7 migration stamped
      threads that never had an inbound message, so conversations nobody ever
      wrote to count as "answered". 2 of the 4 stamped rows in this database are
      wrong. Nothing produced since is affected. **The fix rewrites published
      historic response-time numbers, so it is an owner decision, not a
      side effect of unrelated work.**
- [x] **F3.2 A shared saved view reaching a second logged-in user** — done,
      20/20. The blocker dissolved on its own: trials now run on Growth,
      which allows five seats, so a second real user can exist. Verified
      both halves that could not be tested before — a private view does
      **not** reach the other user over HTTP or socket, and a shared one
      arrives over the socket without a reload, as do its rename and its
      deletion.
      Original note:
      verified — creating a test user hits the 1-seat limit on the Free plan.
      Worth doing once a second seat exists.

---

## F4 — Before real customers arrive · ~2–3 days

Not blocking a first sale. Blocking a good night's sleep once there is one.

- [x] **F4.1 Nightly verified `pg_dump` with retention.** Completed before
      2026-08-26. The BullMQ worker writes `auto-*.dump` files to the host bind,
      restores each into a scratch database, rejects empty/invalid restores,
      retains the configured count, and alerts the platform owner on failure.
      Consecutive verified files exist for August 24-26.
- [ ] **F4.1b Replicate verified dumps off-host.** The current host bind survives
      a container replacement but not disk or VPS loss. Production needs an
      encrypted object-store copy and a restore drill from that copy.

      **Pipeline and drill built 2026-09-01; the destination is still pending,
      so this stays open.** What exists: `backup-crypto.ts` (streaming
      AES-256-GCM, `[RBK1][IV][ciphertext][tag]`, keyed on a separate
      `BACKUP_ENCRYPTION_KEY`), `backup-destination.ts` (a four-method
      `BackupDestination` seam with a local-directory implementation), and
      `backup-drill.ts` (download → decrypt → restore → count, weekly).
      `npm run test:backup-replication` is **30/30**, hermetic — no Postgres,
      no Redis, no Docker, so it cannot go red for environmental reasons.

      **Why it is not ticked.** The only implementation writes to a directory
      this host can see. That survives a container replacement, which the
      existing bind already did, and not the disk loss this item exists for.
      Closing it needs a real destination — B2 or R2 against the same
      interface, roughly one file — plus `BACKUP_ENCRYPTION_KEY` set and
      **recorded off this machine**. An encrypted copy whose only key dies with
      the host is ciphertext, not a backup.

      Three deliberate behaviours, each of which was a way to get this wrong:
      a missing key switches replication **off** rather than uploading
      plaintext; a failed upload does not fail the backup, because the local
      dump is still verified and good, and raises its own
      `BACKUP_REPLICATION_FAILED` rather than borrowing `BACKUP_FAILED`; and
      the drill fails on a copy older than `BACKUP_REPLICA_MAX_AGE_HOURS` even
      when it restores perfectly, because replication that stopped quietly
      while the drill kept passing on an old file is the D-5 / D-10 / D-16
      pattern exactly.
- [x] **F4.2 Per-organization campaign rate limits**, plan-aware. Completed
      2026-08-26. Incoming work now runs concurrently across organization,
      session and contact keys while a Redis FIFO lock preserves ordering for
      one stream. Campaign sends use the same coordination boundary per
      organization/session, with rates resolved from the effective plan and
      optional operator ceilings. One tenant can no longer monopolise either
      worker. `npm run test:worker-fairness` proves same-key FIFO/no-overlap,
      cross-key concurrency and rate delay; the tenancy gate is now 88/88.
- [ ] **F4.3 Reports onto rollups.** Today's reports scan live tables; that
      stops being viable at volume, not at correctness.

      **Deferred 2026-09-01, and the item named the wrong table.**
      `PlatformDailyMetric` cannot hold what the reports need: its primary key
      is `[organizationId, date, metric]` where `metric` is the `UsageMetric`
      enum — `messages_inbound`, `messages_outbound`, `active_contacts`,
      `ai_tokens_in`, `ai_tokens_out`, `campaign_sends`. The reports want
      conversations created and resolved, first-response and resolution
      percentiles, per-agent breakdowns, CSAT, closure categories and campaign
      acks. None of those is a `UsageMetric`.

      **`AnalyticsHourly` is the right destination and already exists**
      (`inbound, outbound, automated, failed, conversationsCreated,
      conversationsResolved`, materialised by `analytics/rollup.service.ts`).
      `reporting.service.ts` already reads it at 2 of its ~22 aggregate sites.

      **Why it is deferred rather than done.** Every unbounded scan is already
      capped — `MAX_DURATION_SAMPLE = 20000`, `MAX_SERIES_SAMPLE = 50000` —
      with a `truncated` flag surfaced to the caller, so the reports degrade to
      "approximate above 20k" instead of falling over. Against 31 conversations
      and 97 messages there is nothing to measure, and
      [RESPONDIO-BLUEPRINT-FIT.md](RESPONDIO-BLUEPRINT-FIT.md) §3.2 is explicit:
      revisit on a measured bottleneck. F5.3 was deferred on the same basis.

      **What it will actually cost when earned**, so nobody re-scopes it as a
      afternoon's work: duration **percentiles** do not aggregate from daily
      buckets without storing distributions, and per-agent reports need a
      dimension `AnalyticsHourly` does not carry. That is a new model and a
      migration — architectural, and worth designing against real access
      patterns rather than guessed ones.
- [ ] **F4.4 Scan the remaining WhatsApp numbers.** 3 of 5 sessions have never
      been paired, including both of `test`'s and one of the demo's.

---

## F5 — Product depth · weeks, not days

Real work, none of it blocking revenue. Ordered by what a subscriber would miss
first.

- [ ] **F5.1 Workflow canvas** (P11.6). The engine, nodes and branching are
      built; the drag-and-drop editor is not. Automations are configurable by
      API only.
- [ ] **F5.2 Granular role restrictions** (M8.1) — restrict export, contact
      deletion, and billing visibility below ADMIN.
- [ ] **F5.3 Estimated counts** above a threshold, once the conversation list is
      paginated. Also the point at which saved-view counts must move server-side
      — see the note in `inbox-selector.tsx`.
- [ ] **F5.4 Quiet hours** in the recipient's local time, and broadcast clone.
- [ ] **F5.5 Meta Cloud API as a second channel** (P12). Currently on the
      roadmap section of the landing page, which is where it should stay until
      F2 is done.

---

## Sequencing, plainly

```
F0.1 (you, today)  ────────────────► F2 (me, ~1 week) ──► first sale possible
F0.2 · F0.3 · F0.4 (you, this week) ─────────────────────┘

F1 (me, now — needs nothing from you)
F3 (me, now — F3.1 needs one decision from you)
F4 (me, before customers)
F5 (me, after revenue)
```

**The critical path runs through F0.1.** Everything I can do without you is F1,
F3 and F4 — roughly a week of work that does not depend on a single decision.
Everything that turns this into a business waits on the payment provider.
