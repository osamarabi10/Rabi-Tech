import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Remove simulated/test contacts that are not real WhatsApp customers. */
const TEST_PHONES = ['972501234567'];

async function main() {
  for (const phone of TEST_PHONES) {
    const contact = await prisma.contact.findUnique({ where: { phone } });
    if (!contact) continue;

    const convs = await prisma.conversation.findMany({ where: { contactId: contact.id } });
    for (const c of convs) {
      await prisma.ticket.deleteMany({ where: { conversationId: c.id } });
      await prisma.message.deleteMany({ where: { conversationId: c.id } });
      await prisma.conversation.delete({ where: { id: c.id } });
    }
    await prisma.contact.delete({ where: { id: contact.id } });
    console.log(`removed test contact ${phone}`);
  }
  console.log('cleanup done');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
