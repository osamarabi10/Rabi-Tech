ALTER TABLE "Identity"
ADD COLUMN "totpSecretEnc" TEXT,
ADD COLUMN "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN "totpLastUsedCounter" BIGINT;

CREATE TABLE "TwoFactorChallenge" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdentityRecoveryCode" (
    "id" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IdentityRecoveryCode_codeHash_key" ON "IdentityRecoveryCode"("codeHash");
CREATE INDEX "TwoFactorChallenge_identityId_expiresAt_idx" ON "TwoFactorChallenge"("identityId", "expiresAt");
CREATE INDEX "IdentityRecoveryCode_identityId_usedAt_idx" ON "IdentityRecoveryCode"("identityId", "usedAt");

ALTER TABLE "TwoFactorChallenge"
ADD CONSTRAINT "TwoFactorChallenge_identityId_fkey"
FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IdentityRecoveryCode"
ADD CONSTRAINT "IdentityRecoveryCode_identityId_fkey"
FOREIGN KEY ("identityId") REFERENCES "Identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
