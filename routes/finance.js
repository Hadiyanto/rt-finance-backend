const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const auth = require("../middlewares/auth");

const prisma = new PrismaClient();

/**
 * =========================================================
 * GET ALL TRANSACTION TYPES
 * =========================================================
 */
router.get("/transaction-types", async (req, res) => {
  try {
    const types = await prisma.transactionType.findMany({
      orderBy: { id: "asc" },
    });

    res.json({
      total: types.length,
      data: types,
    });
  } catch (err) {
    console.error("Error fetching transaction types:", err);
    res.status(500).json({ message: "Failed to fetch transaction types" });
  }
});

/**
 * =========================================================
 * GET ALL CATEGORIES
 * =========================================================
 */
router.get("/categories", async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      include: { type: true }, // join transaction type
      orderBy: { id: "asc" },
    });

    res.json({
      total: categories.length,
      data: categories,
    });
  } catch (err) {
    console.error("Error fetching categories:", err);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

/**
 * =========================================================
 * GET ALL FINANCE ENTRIES
 * =========================================================
 * Query params:
 * - status (optional): PENDING | APPROVED | REJECTED
 */
router.get("/finance", async (req, res) => {
  try {
    const { status } = req.query;

    // Build where clause
    const where = {};
    if (status && ["PENDING", "APPROVED", "REJECTED"].includes(status)) {
      where.status = status;
    }

    const entries = await prisma.financeEntry.findMany({
      where,
      include: {
        category: true,
        type: true,
      },
      orderBy: { date: "desc" }, // newest first
    });

    res.json({
      total: entries.length,
      data: entries,
    });
  } catch (err) {
    console.error("Error fetching finance entries:", err);
    res.status(500).json({ message: "Failed to fetch finance entries" });
  }
});

/**
 * =========================================================
 * POST SUBMIT FINANCE ENTRY
 * =========================================================
 * Expected body:
 * {
 *   "amount": 50000,
 *   "description": "Pembelian sapu",
 *   "categoryId": 4,
 *   "typeId": 2,
 *   "date": "2025-01-12",
 *   "imageUrl": "https://example.com/image.jpg"
 * }
 */
router.post("/finance", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const { amount, description, categoryId, typeId, date, imageUrl } = req.body;

    if (!amount || !categoryId || !typeId) {
      return res.status(400).json({
        message: "amount, categoryId dan typeId wajib diisi",
      });
    }

    const entry = await prisma.financeEntry.create({
      data: {
        amount,
        description,
        categoryId,
        typeId,
        date: date ? new Date(date) : new Date(),
        imageUrl,
      },
    });

    res.json({
      message: "Finance entry created",
      data: entry,
    });
  } catch (err) {
    console.error("Error creating finance entry:", err);
    res.status(500).json({ message: "Failed to create finance entry" });
  }
});

/**
 * =========================================================
 * PATCH UPDATE FINANCE ENTRY STATUS (APPROVE/REJECT)
 * =========================================================
 * Expected body:
 * {
 *   "status": "APPROVED" // or "REJECTED"
 * }
 */
router.patch("/finance/:id/status", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const userId = req.user.id; // from JWT middleware

    if (!status || !["APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({
        message: "status harus APPROVED atau REJECTED",
      });
    }

    // Check if entry exists
    const entry = await prisma.financeEntry.findUnique({
      where: { id: parseInt(id) },
    });

    if (!entry) {
      return res.status(404).json({
        message: "Finance entry tidak ditemukan",
      });
    }

    // Update status
    const updatedEntry = await prisma.financeEntry.update({
      where: { id: parseInt(id) },
      data: {
        status,
        approvedBy: userId,
        approvedAt: new Date(),
      },
      include: {
        category: true,
        type: true,
      },
    });

    res.json({
      message: `Finance entry ${status.toLowerCase()}`,
      data: updatedEntry,
    });
  } catch (err) {
    console.error("Error updating finance entry status:", err);
    res.status(500).json({ message: "Failed to update finance entry status" });
  }
});

module.exports = router;
