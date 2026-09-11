-- AlterTable
ALTER TABLE "git_repository" ADD COLUMN     "initializedAt" TIMESTAMP(3),
ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3);
