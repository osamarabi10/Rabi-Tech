-- The Meta WhatsApp Cloud API credential vault.
--
-- Bring-your-own-token: the customer supplies their own Phone Number ID, WABA
-- ID and System User access token. RabiTech has no Meta billing relationship.
--
-- Nothing reads this table yet. The connection flow, webhook and send path come
-- in later steps; this lands the storage so those can be built against a shape
-- that is already reviewed.

-- OrganizationChannel needs a composite unique before a child can carry a
-- composite FK to it. Additive and free: id is already the primary key, so this
-- index enforces nothing that was not already true - it only makes the pair
-- referenceable, which is what lets the database reject a cross-tenant parent
-- instead of the application remembering to check.
ALTER TABLE "OrganizationChannel"
  ADD CONSTRAINT "OrganizationChannel_id_organizationId_key" UNIQUE ("id", "organizationId");

CREATE TABLE "MetaChannelCredential" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "channelId"      TEXT NOT NULL,

  -- Identifiers, not secrets. Meta puts phoneNumberId in the body of every
  -- inbound webhook, so it is already known to anyone Meta talks to, and
  -- knowing it grants nothing. Stored in plaintext because the webhook must
  -- resolve an organization from it on every inbound message, and an encrypted
  -- column cannot be looked up.
  "phoneNumberId" TEXT NOT NULL,
  "wabaId"        TEXT NOT NULL,

  -- The credential. A System User token sends AS that business, so losing one
  -- is impersonating a company to its own customers. Encrypted at rest, never
  -- returned by any endpoint.
  "accessTokenEnc" TEXT NOT NULL,

  -- Which key sealed this row. CHANNEL_ENCRYPTION_KEY has no rotation routine,
  -- and rotating it today would orphan every encrypted row with no remedy but
  -- asking every customer to re-enter their credentials. This column exists so
  -- a future re-encryption can tell which rows it has already migrated.
  -- Rotation stays out of scope; retrofitting this column later would not.
  "keyVersion" INTEGER NOT NULL DEFAULT 1,

  -- Tokens die on their own: a password change, a permission revoke, or the
  -- System User being deleted. A credential that worked yesterday is not
  -- assumed to work today, so the channel can degrade rather than fail per
  -- message with no explanation.
  "status"          TEXT NOT NULL DEFAULT 'PENDING',
  "invalidReason"   TEXT,
  "lastValidatedAt" TIMESTAMP(3),

  -- Non-secret values read back from Meta, so the console can show which number
  -- is connected, and its tier and quality, without decrypting anything.
  "displayPhoneNumber" TEXT,
  "verifiedName"       TEXT,
  "qualityRating"      TEXT,
  "messagingTier"      TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MetaChannelCredential_pkey" PRIMARY KEY ("id")
);

-- Tenant isolation enforced by the database, not by application logic.
CREATE UNIQUE INDEX "MetaChannelCredential_id_organizationId_key"
  ON "MetaChannelCredential" ("id", "organizationId");

-- One channel, one credential set.
CREATE UNIQUE INDEX "MetaChannelCredential_channelId_organizationId_key"
  ON "MetaChannelCredential" ("channelId", "organizationId");

-- GLOBALLY unique, deliberately, and the most important line in this file.
--
-- Meta posts every customer's messages to one URL, so phoneNumberId is the only
-- key the inbound webhook has to decide which organization a message belongs
-- to. Two rows sharing it would make that resolution ambiguous - and on this
-- path, ambiguous means delivering one business's customer conversations into
-- another business's inbox. The database refuses it rather than the application
-- remembering to check.
CREATE UNIQUE INDEX "MetaChannelCredential_phoneNumberId_key"
  ON "MetaChannelCredential" ("phoneNumberId");

CREATE INDEX "MetaChannelCredential_organizationId_status_idx"
  ON "MetaChannelCredential" ("organizationId", "status");

ALTER TABLE "MetaChannelCredential"
  ADD CONSTRAINT "MetaChannelCredential_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite parent FK: a credential cannot point at a channel belonging to a
-- different organization, because the pair must exist together in the parent.
ALTER TABLE "MetaChannelCredential"
  ADD CONSTRAINT "MetaChannelCredential_channelId_organizationId_fkey"
  FOREIGN KEY ("channelId", "organizationId")
  REFERENCES "OrganizationChannel"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
