-- Add deletedAt column to support soft deletes via the Prisma Client
-- Extension registered in src/prisma.ts. Existing rows default to NULL
-- (not deleted).
ALTER TABLE "courses" ADD COLUMN "deletedAt" TIMESTAMP(3);
