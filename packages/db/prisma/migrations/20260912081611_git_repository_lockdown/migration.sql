/*
  Warnings:

  - You are about to drop the column `remoteUrl` on the `git_repository` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "git_repository" DROP COLUMN "remoteUrl",
ALTER COLUMN "importRoot" DROP NOT NULL,
ALTER COLUMN "importRoot" DROP DEFAULT;

-- Phase 4B hardening: no pre-existing importRoot value can be proven
-- (roots were never persisted before this), so every legacy row becomes
-- UNKNOWN rather than silently assuming repository root. New imports and
-- local initializations always write an explicit value.
UPDATE "git_repository" SET "importRoot" = NULL;
