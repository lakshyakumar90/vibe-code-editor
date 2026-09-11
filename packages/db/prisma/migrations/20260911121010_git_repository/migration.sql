-- CreateTable
CREATE TABLE "git_repository" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "githubRepoId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "currentBranch" TEXT NOT NULL,
    "importedSha" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "git_repository_projectId_key" ON "git_repository"("projectId");

-- CreateIndex
CREATE INDEX "git_repository_githubRepoId_idx" ON "git_repository"("githubRepoId");

-- CreateIndex
CREATE INDEX "git_repository_fullName_idx" ON "git_repository"("fullName");

-- AddForeignKey
ALTER TABLE "git_repository" ADD CONSTRAINT "git_repository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
