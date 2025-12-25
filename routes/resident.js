const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma"); // Singleton
const redis = require("../lib/redisClient");
const auth = require("../middlewares/auth");
const cache = require("../middlewares/cache");



// Cache Key for Residents List (Versioned)
const residentsKey = (req) => {
  const { page = 1, limit = 50, block = "", search = "" } = req.query;
  const version = process.env.RESIDENT_CACHE_VERSION || "v1";
  return `residents:${version}:${page}:${limit}:${block}:${search}`;
};

router.get("/residents", auth(["admin", "bendahara"]), cache(residentsKey, 86400), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      block,
      search
    } = req.query;

    const skip = (page - 1) * limit;

    const where = {};

    // Filter by block
    if (block) {
      where.block = block;
    }

    // Search by name
    if (search) {
      where.fullName = {
        contains: search,
        mode: "insensitive"
      };
    }

    const [data, total] = await Promise.all([
      prisma.resident.findMany({
        where,
        skip: Number(skip),
        take: Number(limit),
        orderBy: { block: "asc" }
      }),
      prisma.resident.count({ where })
    ]);

    res.json({
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / limit),
      data
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch residents list" });
  }
});

// Get resident by block + houseNumber
router.get("/residents/:id", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const resident = await prisma.resident.findFirst({
      where: {
        id: id
      }
    });

    if (!resident) {
      return res.status(404).json({ error: "Resident not found" });
    }

    res.json(resident);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch resident" });
  }
});

// Get resident by block + houseNumber
router.get("/residents/:block/:houseNumber", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const { block, houseNumber } = req.params;

    const resident = await prisma.resident.findUnique({
      where: {
        block_houseNumber: { block, houseNumber }
      }
    });

    if (!resident) {
      return res.status(404).json({ error: "Resident not found" });
    }

    res.json(resident);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch resident" });
  }
});

router.put("/residents/:id", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { fullName, occupancyType, houseStatus, notes } = req.body;

    // Minimal 1 field harus ada
    if (!fullName && !occupancyType && !houseStatus && !notes) {
      return res.status(400).json({
        error: "At least one field must be provided for update."
      });
    }

    const resident = await prisma.resident.update({
      where: {
        id: id
      },
      data: {
        fullName,
        occupancyType,
        houseStatus,
        notes
        // updatedAt otomatis ter-update oleh Prisma
      }
    });

    return res.json({
      message: "Resident updated successfully",
      resident
    });

  } catch (err) {
    console.error(err);

    if (err.code === "P2025") {
      return res.status(404).json({
        error: "Resident not found with provided block and houseNumber."
      });
    }

    return res.status(500).json({ error: "Failed to update resident" });
  }
});

// Update berdasarkan block + houseNumber
router.put("/residents/:block/:houseNumber", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const { block, houseNumber } = req.params;
    const { fullName, occupancyType, houseStatus, notes } = req.body;

    // Minimal 1 field harus ada
    if (!fullName && !occupancyType && !houseStatus && !notes) {
      return res.status(400).json({
        error: "At least one field must be provided for update."
      });
    }

    const resident = await prisma.resident.update({
      where: {
        block_houseNumber: {
          block,
          houseNumber
        }
      },
      data: {
        fullName,
        occupancyType,
        houseStatus,
        notes
        // updatedAt otomatis ter-update oleh Prisma
      }
    });

    return res.json({
      message: "Resident updated successfully",
      resident
    });

  } catch (err) {
    console.error(err);

    if (err.code === "P2025") {
      return res.status(404).json({
        error: "Resident not found with provided block and houseNumber."
      });
    }

    return res.status(500).json({ error: "Failed to update resident" });
  }
});

// Get resident by block + houseNumber
router.get("/residents/:block/:houseNumber", auth(["admin", "bendahara"]), async (req, res) => {
  try {
    const { block, houseNumber } = req.params;

    const resident = await prisma.resident.findUnique({
      where: {
        block_houseNumber: { block, houseNumber }
      }
    });

    if (!resident) {
      return res.status(404).json({ error: "Resident not found" });
    }

    res.json(resident);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch resident" });
  }
});

router.get("/blocks", async (req, res) => {
  try {
    const blocks = await prisma.resident.findMany({
      distinct: ["block"],
      select: { block: true },
      orderBy: { block: "asc" }
    });

    const blockList = blocks.map(b => b.block);

    res.json({
      total: blockList.length,
      blocks: blockList
    });

  } catch (err) {
    console.error("Error fetching residents:", err);
    res.status(500).json({ message: "Failed to fetch residents" });
  }
});

// Cache Key Generator for Block Houses
const blockHousesKey = (req) => `block-houses-structure`;

// Cache for 30 Days (2592000 seconds)
router.get("/houses-number", cache(blockHousesKey, 2592000), async (req, res) => {
  try {
    const { block } = req.query;

    if (!block) {
      return res.status(400).json({ message: "block is required" });
    }

    const houses = await prisma.resident.findMany({
      where: { block },
      select: { houseNumber: true },
      orderBy: { id: "asc" }
    });

    res.json(houses.map(h => h.houseNumber));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch house numbers" });
  }
});

router.get("/block-houses", cache(blockHousesKey, 2592000), async (req, res) => {
  try {
    const residents = await prisma.resident.findMany({
      select: { block: true, houseNumber: true },
      orderBy: [{ block: "asc" }]
    });

    const map = {};

    // Group residents by block
    residents.forEach((r) => {
      if (!map[r.block]) map[r.block] = [];
      map[r.block].push(r.houseNumber);
    });

    // SORT houses ASCENDING (1, 2, 3, 10, 12A ...)
    Object.keys(map).forEach((block) => {
      map[block].sort((a, b) => {
        const numA = parseInt(a);
        const numB = parseInt(b);

        // Sort number ascending
        if (numA !== numB) return numA - numB;

        // Same number? sort alphabet ascending
        return a.localeCompare(b);
      });
    });

    const result = Object.keys(map).map((block) => ({
      block,
      houses: map[block]
    }));

    return res.json({
      totalBlocks: result.length,
      data: result
    });

  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ message: "Failed to fetch block-houses data" });
  }
});


module.exports = router;
