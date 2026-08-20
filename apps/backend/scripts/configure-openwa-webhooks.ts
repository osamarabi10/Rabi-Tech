import 'dotenv/config';
import { runAsOrganization, runAsPlatform } from '../src/lib/tenant-context';
import { OpenWAService } from '../src/modules/whatsapp/openwa.service';
import { prisma } from '../src/prisma';

async function main() {
  const backendUrl = (
    process.env.BACKEND_INTERNAL_URL || 'http://host.docker.internal:4000'
  ).replace(/\/$/, '');
  const channels = await runAsPlatform('configure-openwa-webhooks', () =>
    prisma.organizationChannel.findMany({
      where: { kind: 'OPENWA', status: 'ACTIVE' },
      select: { organizationId: true, webhookToken: true },
    }),
  );

  let created = 0;
  for (const channel of channels) {
    created += await runAsOrganization(channel.organizationId, () =>
      OpenWAService.ensureWebhook(
        `${backendUrl}/webhooks/openwa/${channel.webhookToken}`,
      ),
    );
  }
  process.stdout.write(`Created ${created} OpenWA webhook registration(s).\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
