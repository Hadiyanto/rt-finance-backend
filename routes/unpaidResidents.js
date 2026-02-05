const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const auth = require("../middlewares/auth");

/**
 * GET /api/unpaid-residents
 * Get residents who haven't paid for a specific month
 * Query params:
 *   - month: YYYY-MM (e.g., "2026-01")
 */
router.get("/unpaid-residents", auth(), async (req, res) => {
    try {
        const { month } = req.query;

        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({
                message: "Invalid month format. Use YYYY-MM (e.g., 2026-01)"
            });
        }

        // Parse month range
        const [year, monthNum] = month.split('-');
        const startDate = new Date(`${year}-${monthNum}-01T00:00:00.000Z`);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1);

        // Get all residents
        const allResidents = await prisma.resident.findMany({
            select: {
                id: true,
                block: true,
                houseNumber: true,
                fullName: true,
                phoneNumber: true,
            },
            orderBy: [
                { block: 'asc' },
                { houseNumber: 'asc' }
            ]
        });

        // Get residents who HAVE paid for this month (status = COMPLETED)
        const paidResidents = await prisma.monthlyFee.findMany({
            where: {
                date: {
                    gte: startDate,
                    lt: endDate
                },
                status: 'COMPLETED'
            },
            select: {
                block: true,
                houseNumber: true,
            }
        });

        // Create a Set of paid residents for O(1) lookup
        const paidSet = new Set(
            paidResidents.map(r => `${r.block}-${r.houseNumber}`)
        );

        // Filter out residents who have paid
        const unpaidResidents = allResidents.filter(resident => {
            const key = `${resident.block}-${resident.houseNumber}`;
            return !paidSet.has(key);
        });

        res.json({
            month,
            totalResidents: allResidents.length,
            paidCount: paidResidents.length,
            unpaidCount: unpaidResidents.length,
            unpaidResidents
        });

    } catch (err) {
        console.error("Error fetching unpaid residents:", err);
        res.status(500).json({ message: "Failed to fetch unpaid residents" });
    }
});

/**
 * GET /api/unpaid-residents/range
 * Get residents with count of unpaid months within a date range
 * Query params:
 *   - startMonth: YYYY-MM (e.g., "2026-01")
 *   - endMonth: YYYY-MM (e.g., "2026-12")
 */
router.get("/unpaid-residents/range", auth(), async (req, res) => {
    try {
        const { startMonth, endMonth } = req.query;

        if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) {
            return res.status(400).json({
                message: "Invalid startMonth format. Use YYYY-MM (e.g., 2026-01)"
            });
        }

        if (!endMonth || !/^\d{4}-\d{2}$/.test(endMonth)) {
            return res.status(400).json({
                message: "Invalid endMonth format. Use YYYY-MM (e.g., 2026-12)"
            });
        }

        // Parse date range
        const [startYear, startMonthNum] = startMonth.split('-');
        const [endYear, endMonthNum] = endMonth.split('-');

        const startDate = new Date(`${startYear}-${startMonthNum}-01T00:00:00.000Z`);
        const endDate = new Date(`${endYear}-${endMonthNum}-01T00:00:00.000Z`);
        endDate.setMonth(endDate.getMonth() + 1);

        if (startDate >= endDate) {
            return res.status(400).json({
                message: "startMonth must be before endMonth"
            });
        }

        // Calculate number of months in range
        const monthsDiff = (endDate.getFullYear() - startDate.getFullYear()) * 12 +
            (endDate.getMonth() - startDate.getMonth());

        // Get all residents
        const allResidents = await prisma.resident.findMany({
            select: {
                id: true,
                block: true,
                houseNumber: true,
                fullName: true,
                phoneNumber: true,
            },
            orderBy: [
                { block: 'asc' },
                { houseNumber: 'asc' }
            ]
        });

        // Get all payments in the date range (COMPLETED only)
        const payments = await prisma.monthlyFee.findMany({
            where: {
                date: {
                    gte: startDate,
                    lt: endDate
                },
                status: 'COMPLETED'
            },
            select: {
                block: true,
                houseNumber: true,
                date: true,
            }
        });

        // Group payments by resident
        const paymentsByResident = new Map();
        payments.forEach(payment => {
            const key = `${payment.block}-${payment.houseNumber}`;
            if (!paymentsByResident.has(key)) {
                paymentsByResident.set(key, new Set());
            }
            // Store month as YYYY-MM
            const monthKey = payment.date.toISOString().substring(0, 7);
            paymentsByResident.get(key).add(monthKey);
        });

        // Calculate unpaid months for each resident
        const unpaidData = allResidents.map(resident => {
            const key = `${resident.block}-${resident.houseNumber}`;
            const paidMonths = paymentsByResident.get(key) || new Set();
            const unpaidMonths = monthsDiff - paidMonths.size;

            return {
                ...resident,
                totalMonths: monthsDiff,
                paidMonths: paidMonths.size,
                unpaidMonths,
            };
        });

        // Sort by unpaid months descending (most unpaid first)
        unpaidData.sort((a, b) => b.unpaidMonths - a.unpaidMonths);

        // Filter only residents with unpaid months > 0
        const hasUnpaid = unpaidData.filter(r => r.unpaidMonths > 0);

        res.json({
            startMonth,
            endMonth,
            totalMonths: monthsDiff,
            totalResidents: allResidents.length,
            residentsWithUnpaid: hasUnpaid.length,
            data: unpaidData
        });

    } catch (err) {
        console.error("Error fetching unpaid range:", err);
        res.status(500).json({ message: "Failed to fetch unpaid range data" });
    }
});

module.exports = router;
