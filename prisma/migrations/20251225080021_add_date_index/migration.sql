-- DropIndex
DROP INDEX "uniq_monthly_fee_per_month";

-- CreateIndex
CREATE INDEX "MonthlyFee_date_idx" ON "MonthlyFee"("date");
