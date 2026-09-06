import { Prisma } from '@prisma/client';

/**
 * How a subscription says which edition it is for.
 *
 * `Subscription.planCode` was removed in D-19. A subscription pins a
 * `PlanVersion` — the edition *as it was defined when the customer bought it* —
 * and the code is reachable through it. Holding both would be two stores for
 * one fact, which is the shape D-18 removed from `Organization`, and the rule
 * that came out of it is in AGENTS.md under Design.
 *
 * Everything that needs the code goes through here, so there is one join to get
 * wrong rather than eleven.
 */
export const SUBSCRIPTION_PLAN_SELECT = {
  planVersion: { select: { version: true, plan: { select: { code: true } } } },
} satisfies Prisma.SubscriptionSelect;

export type SubscriptionWithPlan = {
  planVersion: { version: number; plan: { code: string } };
};

/** The edition code a subscription was sold under. */
export function planCodeOf(subscription: SubscriptionWithPlan | null | undefined): string | null {
  return subscription?.planVersion?.plan?.code ?? null;
}

/**
 * The current version of an edition, by code.
 *
 * Every write path that creates or moves a subscription needs this: a
 * subscription cannot be created against a code any more, only against the
 * version that code currently resolves to. Throws rather than returning null,
 * because a plan with no current version is a half-written catalogue and
 * silently skipping it would leave a subscription unpinned.
 */
export async function currentVersionIdForPlan(
  tx: Pick<Prisma.TransactionClient, "planVersion">,
  planCode: string,
): Promise<string> {
  const version = await tx.planVersion.findFirst({
    where: { isCurrent: true, plan: { code: planCode } },
    select: { id: true },
  });
  if (!version) {
    throw new Error(`Edition ${planCode} has no current PlanVersion; the catalogue is incomplete`);
  }
  return version.id;
}
