# Rotating the secrets

Referenced from `README.md`, `CLAUDE.md` and `docker-compose.yml`, and until now
it did not exist.

Everything here is something **only the account owner can do**. None of it is
development work, and none of the values below should ever be typed into a chat,
a commit message, or an issue.

---

## Why this is not "later"

This repository is **public**. Until 2026-08-23 its README printed the seeded
platform-owner password, and that password still worked on the running instance.
Nothing was exposed, because nothing was reachable beyond `localhost` — but the
roadmap's next infrastructure step is putting this on a domain, and on that day
the exposure becomes real before the DNS finishes propagating.

The backend already tells you this on every boot:

```
⚠ RUNNING WITH INSECURE SECRETS — rotate and remove ALLOW_INSECURE_SECRETS
```

That line is not decoration. It is a list, and it goes away when the list is
empty.

---

## 1. The platform owner password

The one that was published. Do this first.

Log in to `/platform`, then change it from the account menu. If you cannot log
in, reseed with the value you want set:

```bash
# in .env, before seeding
PLATFORM_OWNER_EMAIL=you@yourdomain.com
PLATFORM_OWNER_PASSWORD=
```

```bash
docker compose exec backend npm run db:seed
```

**Do not pick a password you use anywhere else.** This account can read every
subscriber's conversations on the platform.

> **There is no "forgot password" flow yet.** It needs email, which needs the
> SMTP configuration below. Until that is on, losing this password means a
> manual database write — so store it in a password manager now, not later.

---

## 2. The database password

```bash
docker compose exec postgres psql -U admin -d rabitech \
  -c "ALTER USER admin WITH PASSWORD 'the-new-one';"
```

Then update **both** values in `.env` — they must match, and they are two
separate lines that are easy to change one of:

```bash
POSTGRES_PASSWORD=the-new-one
DATABASE_URL=postgresql://admin:the-new-one@postgres:5432/rabitech
```

```bash
docker compose up -d
```

Verify by watching the boot log stop complaining about `DATABASE_URL`.

---

## 3. The gateway API key

`dev-admin-key` is the shipped default and is in this public repository.

```bash
# .env
OPENWA_API_KEY=a-long-random-value
```

The gateway and the backend both read it, so restart both together:

```bash
docker compose up -d openwa backend
```

**This does not require re-scanning any QR code.** Per
[`WHATSAPP-GATEWAY-RUNBOOK.md`](WHATSAPP-GATEWAY-RUNBOOK.md), only
`DELETE /sessions/:id` discards WhatsApp credentials — restarts and stops keep
them.

---

## 4. The JWT secret

Changing this **signs out every user on the platform at once**, including you.
That is the intended behaviour and the reason to do it during a quiet hour
rather than a busy one.

```bash
# .env
JWT_SECRET=a-long-random-value
```

```bash
docker compose up -d backend
```

---

## 5. Turn the warning off

Only once the four above are done:

```bash
# .env
ALLOW_INSECURE_SECRETS=0
```

```bash
docker compose up -d backend
```

**Verify:** the boot log no longer contains `RUNNING WITH INSECURE SECRETS`. If
it still does, it will name which value it is still unhappy about — read the
`problems` array rather than guessing.

---

## SMTP, while you are in the file

Not a rotation, but the same file and the same trip. Without it, no dunning
warning, suspension notice or recovery email leaves the building — they queue in
the outbox and are written to the log instead.

```bash
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587          # 465 for implicit TLS
SMTP_USER=notifications@yourdomain.com
SMTP_PASSWORD=
MAIL_FROM="RabiTech <notifications@yourdomain.com>"
```

The boot log tells you which state you are in, every time:

| Log line | Meaning |
|---|---|
| `SMTP verified — mail is being delivered` | Working |
| `SMTP is partially configured and will not be used` | A value is missing; still logging only |
| `Mail outbox worker started with a non-delivering provider` | Not configured; mail is logged, not sent |

---

## What is safe to commit

`.env` is not tracked, and should stay that way. `.env.example` is tracked and
must contain **names only** — never a working value, not even a development one.
A default credential printed in a public repository is a credential, not a
placeholder, which is the mistake this document exists because of.
