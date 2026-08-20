import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_OWNER_PASSWORD || '';
  if (!email || password.length < 8) {
    throw new Error('PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_PASSWORD (8+ characters) are required');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.identity.upsert({
    where: { email },
    update: { passwordHash, platformRole: 'OWNER' },
    create: { email, passwordHash, platformRole: 'OWNER' },
  });
  console.log(`RabiTech platform owner ready: ${email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
