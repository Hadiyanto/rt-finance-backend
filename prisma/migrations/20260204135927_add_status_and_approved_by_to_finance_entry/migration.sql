/*
  Warnings:

  - Added the required column `updatedAt` to the `FinanceEntry` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "FinanceEntry" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" INTEGER,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "FinanceEntry_status_idx" ON "FinanceEntry"("status");

-- CreateIndex
CREATE INDEX "FinanceEntry_date_idx" ON "FinanceEntry"("date");
