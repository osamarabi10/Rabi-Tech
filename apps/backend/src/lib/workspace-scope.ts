/**
 * Workspace resolution: the second scope axis.
 *
 * Organization scope is established by authentication and is always known.
 * A workspace is not — nothing in the product chooses one until the switcher
 * arrives — so it is resolved lazily, once per scope, and memoised on the
 * scope object.
 *
 * This module takes the Prisma client as an argument rather than importing it.
 * That is what keeps it free of a cycle: `prisma/index` builds the client from
 * `prisma/extensions`, which needs this resolver, so a static import of the
 * client here would close the loop at module-init time. `current-workspace.ts`
 * is the thin wrapper that binds the real client for ordinary callers.
 */

import { getWorkspaceIdOrNull, setScopeWorkspaceId } from './tenant-context';

/**
 * The workspace for the current organization scope, resolving it if needed.
 *
 * Throws rather than falling back when an organization has no default. A
 * fallback would file rows into whichever workspace happened to sort first, and
 * a misfiled conversation is not something anyone notices until it belongs to
 * somebody else.
 */
export async function resolveWorkspaceIdWith(
  client: { workspace: { findFirst: (args: any) => Promise<{ id: string } | null> } },
  organizationId: string,
): Promise<string> {
  const existing = getWorkspaceIdOrNull();
  if (existing) return existing;

  /*
    organizationId is named EXPLICITLY here and must stay that way.

    The caller inside the Prisma extension is handed the client being extended,
    which is the UNEXTENDED one - so a query issued from there carries no
    injected organization predicate. Relying on injection would make this read
    `the first default workspace of any organization on the platform`, and every
    subsequent query in that scope would then be filed against a stranger's
    workspace. The tenancy harness caught exactly that: org A stopped matching
    its own fixture contact.

    The rule it illustrates is general. The thing that ESTABLISHES ambient scope
    can never be a consumer of it.
  */
  const workspace = await client.workspace.findFirst({
    where: { isDefault: true, organizationId },
    select: { id: true },
  });

  if (!workspace) {
    throw new Error(
      `[TENANT_ISOLATION_VIOLATION] Organization ${organizationId} has no default workspace. `
      + 'Every organization received one in migration 20261013090000_workspaces_schema, so an '
      + 'organization without one was created by something that does not know about workspaces.',
    );
  }

  setScopeWorkspaceId(workspace.id);
  return workspace.id;
}
