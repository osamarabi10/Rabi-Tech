import type { Prisma } from '@prisma/client';

/**
 * The default contact lifecycle.
 *
 * Seeded per organization as editable rows, not read from here at runtime. A
 * subscriber renaming "Lead" to something in their own language, reordering the
 * pipeline, or deleting a stage they do not use must be a settings change — the
 * moment this array were consulted to *render* a selector, that stops being
 * true and the product is dictating vocabulary to the business using it.
 *
 * Mirrors the seed in `20260828090000_lifecycle_stages`, which backfills
 * organizations that already existed. The two must agree, so a tenant created
 * before that migration and one created after start identical.
 */
export const DEFAULT_LIFECYCLE_STAGES: {
  name: string;
  description: string;
  color: string;
  emoji?: string;
  kind: 'ACTIVE' | 'LOST';
  isDefault?: boolean;
  isWon?: boolean;
  orderIndex: number;
}[] = [
  { name: 'Lead', description: 'A new contact entering the sales process.', color: '#64748B', kind: 'ACTIVE', isDefault: true, orderIndex: 0 },
  { name: 'Contacted', description: 'The team has started a conversation.', color: '#0066FF', kind: 'ACTIVE', orderIndex: 1 },
  { name: 'Qualified', description: 'The contact is a viable opportunity.', color: '#8B5CF6', kind: 'ACTIVE', orderIndex: 2 },
  { name: 'Customer', description: 'The contact completed the desired conversion.', color: '#10B981', kind: 'ACTIVE', isWon: true, orderIndex: 3 },
  { name: 'Unqualified', description: 'The contact does not fit the current offer.', color: '#EF4444', emoji: 'X', kind: 'LOST', orderIndex: 0 },
];

/**
 * Seed the default pipeline for a new organization.
 *
 * Takes a transaction client so it composes into the signup transaction: a
 * organization that exists without its stage list would show an empty selector on
 * the first contact anyone opened.
 */
export async function seedLifecycleStages(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.lifecycleStage.createMany({
    data: DEFAULT_LIFECYCLE_STAGES.map((stage) => ({ ...stage, organizationId })),
    // A retried signup must not fail on the second attempt.
    skipDuplicates: true,
  });
}
