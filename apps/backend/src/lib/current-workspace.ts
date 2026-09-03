/**
 * `currentWorkspaceId()` for ordinary callers.
 *
 * Separate from `workspace-scope.ts` only to keep the import graph acyclic:
 * that module is used by the Prisma extension and so cannot import the client,
 * while this one binds it for everybody else.
 *
 * Call sites pass the result explicitly into `create` data even though the
 * extension injects the same value at runtime. That is not redundancy — the
 * generated Prisma types require the column, and the two agreeing is checked by
 * the database itself: the composite foreign keys refuse a row whose workspace
 * disagrees with its parent's.
 */

import prisma from '../prisma';
import { getTenantId } from './tenant-context';
import { resolveWorkspaceIdWith } from './workspace-scope';

export function currentWorkspaceId(): Promise<string> {
  return resolveWorkspaceIdWith(prisma as any, getTenantId());
}
