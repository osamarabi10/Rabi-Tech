import 'dotenv/config';
import { encryptCredential } from '../src/lib/credential-crypto';
import { runAsPlatform } from '../src/lib/tenant-context';
import { prisma } from '../src/prisma';

async function main() {
  const apiKey = process.env.OPENWA_API_KEY;
  const baseUrl = process.env.OPENWA_CHANNEL_URL || process.env.OPENWA_URL;
  if (!apiKey || !baseUrl) {
    throw new Error('OPENWA_API_KEY and OPENWA_CHANNEL_URL or OPENWA_URL are required');
  }

  const updated = await runAsPlatform('bootstrap-openwa-channel', () =>
    prisma.organizationChannel.updateMany({
      where: {
        kind: 'OPENWA',
        ...(process.env.FORCE_OPENWA_CHANNEL_UPDATE === '1' ? {} : { apiKeyEnc: '' }),
      },
      data: { apiKeyEnc: encryptCredential(apiKey), baseUrl, status: 'ACTIVE' },
    }),
  );
  process.stdout.write(`Initialized ${updated.count} OpenWA organization channel(s).\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
