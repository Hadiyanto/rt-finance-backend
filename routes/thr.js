const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
require("dotenv").config();

const prisma = new PrismaClient();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    console.error("CRITICAL: DATABASE_URL environment variable is missing!");
}

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Required by some cloud DB platforms including Supabase
});

// Generic transaction wrapper that provides a safe PoolClient
const transaction = async (callback) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    } finally {
        client.release();
    }
};

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

        // Validasi dan Insert menggunakan pg.transaction untuk mencegah race conditions
        const result = await transaction(async (client) => {
            // 1. Cek apakah THR untuk rumah dan bulan ini sudah dibayar/pending dengan FOR UPDATE (Row-level lock)
            // Note: Prisma schema uses `Thr` with Capital T, underlying postgres table might be `"Thr"` (quoted)
            // Let's check table name quoting. We'll use Prisma to query it safely or raw SQL.
            // Since we need row locking or at least transaction-level locking, we check using raw pg.

            const checkQuery = `
                SELECT id, status FROM "Thr" 
                WHERE block = $1 AND "houseNumber" = $2 AND date = $3 
                AND status IN ('PENDING', 'COMPLETED', 'WAITING_APPROVAL', 'WAITING_MANUAL_INPUT')
                FOR UPDATE
            `;
            const checkRes = await client.query(checkQuery, [block, houseNumber, paymentDate]);

            if (checkRes.rows.length > 0) {
                return {
                    error: true,
                    code: "THR_ALREADY_SUBMITTED",
                    message: "THR for this house and year has already been submitted",
                    data: checkRes.rows[0]
                };
            }

            // Determine initial status based on provided data
            let initialStatus = "PENDING";

            // 2. Insert record baru
            const insertQuery = `
                INSERT INTO "Thr" (block, "houseNumber", "fullName", date, "imageUrl", notes, amount, status, attempt, "createdAt", "updatedAt")
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
                RETURNING *
            `;

            const insertParams = [
                block,
                houseNumber,
                name,
                paymentDate,
                imageUrl || null,
                notes || null,
                amount ? parseInt(amount, 10) : null,
                initialStatus,
                1 // Manual submission counts as 1st attempt
            ];

            const insertRes = await client.query(insertQuery, insertParams);
            return { error: false, data: insertRes.rows[0] };
        });

        if (result.error) {
            return res.status(400).json({
                code: result.code,
                message: result.message,
                data: result.data
            });
        }

        return res.status(201).json({
            message: "THR manual payment submitted successfully",
            data: result.data,
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

/**
 * =========================================================
 * GET THR REKAP BY YEAR
 * =========================================================
 * Returns a list of all residents with their THR payment status
 * for a specific year.
 */
router.get("/thr/rekap/:year", async (req, res) => {
    try {
        const { year } = req.params;
        const targetYear = parseInt(year);

        if (isNaN(targetYear)) {
            return res.status(400).json({ message: "Invalid year parameter" });
        }

        const startDate = new Date(Date.UTC(targetYear, 0, 1, 0, 0, 0, 0));
        const endDate = new Date(Date.UTC(targetYear + 1, 0, 1, 0, 0, 0, 0));

        // Fetch all residents
        const residents = await prisma.resident.findMany({
            orderBy: [{ block: "asc" }, { houseNumber: "asc" }]
        });

        // Fetch THR records for the given year
        const thrRecords = await prisma.thr.findMany({
            where: {
                date: {
                    gte: startDate,
                    lt: endDate
                }
            }
        });

        // Map THR records by block and houseNumber
        const thrMap = {};
        thrRecords.forEach(record => {
            const key = `${record.block}-${record.houseNumber}`;
            // If multiple records exist (e.g., FAILED and COMPLETED), prefer COMPLETED
            if (!thrMap[key] || record.status.trim() === "COMPLETED") {
                thrMap[key] = record;
            }
        });

        // Combine data
        const rekapData = residents.map(resident => {
            const key = `${resident.block}-${resident.houseNumber}`;
            const thr = thrMap[key];

            return {
                block: resident.block,
                houseNumber: resident.houseNumber,
                fullName: resident.fullName,
                hasPaid: !!(thr && thr.status.trim() === 'COMPLETED'),
                amount: thr && thr.status.trim() === 'COMPLETED' ? thr.amount : null,
                status: thr ? thr.status.trim() : null,
                date: thr ? thr.date : null
            };
        });

        return res.json({
            year: targetYear,
            totalResidents: residents.length,
            totalPaid: rekapData.filter(r => r.hasPaid).length,
            data: rekapData
        });

    } catch (err) {
        console.error("Error fetching THR rekap:", err);
        return res.status(500).json({ message: "Internal server error" });
    }
});

module.exports = router;
