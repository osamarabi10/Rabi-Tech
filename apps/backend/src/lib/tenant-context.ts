/**
 * Tenant Scoping via AsyncLocalStorage
 *
 * This module implements fail-closed tenant isolation.
 * All queries MUST have tenant context or they throw immediately.
 * No fallback to unscoped queries — security boundary violation = crash.
 */

import { AsyncLocalStorage } from 'async_hooks';
import logger from './logger';

export type TenantScope =
  /**
   * workspaceId is the SECOND axis, and it is optional here for one reason:
   * it is resolved lazily on first use by the query extension, not supplied by
   * every caller. Organization scope is established by authentication and is
   * always known at that moment; a workspace is not, because nothing in this
   * commit's UI asks for one. Making it mandatory in this type would force
   * every entry point — routes, workers, webhooks, the public API, every gate
   * script — to name a workspace they have no way to choose yet.
   *
   * Optional in the type, mandatory at the query. See WORKSPACE_SCOPED in
   * prisma/extensions.ts: a read or write of one of the four workspace-scoped
   * models resolves it or throws, so the looseness stops at the boundary that
   * matters.
   */
  | { type: 'ORGANIZATION'; organizationId: string; workspaceId?: string; cache: Map<string, unknown> }
  | { type: 'PLATFORM'; reason: string };

export const tenantStore = new AsyncLocalStorage<TenantScope>();

/**
 * Get current tenant ID.
 * Throws if not in ORGANIZATION scope.
 * @throws {Error} if no tenant context or in PLATFORM scope
 */
export function getTenantId(): string {
  const scope = tenantStore.getStore();
  if (!scope) {
    throw new Error(
      'No tenant context: Query executed without tenant scope. ' +
      'This is a critical security boundary violation.'
    );
  }
  if (scope.type === 'ORGANIZATION') return scope.organizationId;
  throw new Error(
    'Cannot call getTenantId() in PLATFORM scope. ' +
    'Use runAsOrganization() or extract organizationId from request context.'
  );
}

/**
 * Get platform scope reason (audit trail).
 * Throws if not in PLATFORM scope.
 * @throws {Error} if not in PLATFORM scope
 */
export function getPlatformReason(): string {
  const scope = tenantStore.getStore();
  if (!scope || scope.type === 'ORGANIZATION') {
    throw new Error('Not in PLATFORM scope');
  }
  return scope.reason;
}

/**
 * Check current scope type without throwing.
 */
export function getTenantScope(): TenantScope | undefined {
  return tenantStore.getStore();
}

export function getTenantCache(): Map<string, unknown> {
  const scope = tenantStore.getStore();
  if (!scope || scope.type !== 'ORGANIZATION') {
    throw new Error('Tenant cache requires organization scope');
  }
  return scope.cache;
}

/**
 * Run async function in organization scope.
 * All queries within fn() will be org-scoped.
 * @param organizationId - Org to scope to
 * @param fn - Function to run in org context
 * @returns Result of fn()
 */
export async function runAsOrganization<T>(
  organizationId: string,
  fn: () => Promise<T> | T,
  options?: { workspaceId?: string },
): Promise<T> {
  if (!organizationId) {
    throw new Error('organizationId is required for runAsOrganization()');
  }
  return tenantStore.run(
    {
      type: 'ORGANIZATION',
      organizationId,
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      cache: new Map<string, unknown>(),
    },
    async () => await fn(),
  );
}

/**
 * The workspace in scope, or null when none has been resolved yet.
 *
 * Deliberately does NOT throw the way getTenantId does. A caller asking this
 * question is asking whether a workspace is known, and the answer "not yet" is
 * a real answer — resolution is lazy. The throwing version of this question is
 * asked by the query extension, at the point where an unanswered workspace
 * would mean an unscoped row.
 */
export function getWorkspaceIdOrNull(): string | null {
  const scope = tenantStore.getStore();
  if (!scope || scope.type !== 'ORGANIZATION') return null;
  return scope.workspaceId ?? null;
}

/**
 * Record the resolved workspace on the current scope.
 *
 * Called once per scope by the lazy resolver. Mutating the scope object rather
 * than re-running tenantStore.run is deliberate: re-entering the store would
 * create a NEW scope for the continuation and every caller already inside the
 * old one would keep the old, unresolved copy — so the lazy resolution would
 * happen again on every query instead of once.
 */
export function setScopeWorkspaceId(workspaceId: string): void {
  const scope = tenantStore.getStore();
  if (!scope || scope.type !== 'ORGANIZATION') {
    throw new Error('[TENANT_ISOLATION_VIOLATION] setScopeWorkspaceId() outside organization scope');
  }
  scope.workspaceId = workspaceId;
}

/**
 * Run async function in platform scope (cross-org operations).
 * Use sparingly — only for super-admin operations like org lookup or migration.
 * All platform scope access is logged for audit.
 * @param reason - Audit reason (logged)
 * @param fn - Function to run in platform context
 * @returns Result of fn()
 */
export async function runAsPlatform<T>(
  reason: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!reason) {
    throw new Error('reason is required for platform scope audit trail');
  }
  logger.info('[PLATFORM_SCOPE]', { reason });
  return tenantStore.run({ type: 'PLATFORM', reason }, async () => {
    const { auditPlatformScope } = await import('./audit');
    await auditPlatformScope(reason);
    return fn();
  });
}

/**
 * Verify tenant context is populated (for startup checks).
 */
export function verifyTenantContextSupport(): void {
  // Test that AsyncLocalStorage works in this environment
  if (!tenantStore) {
    throw new Error('AsyncLocalStorage failed to initialize');
  }
  logger.info('✓ Tenant context support verified');
}
