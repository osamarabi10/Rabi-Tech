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

## F1 — Finish the owner console · ~1–2 days · **can start now**

The backend has 27 platform endpoints. The console is **one page**. Several
features that exist and work are unreachable by the person who owns the
business.

- [ ] **F1.1 Dunning controls.** `GET/PATCH /api/platform/dunning/settings` and
      `POST /api/platform/dunning/run` have no UI at all. This is the
      overdue → deadline → suspend automation that was specifically asked for;
      the grace period is configurable in the database and nowhere else.
- [ ] **F1.2 Trial controls.** Same story, newer: trial length is a
      `PlatformSetting` with no control surface. The owner can extend one
      subscriber's trial from the table but cannot change what every new signup
      gets.
- [ ] **F1.3 Revenue summary.** `GET /api/platform/billing/summary` returns
      platform-wide figures nothing renders. The owner has no view of what the
      business earns.
- [ ] **F1.4 Commercial history.** `GET /subscribers/:id/commercials/history`
      records who granted which discount and why. The audit trail is written and
      unreadable.
- [ ] **F1.5 A console home.** There is no landing view — signing in as the
      owner drops you into a subscriber table. Needs: subscribers by state,
      trials expiring today, gateways down, unpaid invoices, MRR.
- [ ] **F1.6 Gateway channel editing.** `PATCH /subscribers/:id/openwa-channel`
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

## F3 — Close the open defects · ~half a day · **can start now**

Two things found while building other things. Both are recorded in
[TODO.md](TODO.md); neither is hypothetical.

- [ ] **F3.1 `firstResponseAt` backfill over-counts.** The M7 migration stamped
      threads that never had an inbound message, so conversations nobody ever
      wrote to count as "answered". 2 of the 4 stamped rows in this database are
      wrong. Nothing produced since is affected. **The fix rewrites published
      historic response-time numbers, so it is an owner decision, not a
      side effect of unrelated work.**
- [ ] **F3.2 A shared saved view reaching a second logged-in user** was never
      verified — creating a test user hits the 1-seat limit on the Free plan.
      Worth doing once a second seat exists.

---

## F4 — Before real customers arrive · ~2–3 days

Not blocking a first sale. Blocking a good night's sleep once there is one.

- [ ] **F4.1 Nightly `pg_dump`** with retention. There is no backup today. The
      first support conversation a subscriber loses is the last one they have
      with us.
- [ ] **F4.2 Per-organization campaign rate limits**, plan-aware. One tenant's
      broadcast can currently monopolise the send queue.
- [ ] **F4.3 Reports onto `PlatformDailyMetric` rollups.** Today's reports scan
      live tables; that stops being viable at volume, not at correctness.
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
