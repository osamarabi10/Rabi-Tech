import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const convs = await prisma.conversation.findMany({
    include: {
      contact: true,
      session: true,
      messages: { orderBy: { timestamp: 'desc' }, take: 1 },
      _count: { select: { messages: true } },
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  for (const c of convs) {
    console.log(
      `${c.id} | ${c.contact.phone} | ${c.contact.name ?? '-'} | ${c.session.sessionName} | msgs=${c._count.messages} | last=${c.messages[0]?.body?.slice(0, 40) ?? '-'}`
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
