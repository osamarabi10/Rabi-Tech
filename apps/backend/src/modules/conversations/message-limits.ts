/**
 * How many files one composed message may carry.
 *
 * ## Why a per-message cap and not only a per-snippet one
 *
 * `MAX_SNIPPET_FILES` bounds what a saved reply stores. It says nothing about
 * what an agent assembles in the composer: attach a five-file snippet, then a
 * second, then drag in three more, and twenty files leave in one send with
 * nothing objecting.
 *
 * Respond.io caps a composed message at five **including** pre-existing
 * attachments, and the "including" is the whole rule — a cap that counts only
 * newly added files is defeated by adding them one at a time.
 *
 * ## Why it matters more than the snippet cap
 *
 * Every file is a separate provider call. Twenty of them is twenty chances to
 * fail halfway, leaving the customer with eleven of the twenty and the agent
 * with no way to tell which. On Meta each failure also costs the number's
 * quality rating, which governs how many messages the workspace may send at
 * all — so an unbounded attachment list degrades the thing it is using.
 */
export const MAX_FILES_PER_MESSAGE = 5;
