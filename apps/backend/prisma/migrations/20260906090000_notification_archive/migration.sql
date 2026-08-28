ALTER TABLE "Notification" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Notification_organizationId_userId_archivedAt_createdAt_idx"
ON "Notification"("organizationId", "userId", "archivedAt", "createdAt");
