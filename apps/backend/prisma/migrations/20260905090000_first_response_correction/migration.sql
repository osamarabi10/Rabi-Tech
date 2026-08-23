-- Correct `firstResponseAt` to what the live stamper would have produced.
--
-- The M7 backfill (20260826090000_analytics_reporting) took the first human
-- outbound message in each thread and called it the response. The live stamper
-- in `analytics/response-time.ts` is stricter, and deliberately so: it fires
-- only when the conversation *already holds an inbound message*, because an
-- agent-initiated thread has nothing to respond to.
--
-- The backfill omitted that condition, which produced two kinds of wrong row.
-- Both were measured against this database before this migration was written.
--
--   1. Threads with no inbound message at all, stamped as answered. One
--      reported a 0.2-minute response; another 850.8. Neither answered anybody.
--
--   2. Threads where the agent wrote first and the customer replied later. The
--      backfill stamped the agent's opening message, so the "response" predates
--      the question it supposedly answered. One such row reported 14.9 minutes
--      where the true first response was 2305.5 — wrong by a factor of 155, and
--      wrong in the flattering direction.
--
-- Both are corrected here rather than only the first, because clearing the
-- obvious ones and leaving the subtle ones would leave the metric quietly wrong
-- and looking fixed.
--
-- This changes published historic reporting numbers. That is the point, and it
-- was an explicit decision rather than a side effect of unrelated work.

-- ── 1. Never answered anybody ───────────────────────────────────────────────
UPDATE "Conversation" c
SET "firstResponseAt" = NULL
WHERE c."firstResponseAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Message" m
    WHERE m."conversationId" = c.id AND m.direction = 'INBOUND'
  );

-- ── 2. Answered before being asked ──────────────────────────────────────────
--
-- Re-stamped to the first human, customer-facing outbound that came *after* the
-- customer's first message — which is exactly the row the live stamper would
-- have caught had it been running. Auto-replies and internal notes stay
-- excluded for the same reason they always were: an auto-reply reports a
-- response time of seconds for every thread, and a note to a colleague is not a
-- response to the customer.
--
-- A thread whose only outbound messages predate the first inbound has no valid
-- response, so the subquery yields NULL and the stamp is cleared. That is the
-- correct answer, not a failure.
WITH first_inbound AS (
  SELECT "conversationId", MIN("timestamp") AS at
  FROM "Message"
  WHERE direction = 'INBOUND'
  GROUP BY "conversationId"
),
corrected AS (
  SELECT
    c.id,
    (
      SELECT MIN(m."timestamp")
      FROM "Message" m
      WHERE m."conversationId" = c.id
        AND m.direction = 'OUTBOUND'
        AND m."isAuto" = false
        AND m."isInternal" = false
        AND m."timestamp" >= f.at
    ) AS response_at
  FROM "Conversation" c
  JOIN first_inbound f ON f."conversationId" = c.id
  WHERE c."firstResponseAt" IS NOT NULL
    AND c."firstResponseAt" < f.at
)
UPDATE "Conversation" c
SET "firstResponseAt" = corrected.response_at
FROM corrected
WHERE c.id = corrected.id;
