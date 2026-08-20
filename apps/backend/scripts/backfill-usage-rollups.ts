import 'dotenv/config';
import { backfillUsageRollups, parseDateOnly } from '../src/modules/usage/usage-rollup.service';
import { prisma } from '../src/prisma';

async function main() {
  const [startValue, endValue = startValue] = process.argv.slice(2);
  if (!startValue) throw new Error('Usage: npm run usage:backfill -- YYYY-MM-DD [YYYY-MM-DD]');
  const completed = await backfillUsageRollups(parseDateOnly(startValue), parseDateOnly(endValue));
  process.stdout.write(`Recomputed ${completed} organization-day usage rollups.\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
