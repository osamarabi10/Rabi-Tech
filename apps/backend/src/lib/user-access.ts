import { Prisma } from '@prisma/client';
import type { JwtPayload } from '../modules/auth/auth.middleware';

/**
 * Being a collaborator grants visibility, whatever the restriction says.
 *
 * ## The bug this closes
 *
 * A restricted agent — one limited to their own threads, or their team's — who
 * is added as a collaborator could not see the thread they were added to. The
 * add succeeded, the Collaborations inbox showed nothing, and opening the
 * conversation returned 404. Collaboration was silently broken for precisely
 * the users it matters most for: the specialist brought in to help, who is
 * restricted *because* they do not normally work these threads.
 *
 * Respond.io states this explicitly, and it is the only coherent reading:
 * adding somebody to a conversation is a deliberate grant by someone who
 * already has it. A visibility rule that silently overrides that turns the
 * feature into a no-op rather than a safeguard.
 */
const collaboratingOn = (userId: string): Prisma.ConversationWhereInput => ({
  collaborators: { some: { userId } },
});

export function contactAccessWhere(user: JwtPayload): Prisma.ContactWhereInput {
  if (!user.restrictContactVisibility) return {};
  if (user.contactVisibilityScope === 'SELF') {
    return {
      OR: [
        { assigneeId: user.id },
        { conversations: { some: { assignedToId: user.id } } },
        // Seeing the thread without seeing the contact would render the panel
        // beside it empty, which reads as a broken screen rather than a
        // permission.
        { conversations: { some: collaboratingOn(user.id) } },
      ],
    };
  }
  const teamIds = user.teamIds || [];
  return {
    OR: [
      { assigneeId: user.id },
      ...(teamIds.length ? [{ conversations: { some: { teamId: { in: teamIds } } } }] : []),
      { conversations: { some: collaboratingOn(user.id) } },
    ],
  };
}

export function conversationAccessWhere(user: JwtPayload): Prisma.ConversationWhereInput {
  if (!user.restrictContactVisibility) return {};
  if (user.contactVisibilityScope === 'SELF') {
    return { OR: [{ assignedToId: user.id }, collaboratingOn(user.id)] };
  }
  const teamIds = user.teamIds || [];
  return {
    OR: [
      { assignedToId: user.id },
      ...(teamIds.length ? [{ teamId: { in: teamIds } }] : []),
      collaboratingOn(user.id),
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
