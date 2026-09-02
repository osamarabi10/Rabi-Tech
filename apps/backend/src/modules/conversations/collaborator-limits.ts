/**
 * The collaborator ceiling, in one place.
 *
 * Extracted because there are now two doors onto the same table: the explicit
 * route in `conversations.routes.ts`, and the @mention path in
 * `notification-service.ts` when `mentionAddsCollaborator` is on. A constant
 * defined beside one of them is a limit the other is free to ignore — and a
 * cap enforced on one path only is a cap that reports the wrong number the
 * first time somebody uses the other.
 *
 * Nine, matching Respond.io. A thread everybody is on is a thread nobody owns:
 * the assignee stops meaning anything and the Collaborations inbox becomes a
 * second copy of All.
 */
export const MAX_COLLABORATORS_PER_CONVERSATION = 9;
