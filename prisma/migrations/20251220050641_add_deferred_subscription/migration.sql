-- CreateEnum
CREATE TYPE "CashBucket" AS ENUM ('CASH', 'DEFERRED');

-- AlterTable
ALTER TABLE "CashLedger" ADD COLUMN     "bucket" "CashBucket" NOT NULL DEFAULT 'CASH';

-- CreateTable
CREATE TABLE "DeferredSubscription" (
    "id" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "houseNumber" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "monthlyAmount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "startMonth" TEXT NOT NULL,
    "endMonth" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeferredSubscription_pkey" PRIMARY KEY ("id")
);
