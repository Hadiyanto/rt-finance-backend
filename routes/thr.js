const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

/**
 * =========================================================
 * POST MANUAL THR PAYMENT
 * =========================================================
 * Body:
 * - block: string
 * - houseNumber: string
 * - date: string "YYYY-MM"
 * - name: string (fullName)
 * - imageUrl: string (optional)
 * - notes: string (optional)
 * - amount: number (optional)
 */
router.post("/thr-manual", async (req, res) => {
    try {
        const { block, houseNumber, date, name, imageUrl, notes, amount } = req.body;

        if (!block || !houseNumber || !date || !name) {
            return res.status(400).json({
                message: "block, houseNumber, date, and name are required",
            });
        }

        // Convert date string "YYYY-MM" to Date object (1st of the month)
        const [year, month] = date.split("-");
        let targetMonth = parseInt(month, 10);
        let targetYear = parseInt(year, 10);

        const paymentDate = new Date(Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0, 0));

        // Validasi apakah THR untuk rumah dan bulan ini sudah dibayar/pending
        const existingThr = await prisma.thr.findFirst({
            where: {
                block,
                houseNumber,
                date: paymentDate,
                status: { in: ["PENDING", "COMPLETED", "WAITING_APPROVAL", "WAITING_MANUAL_INPUT"] }
            }
        });

        if (existingThr) {
            return res.status(400).json({
                code: "THR_ALREADY_SUBMITTED",
                message: "THR for this house and year has already been submitted",
                data: existingThr
            });
        }

        // Determine initial status based on provided data
        // Default to PENDING. Could be adapted if there's a different flow.
        let initialStatus = "PENDING";

        // We can also support direct completion if logged in (admin)
        // but typically manual submissions via frontend go to PENDING

        const newPayment = await prisma.thr.create({
            data: {
                block,
                houseNumber,
                fullName: name,
                date: paymentDate,
                imageUrl: imageUrl || null,
                notes: notes || null,
                amount: amount ? parseInt(amount, 10) : null,
                status: initialStatus,
                attempt: 1, // Manual submission counts as 1st attempt
            },
        });

        return res.status(201).json({
            message: "THR manual payment submitted successfully",
            data: newPayment,
        });
    } catch (err) {
        console.error("Manual THR Error:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
});

/**
 * =========================================================
 * GET ALL THR (With filters)
 * =========================================================
 */
router.get("/thr", async (req, res) => {
    try {
        const { status, block, houseNumber, year } = req.query;

        const where = {};
        if (status) where.status = status;
        if (block) where.block = block;
        if (houseNumber) where.houseNumber = houseNumber;

        if (year) {
            const startDate = new Date(parseInt(year), 0, 1);
            const endDate = new Date(parseInt(year) + 1, 0, 1);
            where.date = {
                gte: startDate,
                lt: endDate
            };
        }

        const records = await prisma.thr.findMany({
            where,
            orderBy: [{ date: "desc" }, { block: "asc" }, { houseNumber: "asc" }],
        });

        return res.json({
            total: records.length,
            data: records,
        });
    } catch (err) {
        console.error("Error fetching THR records:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
});

module.exports = router;
