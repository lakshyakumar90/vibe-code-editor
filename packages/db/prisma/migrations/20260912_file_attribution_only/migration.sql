-- Keep File.updatedByUserId (file "last modified by" tracking).
-- Revert the Phase 3 AI leftovers: AI works as before, no message authorship.
DROP INDEX IF EXISTS "AIRun_conversationId_status_idx";
ALTER TABLE "AIMessage" DROP COLUMN IF EXISTS "userId";
