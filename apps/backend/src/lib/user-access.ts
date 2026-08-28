import { Prisma } from '@prisma/client';
import type { JwtPayload } from '../modules/auth/auth.middleware';

export function contactAccessWhere(user: JwtPayload): Prisma.ContactWhereInput {
  if (!user.restrictContactVisibility) return {};
  if (user.contactVisibilityScope === 'SELF') {
    return {
      OR: [
        { assigneeId: user.id },
        { conversations: { some: { assignedToId: user.id } } },
      ],
    };
  }
  const teamIds = user.teamIds || [];
  return {
    OR: [
      { assigneeId: user.id },
      ...(teamIds.length ? [{ conversations: { some: { teamId: { in: teamIds } } } }] : []),
    ],
  };
}

export function conversationAccessWhere(user: JwtPayload): Prisma.ConversationWhereInput {
  if (!user.restrictContactVisibility) return {};
  if (user.contactVisibilityScope === 'SELF') return { assignedToId: user.id };
  const teamIds = user.teamIds || [];
  return {
    OR: [
      { assignedToId: user.id },
      ...(teamIds.length ? [{ teamId: { in: teamIds } }] : []),
    ],
  };
}

export function maskContact<T extends Record<string, any> | null | undefined>(contact: T): T {
  if (!contact) return contact;
  return {
    ...contact,
    phone: contact.phone ? '••••••' : contact.phone,
    email: contact.email ? '••••••' : contact.email,
    phoneMasked: !!contact.phone,
    emailMasked: !!contact.email,
  } as T;
}

export function maskConversationContacts<T>(payload: T): T {
  if (Array.isArray(payload)) return payload.map(maskConversationContacts) as T;
  if (!payload || typeof payload !== 'object') return payload;
  const object = payload as Record<string, any>;
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [
    key,
    key === 'contact' ? maskContact(value) : maskConversationContacts(value),
  ])) as T;
}
