-- CreateIndex
CREATE INDEX "Contact_zoneId_idx" ON "Contact"("zoneId");

-- CreateIndex
CREATE INDEX "Contact_name_idx" ON "Contact"("name");

-- CreateIndex
CREATE INDEX "Conversation_isArchived_status_lastMessageAt_idx" ON "Conversation"("isArchived", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_contactId_sessionId_idx" ON "Conversation"("contactId", "sessionId");

-- CreateIndex
CREATE INDEX "Message_conversationId_timestamp_idx" ON "Message"("conversationId", "timestamp");

-- CreateIndex
CREATE INDEX "Message_conversationId_direction_isRead_idx" ON "Message"("conversationId", "direction", "isRead");

