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
router.get("/transaction-types", auth(["admin", "bendahara"]), async (req, res) => {
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
router.get("/categories", auth(["admin", "bendahara"]), async (req, res) => {
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
 */
router.get("/finance", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const entries = await prisma.financeEntry.findMany({
      include: {
        category: true,
        type: true,
      },
      orderBy: { id: "asc" },
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
 *   "date": "2025-01-12"
 * }
 */
router.post("/finance", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const { amount, description, categoryId, typeId, date } = req.body;

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

module.exports = router;
