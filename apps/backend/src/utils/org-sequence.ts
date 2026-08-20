import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../prisma';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export async function nextOrgSequence(
  tx: TransactionClient,
  organizationId: string,
  kind: string,
): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>(Prisma.sql`
    INSERT INTO "OrgSequence" ("organizationId", "kind", "value")
    VALUES (${organizationId}, ${kind}, 1)
    ON CONFLICT ("organizationId", "kind") DO UPDATE
    SET "value" = "OrgSequence"."value" + 1
    RETURNING "value"
  `);
  if (!rows[0]) throw new Error(`Failed to allocate ${kind} sequence`);
  return rows[0].value;
}

export async function allocateOrgSequence(
  organizationId: string,
  kind: string,
  client: Pick<typeof prisma, '$transaction'> = prisma,
): Promise<bigint> {
  return client.$transaction((tx) => nextOrgSequence(tx, organizationId, kind));
}
