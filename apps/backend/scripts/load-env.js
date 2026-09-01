/**
 * Load the one `.env` this project has, before anything that reads it.
 *
 * **Require this first, above every other require, in every gate script.**
 * It is a side-effect module: the position matters, not the return value.
 *
 * ## Why this exists (D-12)
 *
 * A gate script names no environment variable itself. It requires
 * `dist/prisma`, or `redis-coordination`, or the backup service, and *those*
 * read `DATABASE_URL` and `REDIS_URL` at module load. So nothing in the script
 * signals the dependency, and nothing fails at the point the mistake was made.
 *
 * What happens instead is worse than a crash: without this loader the script
 * reads whatever the shell happened to be carrying. It fails with
 * "Environment variable not found" in a clean terminal and passes in one where
 * somebody exported the value an hour ago — so the result reports on the
 * terminal it was launched from rather than on the code it claims to check.
 * That is the D-5 / D-10 / D-12 / D-16 family, which this repository has now
 * been bitten by four times.
 *
 * ## Why the repo root, and not `apps/backend`
 *
 * There is one `.env` for this project and it lives at the top. A second copy
 * under `apps/backend` once drifted from it and pointed the tenancy harness at
 * `localhost:5432` — a different Postgres entirely, where it created its
 * disposable schema and proved nothing about isolation. Two files meant two
 * truths, and the wrong one was silently winning.
 *
 * ## What this deliberately does not do
 *
 * It does not override a variable that is already set. `dotenv` leaves an
 * existing value alone, which is what lets CI supply its own `DATABASE_URL`
 * (see `.github/workflows/tenancy-bleed.yml`) and lets the tenancy harness
 * point a child process at its disposable schema. The file is the default, not
 * an override.
 *
 * A gate that needs no environment at all should not require this — say so in
 * its header instead, the way `verify-backup-replication.js` does. Loading an
 * environment a check does not use is how a hermetic gate quietly stops being
 * hermetic.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
