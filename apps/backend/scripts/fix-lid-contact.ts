import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const contacts = await prisma.contact.findMany();
  console.log('contacts:', contacts.map((c) => `${c.phone} (${c.name})`).join(', '));

  const stale =
    contacts.find((c) => c.phone.includes('@lid') || c.phone === '245917093507072') ?? null;
  if (!stale) {
    console.log('no stale LID contact');
    return;
  }

  const real = await prisma.contact.upsert({
    where: { phone: '972547234560' },
    create: { phone: '972547234560', name: 'Osamah Rabi' },
    update: { name: 'Osamah Rabi' },
  });

  await prisma.conversation.updateMany({
    where: { contactId: stale.id },
    data: { contactId: real.id },
  });
  await prisma.contact.delete({ where: { id: stale.id } });

  console.log('fixed contact ->', real.phone, real.name);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
