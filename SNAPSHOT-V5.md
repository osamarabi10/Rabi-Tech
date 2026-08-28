# RabiTech V5 Snapshot

Created: 2026-08-26

Source: `C:\Users\dev\Desktop\malan-isp`

This folder is a complete working snapshot of the RabiTech project at the paused Respond.io parity checkpoint. It includes the Git repository and current dirty worktree, application source, configuration and `.env` files, Prisma schema and migrations, documentation, `.tools/uploads`, and restore-verified database backups.

## Recovery Point

- Live database schema: migration 63.
- Draft migration 64: `20260916090000_conversation_operations`; copied but intentionally not applied.
- Fresh backup: `.tools/backups/auto-20260826-140532.dump`.
- Backup restore proof: 31 conversations, 97 messages, and 33 contacts.
- OpenWA session archive: `.tools/backups/openwa-data-20260826-171100.tar.gz` (94,241,356 bytes; 655 archive entries).
- OpenWA archive SHA-256: `9F2380263E58E33819BB0D7F1995BFEF3CC80834A9F2687322EB11209933AC9D`.
- Exact work status and remaining roadmap: `docs/RESPONDIO-PARITY-CHECKPOINT.md`.

## Copy Verification

- Source files copied: 21,898.
- Source bytes copied: 2,054,702,397.
- Copy failures: 0.
- Second synchronization pass: no changed or missing files.
- Source and snapshot checkpoint SHA-256 hashes matched.
- Source and snapshot database-backup SHA-256 hashes matched.
- Git status matched the source before this manifest was added.
- The OpenWA gateway was resumed after its persistent session volume was archived and validated.

## Excluded Generated Caches

Only reproducible build and dependency caches were excluded: `node_modules`, `.next`, `dist`, `test-results`, `playwright-report`, and `.turbo`.

Reinstall dependencies using the repository lockfiles, then start the stack from this directory with:

```powershell
docker compose up -d
```

Do not apply migration 64 until the release procedure in `docs/RESPONDIO-PARITY-CHECKPOINT.md` has been completed.
