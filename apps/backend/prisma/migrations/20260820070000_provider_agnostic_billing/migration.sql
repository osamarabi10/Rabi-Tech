-- P6 provider-agnostic billing foundation. Additive only.

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "paymentProvider" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "paymentCustomerRef" TEXT,
  ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "downgradeGraceEndsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "downgradeGraceReason" TEXT;

CREATE TABLE IF NOT EXISTS "Plan" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "monthlyPriceCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Subscription" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "planCode" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "subscriptionRef" TEXT,
  "customerRef" TEXT,
  "externalRef" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "trialEndsAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Invoice" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'manual',
  "invoiceRef" TEXT,
  "customerRef" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "amountDueCents" INTEGER NOT NULL DEFAULT 0,
  "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "hostedInvoiceUrl" TEXT,
  "dueAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaymentEvent" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EmailVerificationToken" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SignupThrottleEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "ipAddress" TEXT NOT NULL,
  "emailDomain" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignupThrottleEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Plan_code_key" ON "Plan"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_id_organizationId_key" ON "Subscription"("id", "organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_subscriptionRef_key" ON "Subscription"("subscriptionRef");
CREATE INDEX IF NOT EXISTS "Subscription_organizationId_status_idx" ON "Subscription"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "Subscription_provider_customerRef_idx" ON "Subscription"("provider", "customerRef");
CREATE INDEX IF NOT EXISTS "Subscription_provider_subscriptionRef_idx" ON "Subscription"("provider", "subscriptionRef");
CREATE INDEX IF NOT EXISTS "Subscription_provider_externalRef_idx" ON "Subscription"("provider", "externalRef");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_id_organizationId_key" ON "Invoice"("id", "organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_provider_invoiceRef_key" ON "Invoice"("provider", "invoiceRef");
CREATE INDEX IF NOT EXISTS "Invoice_organizationId_createdAt_idx" ON "Invoice"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "Invoice_provider_customerRef_idx" ON "Invoice"("provider", "customerRef");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentEvent_provider_eventId_key" ON "PaymentEvent"("provider", "eventId");
CREATE INDEX IF NOT EXISTS "PaymentEvent_processedAt_idx" ON "PaymentEvent"("processedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerificationToken_id_organizationId_key" ON "EmailVerificationToken"("id", "organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_organizationId_consumedAt_idx" ON "EmailVerificationToken"("organizationId", "consumedAt");
CREATE INDEX IF NOT EXISTS "EmailVerificationToken_email_createdAt_idx" ON "EmailVerificationToken"("email", "createdAt");
CREATE INDEX IF NOT EXISTS "SignupThrottleEvent_ipAddress_createdAt_idx" ON "SignupThrottleEvent"("ipAddress", "createdAt");
CREATE INDEX IF NOT EXISTS "SignupThrottleEvent_emailDomain_createdAt_idx" ON "SignupThrottleEvent"("emailDomain", "createdAt");

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_planCode_fkey"
  FOREIGN KEY ("planCode") REFERENCES "Plan"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_subscriptionId_organizationId_fkey"
  FOREIGN KEY ("subscriptionId", "organizationId") REFERENCES "Subscription"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmailVerificationToken"
  ADD CONSTRAINT "EmailVerificationToken_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SignupThrottleEvent"
  ADD CONSTRAINT "SignupThrottleEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Plan" ("id", "code", "name", "monthlyPriceCents", "currency", "sortOrder")
VALUES
  ('plan_free', 'FREE', 'Free', 0, 'USD', 0),
  ('plan_growth', 'GROWTH', 'Growth', 4900, 'USD', 1),
  ('plan_business', 'BUSINESS', 'Business', 19900, 'USD', 2),
  ('plan_enterprise', 'ENTERPRISE', 'Enterprise', 0, 'USD', 3)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "monthlyPriceCents" = EXCLUDED."monthlyPriceCents",
  "currency" = EXCLUDED."currency",
  "sortOrder" = EXCLUDED."sortOrder";
