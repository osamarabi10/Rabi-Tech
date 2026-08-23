import type { Conv, InboxViewFilter } from '@/lib/data';

/**
 * Evaluating a saved view against a conversation the client already holds.
 *
 * This runs in the browser, not on the server, and that is a deliberate
 * consequence of how the inbox counts work: every number beside a scope is
 * computed from the loaded conversations, because the list endpoint has no
 * pagination. A view evaluated server-side would produce a count that disagreed
 * with the list it opens — the failure that hit the snooze counts twice.
 *
 * So every field in the grammar has to be answerable from a `Conv`. That is the
 * constraint the filter shape was designed around, and it is why `sla_status`
 * and `channel_id` are not in it. When the list is paginated, views move
 * server-side together with the other scopes, not before them.
 *
 * The server validates this same grammar on write. This file must not be more
 * permissive than that validator: a key rejected there can never appear here,
 * and a key accepted there must be honoured here or the view silently ignores
 * part of what its author asked for.
 */

/** Any-of over a list that may be absent. Absent means "no constraint". */
function anyOf(list: string[] | undefined, value: string | null): boolean {
  if (!list || list.length === 0) return true;
  if (value === null) return false;
  return list.includes(value);
}

export function matchesViewFilter(
  conv: Conv,
  filter: InboxViewFilter,
  currentUserId: string | undefined,
): boolean {
  if (filter.status && filter.status.length > 0) {
    if (!(filter.status as string[]).includes(conv.status)) return false;
  }

  if (filter.assignee !== undefined) {
    const assignee = filter.assignee;
    if (assignee === 'me') {
      // Resolved against the viewer. A shared view saying "mine" is the point:
      // each member sees their own threads through the same saved filter.
      //
      // With no signed-in user this matches nothing rather than everything —
      // an empty view during a moment of loading beats showing the whole inbox
      // under a heading that promises otherwise.
      if (!currentUserId || conv.assigneeId !== currentUserId) return false;
    } else if (assignee === 'unassigned') {
      if (conv.assigneeId) return false;
    } else if (!assignee.userIds.includes(conv.assigneeId ?? '')) {
      return false;
    }
  }

  if (!anyOf(filter.teamIds, conv.teamId)) return false;
  if (!anyOf(filter.sessionNames, conv.sessionName)) return false;
  if (!anyOf(filter.lifecycleStages, conv.lifecycleStage)) return false;

  // Labels are a list on both sides, so this is an intersection rather than a
  // membership test: the thread matches if it carries any label the view names.
  if (filter.labels && filter.labels.length > 0) {
    if (!conv.labels.some((label) => filter.labels!.includes(label))) return false;
  }

  if (filter.unansweredOnly && conv.firstResponseAt !== null) return false;

  // `includeSnoozed` is deliberately not handled here. Snoozing hides a thread
  // from every scope, which is a rule about scopes rather than about this
  // filter, and it is applied once in scopeMatches where the other scopes get
  // it too. Handling it in both places is how the two would drift apart.
  return true;
}
