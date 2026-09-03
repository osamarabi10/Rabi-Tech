/**
 * Prisma Extension: Automatic Tenant Context Injection
 *
 * This extension auto-injects organizationId into all queries.
 * It's a fail-closed system: missing context = immediate error.
 *
 * Pattern:
 * - Organization scope: auto-inject organizationId into where/data
 * - Platform scope: skip injection (cross-org access)
 * - No scope: throw immediately (security boundary)
 */

import { Prisma } from '@prisma/client';
import { resolveWorkspaceIdWith } from '../lib/workspace-scope';
import { tenantStore, getTenantId } from '../lib/tenant-context';

// Models that are NOT tenant-scoped (they're org/global)
const PLATFORM_MODELS = new Set([
  'Organization',
  'Identity',
  'TwoFactorChallenge',
  'IdentityRecoveryCode',
  'Zone',
  'Alert',
  'Migration',
  'PlatformAuditLog',
  'PlatformAlert',
  'Plan',
  'PaymentEvent',
  'SignupThrottleEvent',
]);

/**
 * The models scoped by workspace as well as by organization.
 *
 * Exactly four, and the number is the point. Organization scope applies to all
 * 60 tenant tables; workspace scope applies to the four that hold a division's
 * own work — its channel, its people, its threads, its messages. The other 54
 * are organization-wide by design: one billing account, one set of teams, one
 * keyword list, one seat count. Adding a model here is a product decision about
 * what a workspace owns, not a consistency exercise.
 *
 * User is deliberately absent, and that absence is load-bearing. Seats are
 * counted as User rows, so a person who works in five workspaces is one row and
 * one seat. Putting User here would make them five. The workspace harness
 * asserts both halves of that — the count and this list — because either alone
 * leaves the other reachable.
 */
export const WORKSPACE_SCOPED = new Set([
  'Contact',
  'Conversation',
  'Message',
  'WhatsappSession',
]);

export const tenancyExtension = Prisma.defineExtension((client) => {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scope = tenantStore.getStore();

          // Security: No context = immediate failure (fail-closed)
          if (!scope) {
            throw new Error(
              `[TENANT_ISOLATION_VIOLATION] Query ${model}.${operation}() executed ` +
              `without tenant context. This is a critical security boundary violation. ` +
              `Ensure all handlers are wrapped in runAsOrganization() or runAsPlatform().`
            );
          }

          if (
            model === 'UsageEvent' &&
            ['update', 'updateMany', 'upsert', 'delete', 'deleteMany'].includes(operation)
          ) {
            throw new Error('UsageEvent is append-only and cannot be updated or deleted');
          }

          // Platform scope: skip injection, allow cross-org access
          if (scope.type === 'PLATFORM') {
            return query(args);
          }

          // Organization scope: auto-inject organizationId
          const organizationId = scope.organizationId;

          // Skip injection for platform models
          if (PLATFORM_MODELS.has(model)) {
            return query(args);
          }

          const anyArgs = (args ?? {}) as any;

          // Inject into data (create/createMany/update/upsert)
          if (operation === 'create' && anyArgs?.data) {
            anyArgs.data = { ...anyArgs.data, organizationId };
          }

          if (operation === 'createMany' && anyArgs?.data) {
            if (Array.isArray(anyArgs.data)) {
              anyArgs.data = anyArgs.data.map((d: any) => ({ ...d, organizationId }));
            } else {
              anyArgs.data = { ...anyArgs.data, organizationId };
            }
          }

          if (operation === 'upsert') {
            if (anyArgs?.create) {
              anyArgs.create = { ...anyArgs.create, organizationId };
            }
            if (anyArgs?.where) {
              anyArgs.where = { ...anyArgs.where, organizationId };
            }
          }

          // Inject into where for the operations whose `where` Prisma requires.
          //
          // These cannot be issued without one, so augmenting an existing where
          // is sufficient: there is no "absent where" case that is also a valid
          // query, and manufacturing one would turn an invalid call into a
          // differently invalid call rather than into a safe one.
          if (['findUnique', 'findUniqueOrThrow', 'update', 'delete'].includes(operation)) {
            if (anyArgs?.where) {
              anyArgs.where = { ...anyArgs.where, organizationId };
            }
          }

          // updateMany and deleteMany take an OPTIONAL where, and that is the
          // entire difference.
          //
          // Augmenting only an existing where meant `deleteMany({})` and
          // `updateMany({ data })` reached the database with no tenant
          // predicate at all — not "delete mine" but "delete every
          // organization's", silently, with no error raised and no scope
          // violation logged. The operation that destroys the most rows was the
          // one operation that could run unscoped.
          //
          // Found through system.routes.ts:178, where creating a default team
          // cleared isDefault on every team on the platform. These belong with
          // the read operations below — the branch that CREATES the where when
          // it is absent rather than only augmenting one that exists.
          if (['updateMany', 'deleteMany'].includes(operation)) {
            anyArgs.where = { ...(anyArgs.where || {}), organizationId };
          }

          // Inject into the filter for read and aggregate operations.
          //
          // findFirst and findFirstOrThrow were missing from here AND from the
          // list above, so they ran completely unscoped: a findFirst by id in
          // one tenant would happily return another tenant's row. They take an
          // optional `where` exactly like findMany, so they belong in this
          // branch — the one that creates `where` when absent rather than only
          // augmenting an existing one.
          if (['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy'].includes(operation)) {
            anyArgs.where = { ...(anyArgs.where || {}), organizationId };
          }

          /*
            Workspace scope: the second axis, for four models only.

            Placed after the organization pass and reusing the same anyArgs, so
            a workspace-scoped query carries BOTH predicates. That ordering is
            not cosmetic — workspace scope narrows within an organization and is
            never a substitute for it. A row is reachable only when both match,
            which is exactly what the composite foreign keys added in the
            accompanying migration enforce at the database.
          */
          if (WORKSPACE_SCOPED.has(model)) {
            const workspaceId = await resolveWorkspaceIdWith(client as any, organizationId);

            if (operation === 'create' && anyArgs?.data) {
              anyArgs.data = { workspaceId, ...anyArgs.data };
            }

            if (operation === 'createMany' && anyArgs?.data) {
              anyArgs.data = Array.isArray(anyArgs.data)
                ? anyArgs.data.map((d: any) => ({ workspaceId, ...d }))
                : { workspaceId, ...anyArgs.data };
            }

            if (operation === 'upsert') {
              if (anyArgs?.create) anyArgs.create = { workspaceId, ...anyArgs.create };
              if (anyArgs?.where) anyArgs.where = { ...anyArgs.where, workspaceId };
            }

            if (['findUnique', 'findUniqueOrThrow', 'update', 'delete'].includes(operation)) {
              if (anyArgs?.where) anyArgs.where = { ...anyArgs.where, workspaceId };
            }

            if (['updateMany', 'deleteMany'].includes(operation)) {
              anyArgs.where = { ...(anyArgs.where || {}), workspaceId };
            }

            if (['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy'].includes(operation)) {
              anyArgs.where = { ...(anyArgs.where || {}), workspaceId };
            }
          }

          return query(anyArgs);
        },
      },
    },
  });
});

