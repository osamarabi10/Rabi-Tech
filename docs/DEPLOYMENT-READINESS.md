# Deployment readiness

Compiled 2026-09-06 by measuring this machine, not by reading the code and
inferring. Every number here came from a command whose output is quoted or
summarised; where something is historical rather than live, it says so.

This list exists because a readiness list that lives only in a chat message is
the thing this project keeps re-learning.

**Owner-only items are marked ⬛.** They happen at deploy time, on the box, by
the owner, and no agent should attempt them.

---

## 1. Blockers — these break a paying customer

### 1.1 A gateway that drops is never recorded as dropped

**Status: fixed 2026-09-06.** Kept here because the shape recurs.

The state machine promoted and never demoted. `clearStaleFailure` and the
nightly sweep both moved `FAILED → ACTIVE` on a successful probe; nothing moved
a channel out of `ACTIVE` on a failed one. Four components observed a
disconnect and not one wrote it down:

| Component | What it did on a disconnect |
|---|---|
| `health-monitor.ts` | raised a `PlatformAlert`, logged `[GATEWAY_UNHEALTHY]`, left the row |
| `session.disconnected` webhook | emitted a socket event; queued a monitor **only** on connect-ish states |
| `monitorConnection` | wrote `lastCheckedAt`, never demoted |
| reconcile loop | did not select `ACTIVE` channels at all, so never queued a monitor for a live tenant |

Observed live: organization `mark` paired at 07:02, its session dropped to
`qr_ready` by 07:27, and at 11:00 the channel row still read `ACTIVE` with
`lastCheckedAt` frozen at `07:02:11`. The product said Connected while WhatsApp
was showing a QR code.

This is the mirror of the bug that opened the 2026-09-05 session — then the
product said Disconnected for a gateway that was paired; here it said Connected
for one that was not. The second is worse: the customer believes it, and their
messages fail silently.

See D-16.

### 1.2 ⬛ `ALLOW_INSECURE_SECRETS=1` is set

The boot gate that refuses shipped-default credentials is **currently
bypassed**. D-4 records those credentials as present in public git history and
unrotated.

**This flag must be cleared before the box goes up**, and clearing it requires
rotating first — the backend refuses to open its port otherwise, which is the
gate working. Rotation, and this flag, are the owner's and happen at deploy
time. Left as-is deliberately; see `docs/SECURITY-ROTATION.md`.

### 1.3 Published ports

Fixed 2026-09-06: `backend` and `frontend` now bind to loopback on both address
families, matching `postgres`, `redis` and `openwa`, which already did. Before
that, `4000->4000` and `18080->8080` had no host-IP binding — on a VPS that is
the API and the application directly on the internet.

Binding to loopback is not the whole answer, only the half that does not need a
decision. ⬛ **TLS, the reverse proxy and the domain are the owner's**, and
`FRONTEND_URL` / `APP_BASE_URL` still point at `localhost` until they exist.

---

## 2. Capacity, and the socket

Measured on this host with eight gateways running:

| | Resident |
|---|---|
| Docker VM, total | **7.727 GiB** |
| Gateway, provisioned but unpaired | ~135 MiB |
| Gateway, live paired session | **900 MiB** |
| Platform services (postgres, redis, backend, worker, frontend, shared gateway) | ~450 MiB |

**Roughly six to eight simultaneously active tenants on this machine.** The
6.7× gap between idle and live is the trap: an empty staging environment shows
you the 135 MiB number, and capacity planned on it is wrong by a factor of
seven. See D-11.

Tenant gateways publish on host ports **3100–3999** (`GATEWAY_PORT_START` /
`GATEWAY_PORT_END`). ⬛ That range needs a firewall rule on a real host.

The `gateway-worker` service mounts `/var/run/docker.sock` — root-equivalent
access to the host, on that one service and never on `backend`. Accepted
deliberately over an unsupervised worker; the two mitigations are named in
**D-13** and neither is built.

---

## 3. Configuration not yet present

39 names in `.env.example` are absent from `.env`.

| Group | Count | Consequence if left |
|---|---|---|
| Backups | 7 | Configured 2026-09-06 and the restore drilled — see §5 |
| ⬛ Stripe | 10 | `PAYMENT_PROVIDER` unset, checkout is a stub. No money can be taken. |
| ⬛ Meta Cloud API | 3 | `editionOfferability` withdraws GROWTH, BUSINESS and ENTERPRISE from sale (D-9) |
| `NEXT_PUBLIC_*` | 6 | Support email, privacy, status and docs links absent from customer-facing UI |
| Concurrency, recap, snippets | 13 | Defaults apply; acceptable |

**No email is delivered by anything** (D-2). SMTP is unset, so mail is logged
rather than sent — verification, invoices and alerts included. Signup returns
the verification URL in its response body, which is workable for a demo and not
for customers. ⬛ Owner's, at deploy time.

---

## 4. Health, limits and supervision

Fixed 2026-09-06: all six services carry a healthcheck and a memory limit.

Before that, none did. Given the 900 MiB-per-live-tenant measurement, an
unbounded Chromium spike during pairing could take the host down — and the
provisioning worker had already been OOM-killed twice in its previous,
hand-started form.

The worker itself is the `gateway-worker` compose service with
`restart: always`. It is the only process that records a pairing, so an
unsupervised one fails silently and totally. Never run a second one: they
consume the same BullMQ queue and race. See D-13, and
`docs/DEPLOYMENT.md`.

---

## 5. Backups

⬛ **Prove a restore before the first customer, and record how long it took.**
A backup nobody has restored is a belief, not a backup.

The seven variables are configured as of 2026-09-06. The replica bind points at
`D:/rabitech-replica` — a different physical device from the `C:` volume the
database sits on, which is what `BACKUP_REPLICA_OFFHOST` is asserting. A replica
on the same disk, or inside the repository being backed up, is the one path that
looks configured and protects against zero failures.

**Drilled, not assumed:**

```
backup   2.94 MB dump, verified, replicated                    12.75 s
drill    download -> decrypt -> restore -> count, off-host     10.35 s
         58 conversations, 121 messages, 60 contacts — exact match
```

Recovery takes about ten seconds at this data size. That figure is the one you
cannot guess during an outage, and it will grow with the database.

> ⬛ **The encryption key exists only on the machine it protects**, which makes
> it useless in the disaster it is for. Copy `BACKUP_ENCRYPTION_KEY` into a
> password manager held elsewhere. Not done, and owner-only.

---

## 6. Queue debris

100 failed jobs across six queues at the time of writing. Composition matters
more than the count — most of it is historical and wants draining, not fixing:

| Queue | Failed | Verdict |
|---|---|---|
| `billing-reconciliation` | 43 | Historical. `MANUAL_REVIEW` is now in `SubscriptionStatus`; a later migration fixed it. |
| `conversation-auto-close` | 37 | 26 **were live and recurring** (see below); the rest historical schema drift and outage-era |
| `incoming-message` | 12 | `Session not found`, all within one minute during a pairing window |
| `gateway-health`, `analytics-rollup`, `campaign-scheduler` | 13 | Outage-era: database unreachable. Historical. |
| `gateway-provisioning` | 0 | Drained 2026-09-06 (was 246; **238 were `No OrganizationChannel found`**, not the 401 era they were first reported as) |

The recurring failures were
`[TENANT_ISOLATION_VIOLATION] Organization bleed_org_a has no default workspace`.
The tenancy harness deletes its fixture organizations and leaves their scheduled
jobs in Redis, where they fail for ever — **and it adds two more on every run**:
seven runs on 2026-09-06 left fourteen delayed jobs behind. That is the AGENTS
*"a gate must not touch the real queue"* rule running in the other direction,
recorded there as its second half. **The debris is drained; the harness still
leaves it, and that is not fixed here.**

Drained 2026-09-06: 105 failed and 14 delayed jobs across six queues. All
queues are at zero failed.

---

## 7. What is ready

Worth stating, because a readiness document that lists only gaps misleads in the
other direction:

- Provisioning works end to end — signup, Connect, per-tenant container, QR,
  scan, `ACTIVE` — and is supervised. It now demotes as well as promotes, so a
  channel that says Connected means it (D-16).
- The OpenWA image is pinned by digest in both compose files; a tag change is a
  deployment (AGENTS, Evidence).
- Host-boundary naming is portable to Linux: `host.docker.internal` is mapped
  with `extra_hosts: host-gateway` everywhere it is used, and the three values
  that name it share one definition (D-14).
- 97 migrations, schema up to date.
- Tenancy isolation 148/148, fail-closed. The `bleed_org_a` violation above is
  that guard working, not failing.

---

## 8. Order

1. ~~The disconnect gap~~ — done, D-16
2. ~~Loopback binding~~ — done
3. ~~Healthchecks and memory limits~~ — done
4. ~~Backups configured; restore drilled~~ — done, §5
5. ~~Drain the historical debris~~ — done
6. ⬛ Rotate credentials, then clear `ALLOW_INSECURE_SECRETS`
7. ⬛ TLS, reverse proxy, domain, `FRONTEND_URL` / `APP_BASE_URL`
8. ⬛ Firewall the 3100–3999 tenant range
9. ⬛ SMTP
10. ⬛ Stripe, then Meta — revenue rather than safety, and last for that reason
