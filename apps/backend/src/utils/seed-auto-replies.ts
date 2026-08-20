import type { Prisma } from '@prisma/client';
import { DEFAULT_AUTO_REPLIES } from '../constants/default-auto-replies';

/**
 * Writes the starter auto-replies into a newly provisioned organization.
 *
 * These become the organization's own editable rows. The admin can reword them,
 * deactivate them, or delete them — and deleting one means that auto-reply is
 * simply never sent. Nothing here is consulted at send time.
 *
 * Safe to call more than once: existing rows for a kind are left untouched.
 */
export async function seedDefaultAutoReplies(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<number> {
  let created = 0;
  for (const [index, def] of DEFAULT_AUTO_REPLIES.entries()) {
    const existing = await tx.messageTemplate.findFirst({
      where: { organizationId, autoReplyKind: def.kind },
      select: { id: true },
    });
    if (existing) continue;

    await tx.messageTemplate.create({
      data: {
        organizationId,
        title: def.title,
        body: def.body,
        autoReplyKind: def.kind,
        category: 'AUTO_REPLY',
        isActive: def.isActive,
        sortOrder: index,
      },
    });
    created += 1;
  }
  return created;
}
