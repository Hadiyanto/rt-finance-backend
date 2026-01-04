-- AlterTable
ALTER TABLE "MonthlyFee" ADD COLUMN     "rwSubmissionId" TEXT;

-- CreateTable
CREATE TABLE "RWSubmission" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RWSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MonthlyFee_rwSubmissionId_idx" ON "MonthlyFee"("rwSubmissionId");

-- AddForeignKey
ALTER TABLE "MonthlyFee" ADD CONSTRAINT "MonthlyFee_rwSubmissionId_fkey" FOREIGN KEY ("rwSubmissionId") REFERENCES "RWSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
