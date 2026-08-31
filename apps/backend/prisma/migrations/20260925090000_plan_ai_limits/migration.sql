-- AI becomes an edition-level allowance.
--
-- ai_tokens_in and ai_tokens_out were the only two metered meters with no
-- column on Plan. They existed solely on OrganizationConfig, with no endpoint
-- writing them, so AI could be negotiated into one subscriber's deal but could
-- never be part of what an edition actually sells.
--
-- Null on every edition, deliberately. Null already means unlimited everywhere
-- else in this table, and the config columns these mirror are already null on
-- every organization — so this adds the lever and changes nothing by pulling
-- it. What each edition should grant is a pricing decision, made from the
-- console once this exists, not encoded here.
--
-- BigInt to match the config columns: token counts run to millions where the
-- message meters run to thousands, and one integer width cannot serve both.

ALTER TABLE "Plan"
  ADD COLUMN "monthlyAiTokensInLimit"  BIGINT,
  ADD COLUMN "monthlyAiTokensOutLimit" BIGINT;
