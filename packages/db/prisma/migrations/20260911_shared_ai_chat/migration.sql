-- Shared AI chat: server-derived message authorship + file last-modified-by.
-- Additive, nullable, backward compatible.

-- AlterTable: AIMessage gains nullable author id (null = assistant/system).
ALTER TABLE "AIMessage" ADD COLUMN "userId" TEXT;

-- AlterTable: File gains nullable last-modified-by user id.
ALTER TABLE "File" ADD COLUMN "updatedByUserId" TEXT;

-- CreateIndex: fast per-chat active-run lookup (conversationId + status).
CREATE INDEX "AIRun_conversationId_status_idx" ON "AIRun"("conversationId", "status");
