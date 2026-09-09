import jwt, { type JwtPayload } from 'jsonwebtoken';
import { canonicalSupportTicketReference } from '../support-tickets/support-tickets.service';

export const PLATFORM_VIEW_DURATION_SECONDS = 15 * 60;
export const PLATFORM_VIEW_TOKEN_HEADER = 'x-platform-view-token';
export const MIN_PLATFORM_VIEW_REASON_LENGTH = 12;
export const MAX_PLATFORM_VIEW_REASON_LENGTH = 500;
export const MAX_PLATFORM_TICKET_REFERENCE_LENGTH = 32;

const PLATFORM_VIEW_AUDIENCE = 'rabitech-platform-view';
const PLATFORM_VIEW_ISSUER = 'rabitech';

export class PlatformViewInputError extends Error {
  constructor(
    public readonly field: 'reason' | 'ticketReference',
    message: string,
  ) {
    super(message);
    this.name = 'PlatformViewInputError';
  }
}

export type PlatformViewRequest = {
  reason: string;
  ticketReference: string;
};

export type PlatformViewGrantClaims = JwtPayload & {
  scope: 'PLATFORM_VIEW';
  actorIdentityId: string;
  organizationId: string;
  auditLogId: string;
  supportTicketId: string;
  ticketAccessVersion: number;
};

function normalized(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function length(value: string): number {
  return Array.from(value).length;
}

/** A human reason, not a checkbox disguised as free text. */
export function parsePlatformViewRequest(input: unknown): PlatformViewRequest {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const reason = normalized(body.reason);
  let ticketReference = normalized(body.ticketReference);

  if (length(reason) < MIN_PLATFORM_VIEW_REASON_LENGTH) {
    throw new PlatformViewInputError(
      'reason',
      `Access reason must be at least ${MIN_PLATFORM_VIEW_REASON_LENGTH} characters`,
    );
  }
  if (length(reason) > MAX_PLATFORM_VIEW_REASON_LENGTH) {
    throw new PlatformViewInputError(
      'reason',
      `Access reason must be at most ${MAX_PLATFORM_VIEW_REASON_LENGTH} characters`,
    );
  }
  // A numeric case id belongs in ticketReference. It does not explain why a
  // person needs to read a customer's messages.
  if (!/\p{L}/u.test(reason)) {
    throw new PlatformViewInputError('reason', 'Access reason must contain words, not only numbers');
  }

  if (length(ticketReference) < 3 || length(ticketReference) > MAX_PLATFORM_TICKET_REFERENCE_LENGTH) {
    throw new PlatformViewInputError(
      'ticketReference',
      `Ticket reference must be between 3 and ${MAX_PLATFORM_TICKET_REFERENCE_LENGTH} characters`,
    );
  }
  try {
    ticketReference = canonicalSupportTicketReference(ticketReference);
  } catch {
    throw new PlatformViewInputError(
      'ticketReference',
      'Ticket reference must use the SUP-000001 format',
    );
  }

  return { reason, ticketReference };
}

function signingSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required for platform view access');
  return secret;
}

export function issuePlatformViewToken(input: {
  actorIdentityId: string;
  organizationId: string;
  auditLogId: string;
  supportTicketId: string;
  ticketAccessVersion: number;
}): { accessToken: string; expiresAt: string } {
  const accessToken = jwt.sign(
    {
      scope: 'PLATFORM_VIEW',
      actorIdentityId: input.actorIdentityId,
      organizationId: input.organizationId,
      auditLogId: input.auditLogId,
      supportTicketId: input.supportTicketId,
      ticketAccessVersion: input.ticketAccessVersion,
    },
    signingSecret(),
    {
      algorithm: 'HS256',
      audience: PLATFORM_VIEW_AUDIENCE,
      issuer: PLATFORM_VIEW_ISSUER,
      expiresIn: PLATFORM_VIEW_DURATION_SECONDS,
    },
  );
  const decoded = jwt.decode(accessToken) as JwtPayload | null;
  if (!decoded?.exp) throw new Error('Platform view token has no expiry');
  return { accessToken, expiresAt: new Date(decoded.exp * 1000).toISOString() };
}

export function verifyPlatformViewToken(token: string): PlatformViewGrantClaims {
  const decoded = jwt.verify(token, signingSecret(), {
    algorithms: ['HS256'],
    audience: PLATFORM_VIEW_AUDIENCE,
    issuer: PLATFORM_VIEW_ISSUER,
  }) as PlatformViewGrantClaims;

  if (
    decoded.scope !== 'PLATFORM_VIEW'
    || !decoded.actorIdentityId
    || !decoded.organizationId
    || !decoded.auditLogId
    || !decoded.supportTicketId
    || !Number.isInteger(decoded.ticketAccessVersion)
    || decoded.ticketAccessVersion < 1
    || !decoded.exp
  ) {
    throw new Error('Invalid platform view token');
  }
  return decoded;
}
