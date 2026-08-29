-- Seed the edition catalogue from PLAN_ENTITLEMENTS, byte-identically.
--
-- Day one must change nothing. These are the values the constant already
-- enforces, moved into the rows that will enforce them next; the owner edits
-- from here. A harness check asserts DB == constant field by field, so a drift
-- between the two is a failed gate rather than a surprise on someone's invoice.
--
-- Upsert rather than update: ensurePlans() creates these rows at boot, but a
-- database restored from an older dump or built fresh by the tenancy harness
-- may not have them yet, and a seed that silently does nothing on a fresh
-- database is worse than one that fails loudly.
--
-- Ids match ensurePlans()'s `plan_${code.toLowerCase()}` so the two agree about
-- identity instead of racing to create duplicates under different keys.
--
-- allowedChannels is ['OPENWA'] for every edition. That is the settled default,
-- not a policy: nothing enforces channels by edition yet, Meta does not exist in
-- code, and the intended policy is still open (OQ-2/OQ-4). Free's intended
-- policy is both channels during trial - see RABITECH-PRODUCT-VISION.md OQ-3 -
-- and is deliberately NOT seeded here, because seeding an unenforced intention
-- would make the row disagree with the constant it must match.

INSERT INTO "Plan" (
  "id", "code", "name", "monthlyPriceCents", "currency", "isActive", "sortOrder",
  "monthlyActiveContactsLimit", "monthlyOutboundMessagesLimit", "monthlyCampaignSendsLimit",
  "customFieldsLimit", "usersLimit", "workflowsLimit",
  "campaignRateMax", "campaignRateDurationMs",
  "customDomain", "whiteLabel", "maskContactDetails", "autoProvisionGateway",
  "allowedChannels", "updatedAt"
) VALUES
  ('plan_free',       'FREE',       'Free',       0,     'USD', true, 0,
   100,   100,   0,     5,    1,    1,    1, 2000, false, false, false, false, ARRAY['OPENWA']::TEXT[], NOW()),
  -- Standard: messaging and nothing else. Every feature limit is zero rather
  -- than small, because a tier granting "a few" workflows invites an argument
  -- about why three is not four, while one granting none states the boundary.
  -- The entry paid tier: above the Free trial's 100/100, below Growth's 2,500
  -- at ~$49. Owner-set values, editable from the console once this ships.
  ('plan_standard',   'STANDARD',   'Standard',   1900,  'USD', true, 1,
   500,   2000,  0,     0,    2,    0,    1, 1500, false, false, false, false, ARRAY['OPENWA']::TEXT[], NOW()),
  ('plan_growth',     'GROWTH',     'Growth',     4900,  'USD', true, 2,
   2500,  10000, 5000,  20,   5,    10,   1, 1500, false, false, false, true,  ARRAY['OPENWA']::TEXT[], NOW()),
  ('plan_business',   'BUSINESS',   'Business',   19900, 'USD', true, 3,
   10000, 50000, 25000, 50,   25,   50,   1, 1000, true,  true,  true,  true,  ARRAY['OPENWA']::TEXT[], NOW()),
  -- Enterprise carries NULL on every metered limit: null means unlimited, which
  -- is the promise the tier makes. It is not 1,000,000,000 - that sentinel lives
  -- in OrganizationConfig because those columns are NOT NULL, and it must not
  -- leak into the catalogue where it would read as a bizarre quota.
  ('plan_enterprise', 'ENTERPRISE', 'Enterprise', 0,     'USD', true, 4,
   NULL,  NULL,  NULL,  NULL, NULL, NULL, 2, 1000, true,  true,  true,  true,  ARRAY['OPENWA']::TEXT[], NOW())
ON CONFLICT ("code") DO UPDATE SET
  "name"                         = EXCLUDED."name",
  "monthlyPriceCents"            = EXCLUDED."monthlyPriceCents",
  "sortOrder"                    = EXCLUDED."sortOrder",
  "monthlyActiveContactsLimit"   = EXCLUDED."monthlyActiveContactsLimit",
  "monthlyOutboundMessagesLimit" = EXCLUDED."monthlyOutboundMessagesLimit",
  "monthlyCampaignSendsLimit"    = EXCLUDED."monthlyCampaignSendsLimit",
  "customFieldsLimit"            = EXCLUDED."customFieldsLimit",
  "usersLimit"                   = EXCLUDED."usersLimit",
  "workflowsLimit"               = EXCLUDED."workflowsLimit",
  "campaignRateMax"              = EXCLUDED."campaignRateMax",
  "campaignRateDurationMs"       = EXCLUDED."campaignRateDurationMs",
  "customDomain"                 = EXCLUDED."customDomain",
  "whiteLabel"                   = EXCLUDED."whiteLabel",
  "maskContactDetails"           = EXCLUDED."maskContactDetails",
  "autoProvisionGateway"         = EXCLUDED."autoProvisionGateway",
  "allowedChannels"              = EXCLUDED."allowedChannels",
  "updatedAt"                    = NOW();
