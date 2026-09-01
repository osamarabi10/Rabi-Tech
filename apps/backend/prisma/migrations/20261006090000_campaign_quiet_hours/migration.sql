-- M8.4: quiet hours for broadcasts, in the recipient's local time.
--
-- A broadcast is the one thing this platform does that reaches someone who is
-- not currently talking to it. Everything else is a reply. So it is the one
-- thing that can wake somebody at 03:00, and the only place a time-of-day guard
-- is worth the complexity.
--
-- Stored as local wall-clock strings, not UTC offsets. "No messages after nine"
-- means nine o'clock, and it goes on meaning nine o'clock across a
-- daylight-saving change. An offset would drift by an hour twice a year and
-- nobody would connect the two events.
--
-- Off by default. Enabling it for existing subscribers would silently delay
-- sends they have already scheduled — a behaviour change arriving as a surprise
-- rather than as a choice.

BEGIN;

ALTER TABLE "OrganizationConfig"
  ADD COLUMN "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quietHoursStart"   TEXT    NOT NULL DEFAULT '21:00',
  ADD COLUMN "quietHoursEnd"     TEXT    NOT NULL DEFAULT '08:00';

-- HH:MM, 24-hour. Checked in the database as well as in the route because these
-- two columns are read by a worker that has no user in front of it: a malformed
-- value would parse to minute 0 and make the window silently wrong rather than
-- loudly broken, which is the failure mode this repository keeps naming.
ALTER TABLE "OrganizationConfig"
  ADD CONSTRAINT "OrganizationConfig_quietHoursStart_check"
    CHECK ("quietHoursStart" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "OrganizationConfig_quietHoursEnd_check"
    CHECK ("quietHoursEnd" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

COMMIT;
