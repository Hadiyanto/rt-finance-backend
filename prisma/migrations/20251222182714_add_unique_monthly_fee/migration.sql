-- Prevent duplicate monthly fee per house per month
CREATE UNIQUE INDEX uniq_monthly_fee_per_month
ON "MonthlyFee"(block, "houseNumber", date);
