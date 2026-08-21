-- Confirmation replies for opt-out / opt-in. Like every other auto-reply these
-- are organization-owned rows: unconfigured means nothing is sent.
ALTER TYPE "AutoReplyKind" ADD VALUE IF NOT EXISTS 'OPT_OUT_CONFIRM';
ALTER TYPE "AutoReplyKind" ADD VALUE IF NOT EXISTS 'OPT_IN_CONFIRM';
