/*
  Warnings:

  - Added the required column `template` to the `Project` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Template" AS ENUM ('REACT', 'VUE', 'HONO', 'EXPRESS', 'NEXTJS', 'ANGULAR');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "template" "Template" NOT NULL;
