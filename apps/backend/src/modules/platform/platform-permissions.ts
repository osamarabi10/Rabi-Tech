/**
 * What a support advisor is allowed to do.
 *
 * ## Why a list and not more roles
 *
 * Support work is not a ladder. One advisor handles trials and onboarding and
 * should never touch a discount; another does billing recovery and has no
 * business restarting gateways. Expressing that as roles means a new role — and
 * a migration — every time the shape of the team changes, and in practice it
 * means everybody gets the role that is closest, which is always the larger one.
 *
 * ## OWNER is not in this table
 *
 * The owner holds everything by definition, checked before this list is
 * consulted. Enumerating the owner's permissions would create a way to
 * accidentally revoke one, and there is no version of this product where the
 * person who owns it should be locked out of it.
 *
 * ## What is deliberately absent
 *
 * There is no `staff:manage` permission. Creating and empowering staff stays
 * with the owner, permanently: an advisor who can grant permissions can grant
 * themselves permissions, and every scope below becomes decoration. That is not
 * a gap to fill later — it is the boundary that makes the rest of this file
 * mean anything.
 */

export const PLATFORM_PERMISSIONS = {
  'subscriber:read': {
    label: 'View subscribers',
    detail: 'The subscriber list, usage and gateway health. Read-only.',
  },
  'subscriber:view-as': {
    label: 'Open a subscriber workspace',
    detail:
      'Sign into a workspace to see what the customer sees. Every use is written to the audit log with the advisor’s name.',
  },
  'trial:extend': {
    label: 'Extend a trial',
    detail: 'Give a workspace more trial time. Cannot activate a paid plan.',
  },
  'gateway:operate': {
    label: 'Operate gateways',
    detail: 'Retry, restart and resume a subscriber’s WhatsApp gateway.',
  },
  'gateway:suspend': {
    label: 'Suspend a gateway',
    detail: 'Stop a subscriber’s WhatsApp connection. Their customers stop being answered.',
  },
  'billing:view': {
    label: 'View billing',
    detail: 'Invoices, receipts and payment history for a subscriber.',
  },
  'billing:record-payment': {
    label: 'Record a payment',
    detail: 'Mark an invoice paid, in whole or part. Clears a suspension.',
  },
  'billing:activate': {
    label: 'Activate a plan',
    detail: 'Put a subscriber onto a paid plan without payment. Changes what they are charged.',
  },
  'commercials:manage': {
    label: 'Grant special terms',
    detail: 'Discounts, quota overrides and credit. Changes what a subscriber pays.',
  },
  'subscriber:suspend': {
    label: 'Suspend a subscriber',
    detail: 'Switch a whole workspace off, or back on.',
  },
} as const;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;

export const ALL_PLATFORM_PERMISSIONS = Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[];

/**
 * A sensible advisor: everything needed to answer a customer, nothing that
 * moves money or turns an organization off.
 *
 * Offered as a starting point in the UI rather than applied automatically —
 * a default that is silently correct teaches nobody what they granted.
 */
export const SUGGESTED_ADVISOR_PERMISSIONS: PlatformPermission[] = [
  'subscriber:read',
  'subscriber:view-as',
  'trial:extend',
  'gateway:operate',
  'billing:view',
];

export function isPlatformPermission(value: string): value is PlatformPermission {
  return Object.prototype.hasOwnProperty.call(PLATFORM_PERMISSIONS, value);
}

/**
 * Whether this platform user holds a permission.
 *
 * Fails closed on everything it does not recognise: no user, no role, an
 * unknown permission string. A typo in a route's permission name denies rather
 * than allows, which is the direction a mistake here should fall.
 */
export function hasPlatformPermission(
  user: { platformRole?: string; platformPermissions?: string[] } | undefined,
  permission: PlatformPermission,
): boolean {
  if (!user) return false;
  if (user.platformRole === 'OWNER') return true;
  if (user.platformRole !== 'SUPPORT') return false;
  return (user.platformPermissions ?? []).includes(permission);
}
