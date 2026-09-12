#!/usr/bin/env node
/**
 * Does the database *answer*? Not: is something accepting connections.
 *
 * ## Why this exists
 *
 * On 2026-09-11 the Docker daemon's port proxy kept accepting TCP on the
 * published Postgres port while forwarding nothing. A connect succeeded. Every
 * query timed out. Four gate runs died part-way through with a Prisma error and
 * exited 1, and not one of them was evidence about the gate — but `exit=1` is
 * the same code a real red carries, so the output could not tell them apart and
 * the difference had to be reconstructed by hand.
 *
 * The diagnosis went wrong the same way: a TCP connect was used to decide the
 * proxy had recovered. It had not. A probe that cannot tell "accepting" from
 * "answering" is the defect this repository keeps paying for, and it does not
 * stop being that when it is the tooling rather than the product.
 *
 * So the check is a query, through the same client the gates use, against the
 * same URL they use. Nothing else proves the data path end to end.
 *
 * ## Exit codes
 *
 *   0  the database answered
 *   3  ENVIRONMENT NOT READY — it did not, and nothing that needs it can run
 *
 * 3 rather than 1 on purpose. A run that could not start has not tested
 * anything, and must not wear the code that means "this failed".
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const ENVIRONMENT_NOT_READY = 3;

/**
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function databaseAnswers() {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, detail: 'DATABASE_URL is not set' };

  let where;
  try {
    const parsed = new URL(url);
    where = `${parsed.hostname}:${parsed.port}${parsed.pathname}`;
  } catch {
    return { ok: false, detail: 'DATABASE_URL is not a URL' };
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe('select 1');
    return { ok: true, detail: where };
  } catch (error) {
    const first = String(error && error.message).split('\n').map((l) => l.trim()).filter(Boolean);
    return { ok: false, detail: `${where}: ${first[first.length - 1] || 'query failed'}` };
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  databaseAnswers().then((result) => {
    if (result.ok) {
      process.stdout.write(`database answers: ${result.detail}\n`);
      process.exit(0);
    }
    process.stdout.write(`ENVIRONMENT NOT READY — the database did not answer a query: ${result.detail}\n`);
    process.stdout.write('Nothing that needs the database can produce a result, so nothing here is a red.\n');
    process.exit(ENVIRONMENT_NOT_READY);
  });
}

module.exports = { databaseAnswers, ENVIRONMENT_NOT_READY };
