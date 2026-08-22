/**
 * Turn a gateway send error into a sentence an agent can act on.
 *
 * A failed send used to reach the agent as a red cross in the corner of a
 * bubble. That says something went wrong and nothing about what: an unlinked
 * session, a number that is not on WhatsApp, and the gateway container being
 * down all looked identical, and all three have different fixes.
 *
 * The classification is deliberately coarse. OpenWA is an unofficial gateway
 * and its error text is not a stable contract, so this matches on the few
 * shapes that are reliable and falls back to a truthful "unknown" rather than
 * guessing. The precise upstream text still goes to the log for whoever is
 * debugging; the agent gets the part that changes what they do next.
 */

export type SendFailure = {
  /** Stable machine code, for anything that wants to branch on the cause. */
  code: 'channel-down' | 'not-on-whatsapp' | 'media-rejected' | 'unknown';
  /** What the agent is shown. */
  reason: string;
  /** Whether trying the same send again could plausibly succeed. */
  retryable: boolean;
};

export function describeSendFailure(error: unknown): SendFailure {
  const response = (error as any)?.response;
  const data = response?.data;

  /**
   * Every field the gateway might have put the cause in, concatenated.
   *
   * Reading only the first non-null one classified almost everything as
   * unknown: OpenWA answers a send to an unstarted session with
   * `{ error: 'Bad Request', message: "Session '…' is not active…" }`, and
   * `error` — the field that gets read first and says nothing — shadowed the
   * `message` that says everything. Concatenating removes the guess about
   * which field this particular failure used.
   */
  const text = [
    typeof data === 'string' ? data : '',
    data?.message,
    data?.error,
    data?.reason,
    response?.statusText,
    (error as any)?.code,
    (error as any)?.message,
  ]
    .filter((part) => typeof part === 'string' && part)
    .join(' | ')
    .toLowerCase();

  // The gateway itself is unreachable, or the session behind this number is not
  // linked. Retrying is exactly right — once the channel is back.
  if (
    text.includes('econnrefused') ||
    text.includes('enotfound') ||
    text.includes('etimedout') ||
    text.includes('socket hang up') ||
    text.includes('not found for organization') ||
    text.includes('is not configured') ||
    // OpenWA's own wording for a session that exists but was never started
    // or has dropped. Verified against the running gateway rather than
    // guessed: it answers 400 with "Session '<id>' is not active."
    text.includes('is not active') ||
    text.includes('start the session') ||
    text.includes('not authenticated') ||
    text.includes('disconnected') ||
    (text.includes('session') && text.includes('not found'))
  ) {
    return {
      code: 'channel-down',
      reason: 'القناة غير متصلة — الرسالة محفوظة وفيك تعيد الإرسال لما ترجع',
      retryable: true,
    };
  }

  // The recipient is not reachable on WhatsApp. Sending the same thing again
  // will fail the same way, so the retry button would be a lie.
  if (
    text.includes('not a whatsapp') ||
    text.includes('invalid number') ||
    text.includes('phone not registered') ||
    text.includes('not registered')
  ) {
    return {
      code: 'not-on-whatsapp',
      reason: 'الرقم مش مسجّل على واتساب',
      retryable: false,
    };
  }

  if (text.includes('media') || text.includes('file too large') || text.includes('unsupported')) {
    return {
      code: 'media-rejected',
      reason: 'المرفق مرفوض من واتساب — جرّب ملف أصغر أو صيغة تانية',
      retryable: false,
    };
  }

  return {
    code: 'unknown',
    reason: 'تعذّر الإرسال عبر واتساب — الرسالة محفوظة، فيك تعيد المحاولة',
    retryable: true,
  };
}
