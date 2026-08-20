# WhatsApp gateway runbook

Operational notes for the OpenWA gateway (`ghcr.io/rmyndharis/openwa`). Written
after a live outage on 2026-08-20 where inbound and outbound were both broken,
for different reasons, at the same time.

---

## The two failures, and how to tell them apart

They look identical to a user ("WhatsApp isn't working") and have nothing to do
with each other.

### 1. Nothing is received

**Symptom:** messages sent to the business number never appear. No error
anywhere — not in the gateway, not in the backend.

**Check:**
```bash
KEY=$(grep '^OPENWA_API_KEY=' .env | cut -d= -f2-)
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/sessions/<SESSION_ID>/webhooks
```
`[]` means the gateway has nowhere to deliver to and is silently dropping
everything.

**Cause:** webhook registration originally ran *only* inside the provisioning
state machine. A session linked any other way — pre-existing, re-scanned,
manually created — never got one.

**Fixed:** `reconcileSessionWebhook()` now runs whenever a session is observed
connected (`GET /api/system/sessions`, which Settings polls). Opening Settings
repairs it. Registration is idempotent.

**Two gotchas on the webhook URL**, and they pull in opposite directions:

1. The gateway **rejects single-label hostnames** — `http://backend:4000/...`
   fails with `"url must be a URL address"`. The host must contain a dot.
2. Newer gateway images run an **SSRF guard** that refuses to deliver to private
   addresses, which is exactly where the backend lives:
   `Host host.docker.internal resolves to a blocked internal address: 192.168.65.254`.

The combination that satisfies both:

```yaml
# backend service — a dotted alias on the compose network
networks: { default: { aliases: [backend.local] } }

# gateway service — allowlist it rather than disabling the guard
SSRF_ALLOWED_HOSTS=backend.local,host.docker.internal
```
with `BACKEND_INTERNAL_URL=http://backend.local:4000`.

Do **not** use `host.docker.internal` as the webhook host: it is Docker-Desktop
only and resolves to nothing on a Linux VPS, so inbound would break the moment
you deploy to a real server. Do **not** set `WEBHOOK_SSRF_PROTECT=false` either —
that disables the guard globally, including for tenant-supplied URLs later.

### 2. Nothing can be sent

**Symptom:** every outbound send returns 500. Messages are stored as `FAILED`
(not lost — the app persists before sending, deliberately).

**Gateway log:**
```
TypeError: Cannot read properties of undefined (reading 'id')
    at WhatsAppWebJsAdapter.sendTextMessage (.../whatsapp-web-js.adapter.js:238)
```

**Cause:** in the adapter,
```js
const msg = await this.client.sendMessage(chatId, text);
return { id: msg.id._serialized, ... };
```
`client.sendMessage()` returned `undefined`. This is `whatsapp-web.js` losing
sync with WhatsApp Web's internals — WhatsApp ships a change, the library's
injected code stops returning the message object. **Nothing in RabiTech can fix
this**; the bug is inside the gateway's dependency.

**A session restart does not fix it.** Confirmed: stopped and started, session
returned `ready`, sends still 500.

**Fix — update the gateway image:**
```bash
docker pull ghcr.io/rmyndharis/openwa:latest
docker compose up -d openwa
# the container comes back with sessions "disconnected" — start them:
curl -s -X POST -H "X-Api-Key: $KEY" http://localhost:3000/api/sessions/<ID>/start
```
The running image was three months old (2026-05-20). After the pull, sends
returned `201 {"messageId":...}` immediately.

---

## Safe vs destructive operations

| Action | Credentials | Needs QR re-scan? |
|---|---|---|
| `POST /sessions/:id/stop` | kept | no |
| `POST /sessions/:id/start` | kept | no |
| `docker compose up -d openwa` (new image) | kept — `/app/data` is the named volume `openwa_data` | no, but sessions come back stopped and must be started |
| `DELETE /sessions/:id` | **discarded** | **yes** — this is the only way to pair a different number |

Webhook registrations survive both a session restart and a container recreate.

**Conversation history is never at risk from any of these.** Unlinking deletes
the *gateway* session, not the `WhatsappSession` row, and conversations hang off
that row. Customer threads are keyed on the customer's phone, not yours, so
changing your own business number does not orphan anything.

---

## This will happen again

`whatsapp-web.js` is unofficial and breaks whenever WhatsApp changes its web
client. The gateway pins no `webVersionCache`, so it loads whatever WhatsApp
serves that day.

Worth doing, in order of value:

1. **Monitor it.** A failed send is currently visible only in the logs. A
   scheduled self-send, or an alert on `Message.status = FAILED` crossing a
   threshold, would catch this in minutes instead of when a customer complains.
2. ~~Pin the web version~~ — the updated gateway image now does this itself
   (`Pinning WhatsApp Web version 2.3000.x` in its boot log), which is why
   the image update fixed sending.
3. **Official WhatsApp Cloud API** as a second channel. This entire failure mode
   does not exist there. See `RESPONDIO-BLUEPRINT-FIT.md` §3.3.

---

## Quick health check

```bash
KEY=$(grep '^OPENWA_API_KEY=' .env | cut -d= -f2-)

# sessions — want status "ready"
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/sessions

# webhooks — want a non-empty list with "active": true
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/sessions/<ID>/webhooks

# inbound actually arriving
docker compose logs openwa --since 10m | grep -c "Webhook delivered successfully"

# outbound breaking
docker compose logs openwa --since 10m | grep -c "Cannot read properties of undefined"
```
