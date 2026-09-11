-- CreateTable
CREATE TABLE "github_connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "name" TEXT,
    "email" TEXT,
    "scope" TEXT,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastValidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_connection_userId_key" ON "github_connection"("userId");

-- CreateIndex
CREATE INDEX "github_connection_userId_idx" ON "github_connection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "github_connection_githubUserId_key" ON "github_connection"("githubUserId");

-- AddForeignKey
ALTER TABLE "github_connection" ADD CONSTRAINT "github_connection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
