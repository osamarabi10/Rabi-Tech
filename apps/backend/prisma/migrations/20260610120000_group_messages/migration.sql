-- CreateTable
CREATE TABLE "GroupMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT,
    "waMessageId" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT,
    "senderName" TEXT,
    "senderId" TEXT,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupMessage_waMessageId_key" ON "GroupMessage"("waMessageId");

-- CreateIndex
CREATE INDEX "GroupMessage_sessionId_groupId_timestamp_idx" ON "GroupMessage"("sessionId", "groupId", "timestamp");

-- CreateIndex
CREATE INDEX "GroupMessage_groupId_idx" ON "GroupMessage"("groupId");

-- AddForeignKey
ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WhatsappSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
