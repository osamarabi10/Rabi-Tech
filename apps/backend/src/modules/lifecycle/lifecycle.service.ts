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
export const DEFAULT_LIFECYCLE_STAGES: { name: string; color: string; orderIndex: number }[] = [
  { name: 'Lead', color: '#64748B', orderIndex: 0 },
  { name: 'Contacted', color: '#0066FF', orderIndex: 1 },
  { name: 'Qualified', color: '#8B5CF6', orderIndex: 2 },
  { name: 'Customer', color: '#10B981', orderIndex: 3 },
  { name: 'Unqualified', color: '#EF4444', orderIndex: 4 },
];

/**
 * Seed the default pipeline for a new organization.
 *
 * Takes a transaction client so it composes into the signup transaction: a
 * workspace that exists without its stage list would show an empty selector on
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
