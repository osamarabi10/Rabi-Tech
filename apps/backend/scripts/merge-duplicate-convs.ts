import { consolidateAllDuplicateThreads } from '../src/utils/conversation-session';

async function main() {
  const merged = await consolidateAllDuplicateThreads();
  console.log(`consolidated ${merged} contact(s)`);
}

main()
  .catch(console.error)
  .finally(() => import('../src/prisma').then(({ prisma }) => prisma.$disconnect()));
