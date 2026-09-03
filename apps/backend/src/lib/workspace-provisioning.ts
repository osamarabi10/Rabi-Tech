/**
 * The default workspace an organization is created with.
 *
 * Migration 20261013090000_workspaces_schema gave every existing organization
 * one, deriving its id as `ws_` || organization.id so the backfill could be
 * re-run without stranding rows. Organizations created AFTER that migration get
 * theirs here, and they must agree — an organization provisioned without a
 * default workspace cannot resolve a scope, so its very first inbound message
 * throws.
 *
 * The derivation lives here rather than being spelled out at each call site so
 * that the migration and the application cannot drift into two conventions. If
 * this ever changes, the migration's down.sql guard 1 — which recognises its own
 * rows by exactly this shape — has to change with it.
 */

export function defaultWorkspaceIdFor(organizationId: string): string {
  return `ws_${organizationId}`;
}

export function workspaceMemberIdFor(userId: string): string {
  return `wsm_${userId}`;
}

/** The default workspace's row, ready to hand to `create`. */
export function defaultWorkspaceData(organizationId: string, organizationName: string) {
  return {
    id: defaultWorkspaceIdFor(organizationId),
    organizationId,
    name: organizationName,
    isDefault: true,
  };
}

/**
 * A membership row mirroring the user's organization role.
 *
 * Copied rather than defaulted, for the same reason the backfill copied it:
 * a default would silently re-permission somebody, and down.sql guard 2
 * measures divergence against the copy.
 */
export function workspaceMemberData(
  organizationId: string,
  userId: string,
  role: 'ADMIN' | 'SUPERVISOR' | 'AGENT' | 'VIEWER' | 'FINANCE',
) {
  return {
    id: workspaceMemberIdFor(userId),
    organizationId,
    workspaceId: defaultWorkspaceIdFor(organizationId),
    userId,
    role,
  };
}
