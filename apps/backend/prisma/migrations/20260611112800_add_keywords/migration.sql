-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Keyword_category_idx" ON "Keyword"("category");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "Keyword_category_phrase_key" ON "Keyword"("category", "phrase");
