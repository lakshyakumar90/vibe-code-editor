-- AlterTable
ALTER TABLE "git_repository" ADD COLUMN     "importRoot" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "remoteUrl" TEXT;
