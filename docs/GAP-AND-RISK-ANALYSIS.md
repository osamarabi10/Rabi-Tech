# Gap and risk analysis — one view

**Everything missing and everything exposed, ranked, in one place.**
Compiled 1 September 2026.

Written because the answer was previously spread across five documents that
disagreed with each other. This one is the single ranked list; the others stay
as the detail behind it.

**Sources.** `Respond.io_Workspace_System_Documentation.docx` (a read-only
inspection of a live workspace, ID 320612, 31 August 2026), `KNOWN-DEFECTS.md`,
`PHASES-TO-LAUNCH.md`, `TODO.md`, and direct reading of the code.

**How severity is assigned here.** Not by how bad it sounds — by two questions:
*can it lose money, data or a customer*, and *is it live right now*. A
theoretical problem in code nobody runs ranks below a real one in code running
tonight.

---

## A. Live risks, ranked

### A1 · You cannot take money · **blocks the business**

Checkout is a stub returning a link to `/contact-us-to-activate`. The paywall
works, the trial works, activation works. The payment does not exist.

Everything else in this document is secondary to this, including the security
items — a system with no customers has nothing to lose. **F0.1**, choosing the
provider, is the whole blocker, and it is a commercial decision, not code.

**Fix:** F0.1, then F2 (~1 week). Nothing can start until the decision is made.

---

### A2 · Public repository names credentials that are still in use · **live now**

`github.com/osamarabi10/Rabi-Tech` is public by choice. `CLAUDE.md`, `TODO.md`
and `RESPONDIO-PARITY-CHECKPOINT.md` are on it and between them name the shipped
default database password and `dev-admin-key`, both of which are still the live
values. `docker-compose.yml` publishes the topology beside them.

This is not a push risk. It is already true, and every future push adds to it.

**Fix:** rotate all three, then `ALLOW_INSECURE_SECRETS=0` and confirm the boot
log stops printing `RUNNING WITH INSECURE SECRETS`. **O1–O3 / F0.2, ~30 minutes.**
Removing the values from the documents does nothing — history is public.

---

### A3 · An Atlas password was pasted into chat · **live now**

`cluster0.twufn61` received a live password in conversation on 1 September. The
cluster is parked and unused, which limits the blast radius to that cluster, not
to RabiTech.

**Fix:** rotate the database user in Atlas, and check Network Access for a
`0.0.0.0/0` entry. ~10 minutes. Do it even though the cluster is unused.

---

### A4 · Backups never leave this host · **one disk failure from total loss**

The nightly dump is verified by restoring it — which is more than most systems
do — and then stays on the same disk as the database it backs up. A disk or VPS
loss takes both.

The encryption, the destination interface and the weekly restore drill are
**built and gated at 30/30**. What is missing is a destination and a key.

**Fix:** a Backblaze B2 or Cloudflare R2 bucket, `BACKUP_ENCRYPTION_KEY` set,
and — the part that is easy to skip and ruins the rest — **that key written down
somewhere that is not this machine.** An encrypted backup whose only key dies
with the host is ciphertext. **F4.1b, ~0.5 day plus a bucket.**

---

### A5 · No TLS · **credentials cross the network in clear**

The product runs on `http://localhost` and a LAN IP. Every login, every JWT and
every customer message crosses the network unencrypted.

**Fix:** **F0.3** — domain, VPS, reverse proxy. This also ends the Docker
Desktop port-proxy failures that have cost several evenings, because they are a
Docker-on-Windows problem that does not exist on a Linux host.

---

### A6 · The WhatsApp gateway is unofficial and will break

OpenWA drives WhatsApp Web and breaks whenever WhatsApp changes its client. This
is a scheduled event, not a risk. The gateway pins no `webVersionCache`, so it
loads whatever WhatsApp serves that day.

There is no fallback channel. When it breaks, the product is down for every
tenant simultaneously.

**Fix:** **P12**, the Meta Cloud API channel — 4–5 weeks, and correctly
sequenced after revenue. Until then this is an accepted risk, and the runbook
exists for when it fires.

---

### A7 · Media URLs fall back to a known signing secret · **found 1 Sep, not previously recorded**

`utils/signed-url.ts` signs with `process.env.JWT_SECRET || 'default-secret'`.
If `JWT_SECRET` is ever unset or absent in an environment, media URLs are signed
with a constant that is in a public repository — and the fallback is silent, so
nothing reports it.

`verify-media-url.js` was passing under that fallback until tonight, because it
had no environment loaded (D-12); it now loads the real secret.

**Fix:** make the secret required rather than defaulted — fail at boot if it is
absent, the way other required secrets already do. **~1 hour.** Not yet in the
defect register; it belongs there as D-29.

---

### A8 · Channel encryption keys cannot be rotated

`CHANNEL_ENCRYPTION_KEY` protects every stored channel credential and has no
re-encryption routine. A leaked key exposes every customer's tokens at once, and
the only remedy would be asking every customer to re-enter their credentials.

`MetaChannelCredential` carries a `keyVersion` column from the start
specifically so this is buildable later, which was the right call.

**Fix:** a re-encryption routine, before the first real customer credential is
stored. Not urgent while the vault is empty; urgent the moment it is not.

---

### A9 · Five gates owe a watched green run

After tonight's D-12 fix, `test:finance`, `test:dunning`,
`test:campaign-replies`, `test:snooze` and `test:worker-fairness` have not been
run against the change. The tenancy gate is also unrun, pending review of the
uncommitted trial-gateway work.

**A gate is green only when it was watched to run.** Until then these are
assumptions.

**Fix:** run them from a terminal that has never exported `DATABASE_URL` — which
is the entire point of the fix. ~20 minutes.

---

### A10 · Two people, one product, two databases · **organisational, not technical**

A co-founder is working on MongoDB while this repository is 81 migrations deep
on PostgreSQL, and has never committed to it. As of 1 September the 54
laptop-only commits are pushed, so the work is now visible — which was probably
the root cause, since it was invisible before.

**Fix:** a conversation, with `RESPONDIO-BLUEPRINT-FIT.md` §3.2 open. Cheaper
this week than next month, when one of the two bodies of work gets discarded.

---

### A11 · Three of five WhatsApp sessions have never been paired

Including both of `test`'s and one of the demo's. Needs physical phones.
**F4.4.**

---

## B. Feature gaps against Respond.io

From the workspace inspection. The full comparison is in
[PROJECT-SPEC.md](PROJECT-SPEC.md) §4; this is what is missing and what it costs.

| Gap | Cost | Verdict |
|---|---|---|
| **Blocked contacts** | ~0.5 day | **Build.** The one real gap nobody had listed. Today the only remedy is deleting the contact, which destroys the history that is the reason to block them |
| **Unassign after close** | ~0.5 day | **Build.** Closed threads keep counting against an agent's open load, which is the input to least-open routing — the router silently degrades |
| **Chart export (SVG/PNG)** | ~0.5 day | **Build.** CSV already exists for contacts and finance; charts export nothing |
| **Ask a Question node** | ~1 day | **Build.** The eighth and last workflow node |
| **Granular role restrictions** | ~1 day | **Build.** Export, deletion, workspace and integration settings |
| **Quiet hours** | ~1 day | **Build.** Recipient-local time from phone prefix |
| **Broadcast clone** | hours | **Build.** Trivial, real convenience |
| **Workflow canvas** | 6–8 weeks | After revenue. Engine and nodes exist; only the canvas is missing |
| **AI agents + composer summaries** | weeks | After revenue. The widest single gap. Today "AI" here is plan limits with no feature behind them |
| **Official Meta channel** | 4–5 weeks | After revenue — but see A6, it is also the biggest operational risk |
| Tasks inbox | — | **Do not build.** Unconfigured in a live workspace with 663 contacts |
| Calls | — | **Do not build.** One-to-one text platform by design |

---

## C. Open defects

Twenty-eight recorded. Confirmed status:

- **Fixed:** D-5, D-6, D-16, D-25, D-26, and D-12 as of tonight.
- **Partly closed:** D-27 — `allowedChannels`; the remaining gap is deliberate
  and documented as such.
- **Open:** D-28 — `invoiceRef` uniqueness rests on four characters of the
  organization id. Not urgent, and it gets less comfortable with every
  subscriber added.

**The register does not mark status consistently.** Most entries carry no
status line, so "is this still true?" cannot be answered by reading — only by
re-deriving it from the code. That is the same drift that had H2 and H6 showing
open after they shipped, and @mentions listed as missing months after it landed.

**Fix:** a status line on every entry — `Open`, `Fixed <date>`, `Partly closed`,
or `Deliberate`. ~1 hour, and it makes the register trustworthy instead of
merely long. Worth doing before the count grows further.

The money-path defects — D-17 through D-24 — cluster around billing paths that
no provider is armed against yet. They become live the day F2 ships, and should
be re-read as a group at that point rather than picked off individually now.

---

## D. The order to fix things

**This week, and none of it is code:**

1. **F0.1** — pick the payment provider. Unblocks a week of work that cannot start.
2. **F0.2 / O1–O3** — rotate the two secrets, set `ALLOW_INSECURE_SECRETS=0`. ~30 min.
3. Rotate the exposed Atlas password. ~10 min.
4. Run the five owed gates from a clean terminal. ~20 min.
5. Review the uncommitted trial-gateway work, then run the tenancy gate.
6. The conversation with your co-founder.

**Next, ~1 day, closes the two worst technical exposures:**

7. **F4.1b** — a real backup destination and a key stored off this machine.
8. **A7** — make `JWT_SECRET` required instead of silently defaulted.

**Then, ~6 days, everything ready to build:**

9. Blocked contacts, unassign-after-close, chart export, D-28, broadcast clone,
   Ask a Question, granular restrictions, quiet hours.

**Then, behind F0.1:**

10. **F2** — payments live, ~1 week. First sale becomes possible here.

**After revenue:** the workflow canvas, the Meta channel, AI.

---

## E. Deliberately not fixing

Recorded so they are not re-proposed in three months as oversights.

| | Why |
|---|---|
| **F4.3 / H3** — reports onto rollups | Named the wrong table; `PlatformDailyMetric` is keyed by billing metrics and cannot hold conversations or durations. Scans already capped. No measured bottleneck |
| **F5.3 / M3.5** — estimated counts | Revisit past ~50,000 contacts |
| **Tasks inbox** | Unconfigured in a live workspace of 663 contacts |
| **Calls** | Product decision |
| **MongoDB migration** | 13–19 weeks, 8–13 of them with no working tenancy gate, to relieve a Docker-on-Windows problem that F0.3 solves. Parked 1 September |
| **Per-commit image rebuilds** | Eleven consecutive runs caught nothing the typechecker and harnesses had not, and twice took the Docker engine down |
