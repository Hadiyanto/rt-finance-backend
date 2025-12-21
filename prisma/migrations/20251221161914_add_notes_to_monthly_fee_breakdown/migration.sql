-- CreateTable
CREATE TABLE "MonthlyFeeBreakdown" (
    "id" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "houseNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "kasRT" INTEGER NOT NULL,
    "agamaRT" INTEGER NOT NULL,
    "sampah" INTEGER NOT NULL,
    "keamanan" INTEGER NOT NULL,
    "agamaRW" INTEGER NOT NULL,
    "kasRW" INTEGER NOT NULL,
    "kkmRW" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyFeeBreakdown_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyFeeBreakdown_block_houseNumber_month_key" ON "MonthlyFeeBreakdown"("block", "houseNumber", "month");
