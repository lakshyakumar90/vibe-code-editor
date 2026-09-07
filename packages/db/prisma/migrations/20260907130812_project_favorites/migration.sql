-- CreateTable
CREATE TABLE "project_favorite" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_favorite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_favorite_userId_idx" ON "project_favorite"("userId");

-- CreateIndex
CREATE INDEX "project_favorite_projectId_idx" ON "project_favorite"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "project_favorite_projectId_userId_key" ON "project_favorite"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "project_favorite" ADD CONSTRAINT "project_favorite_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_favorite" ADD CONSTRAINT "project_favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
