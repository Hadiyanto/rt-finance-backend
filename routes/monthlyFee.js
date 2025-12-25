const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const Tesseract = require("tesseract.js");
const cloudinary = require("../config/cloudinary");
const prisma = require("../lib/prisma"); // Singleton
const redis = require("../lib/redisClient");
const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Helper: Invalidate breakdown cache
const invalidateBreakdown = async (dateObj) => {
  if (!dateObj) return;
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, "0");
  const key = `breakdown:${year}:${month}`;
  await redis.del(key);
  console.log(`🗑️ Invalidate Cache: ${key}`);
};

function breakdownAmount(total) {
  if (total === 100000) {
    return {
      kasRT: 0,
      agamaRT: 0,
      sampah: 0,
      keamanan: 100000,
      agamaRW: 0,
      kasRW: 0,
      kkmRW: 0
    }
  }

  if (total === 210000 || total === 200000) {
    return {
      kasRT: 30000,
      agamaRT: 2400,
      sampah: 50000,
      keamanan: 97500,
      agamaRW: 21600,
      kasRW: 3000,
      kkmRW: 5500
    }
  }

  if (total === 186000) {
    return {
      kasRT: 30000,
      agamaRT: 0,
      sampah: 50000,
      keamanan: 97500,
      agamaRW: 0,
      kasRW: 3000,
      kkmRW: 5500
    }
  }

  throw new Error(`Unsupported totalAmount: ${total}`)
}


// -------------------------------------------------------
// SMART RULE ENGINE — Extract amount dari teks OCR
// -------------------------------------------------------
function extractAmountSmart(raw) {
  let text = raw;
  text = text.replace(/\s+/g, " ");

  const matches = [...text.matchAll(/(Rp|IDR)\s*([0-9\.\,]+)/gi)];

  const candidates = [];

  for (const m of matches) {
    let numStr = m[2];
    numStr = numStr.replace(/(\.|\,)00$/i, "");
    numStr = numStr.replace(/\./g, "").replace(/,/g, "");

    const num = parseInt(numStr);
    if (!isNaN(num) && num >= 1000) candidates.push(num);
  }

  if (candidates.length === 0) {
    const nominalMatches = [...text.matchAll(/nominal\s*([0-9\.\,]+)/gi)];
    for (const m of nominalMatches) {
      let numStr = m[1];
      numStr = numStr.replace(/(\.|\,)00$/i, "");
      numStr = numStr.replace(/\./g, "").replace(/,/g, "");
      const num = parseInt(numStr);
      if (!isNaN(num) && num >= 1000) candidates.push(num);
    }
  }

  if (candidates.length === 0) {
    const fallback = text.match(/[0-9]{4,}/g);
    if (!fallback) return null;

    const nums = fallback
      .map(n => parseInt(n))
      .filter(n => n < 100000000);

    if (nums.length === 0) return null;

    const sorted = nums.sort((a, b) => a - b);
    candidates.push(sorted.length === 1 ? sorted[0] : sorted[sorted.length - 2]);
  }

  // Ambil angka terbesar
  let amount = Math.max(...candidates);

  // -------------------------------------
  // NEW RULE: Remove bank fee (2500 / 6500)
  // -------------------------------------
  const last4 = amount.toString().slice(-4);

  if (last4 === "2500") {
    amount = amount - 2500; // atau overwrite: amount = parseInt(amount.toString().slice(0, -4) + "0000");
  } else if (last4 === "6500") {
    amount = amount - 6500;
  }

  return amount;
}


// -------------------------------------------------------
// POST /api/monthly-fee
// Upload + OCR + Extract + Save DB
// -------------------------------------------------------
router.post("/monthly-fee", upload.single("image"), async (req, res) => {
  try {
    const { block, houseNumber, date } = req.body;

    if (!block || !houseNumber || !date) {
      return res.status(400).json({ message: "block, houseNumber, date required" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "image file required" });
    }

    let finalDate;

    if (date.length === 7) {
      // Jika input "2025-01"
      finalDate = new Date(date + "-01T00:00:00");
    } else {
      // Jika input sudah "2025-01-20"
      finalDate = new Date(date);
    }

    if (isNaN(finalDate.getTime())) {
      return res.status(400).json({ message: "Invalid date format" });
    }

    const localPath = req.file.path;

    // UPLOAD CLOUDINARY
    const uploaded = await cloudinary.uploader.upload(localPath, {
      folder: "rt-finance",
      resource_type: "image",
    });

    // OCR dengan Tesseract
    const ocr = await Tesseract.recognize(localPath, "eng");
    const rawText = ocr.data.text;

    // Extract nominal
    const amount = extractAmountSmart(rawText);

    // Ambil fullName otomatis dari table Resident
    const resident = await prisma.resident.findFirst({
      where: { block, houseNumber }
    });

    const fullName = resident ? resident.fullName : "Unknown";

    // DELETE local file
    fs.unlinkSync(localPath);

    // SIMPAN KE DB
    const saved = await prisma.monthlyFee.create({
      data: {
        block,
        houseNumber,
        fullName,
        date: finalDate,
        amount: amount ?? null,
        imageUrl: uploaded.secure_url,
        residentId: resident ? resident.id : null,
      }
    });

    // Invalidate Cache
    await invalidateBreakdown(finalDate);

    return res.json({
      success: true,
      data: saved,
      rawText,
      amount,
      imageUrl: uploaded.secure_url
    });

  } catch (error) {
    console.error("Monthly Fee error:", error);
    return res.status(500).json({ message: "Failed to process monthly fee" });
  }
});

router.post("/monthly-fee-validate", async (req, res) => {
  try {
    const { block, houseNumber, date } = req.body;

    // =========================
    // VALIDATION
    // =========================
    if (!block || !houseNumber || !date) {
      return res.status(400).json({
        message: `block ${block}, houseNumber ${houseNumber}, date ${date} are required`,
      });
    }

    const parsedDate = new Date(`${date}-01`);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: "Invalid date format" });
    }

    let isSubmitted = false;
    let isDeferred = false;
    let code = null;
    let message = null;

    const existingFee = await prisma.monthlyFee.findFirst({
      where: {
        block,
        houseNumber,
        date: parsedDate,
      },
    });

    if (existingFee) {
      isSubmitted = true;
      code = "MONTHLY_FEE_ALREADY_SUBMITTED";
      message = "Monthly fee for this house and month has already been submitted";
    }

    const deferred = await prisma.deferredSubscription.findFirst({
      where: {
        block,
        houseNumber,
        isActive: true,
      },
    });

    if (deferred) {
      isDeferred = true;
      code = "DEFERRED_ACTIVE";
      message = "This month is already covered by a prepaid subscription";
    }

    if (isSubmitted || isDeferred) {
      return res.status(409).json({
        code,
        message,
      });
    } else {
      return res.status(201).json({
        message: "Monthly fee able to submit"
      });
    }

  } catch (err) {
    console.error("Monthly Fee error:", err);
    return res.status(500).json({ message: "Failed to validate monthly fee" });
  }
});

router.post("/monthly-fee-manual", async (req, res) => {
  try {
    const { block, houseNumber, date, name, notes, imageUrl } = req.body;

    // =========================
    // VALIDATION
    // =========================
    if (!block || !houseNumber || !date || !imageUrl || !name) {
      return res.status(400).json({
        message: `block ${block}, houseNumber ${houseNumber}, name ${name}, date ${date}, and imageUrl ${imageUrl} are required`,
      });
    }

    // =========================
    // PARSE DATE (YYYY-MM → Date)
    // =========================
    const parsedDate = new Date(`${date}-01`);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: "Invalid date format" });
    }

    const existingFee = await prisma.monthlyFee.findFirst({
      where: {
        block,
        houseNumber,
        date: parsedDate,
      },
    });

    if (existingFee) {
      return res.status(409).json({
        code: "MONTHLY_FEE_ALREADY_SUBMITTED",
        message: "Monthly fee for this house and month has already been submitted",
      });
    }

    const deferred = await prisma.deferredSubscription.findFirst({
      where: {
        block,
        houseNumber,
        isActive: true,
      },
    });

    if (deferred) {
      return res.status(409).json({
        code: "DEFERRED_ACTIVE",
        message: "This month is already covered by a prepaid subscription",
      });
    }

    // =========================
    // AUTO FULLNAME FROM RESIDENT
    // =========================
    // const resident = await prisma.resident.findFirst({
    //   where: { block, houseNumber },
    //   select: { fullName: true },
    // });

    // const fullName = name?.trim();

    // =========================
    // CREATE MONTHLY FEE (FAST)
    // =========================
    const fee = await prisma.monthlyFee.create({
      data: {
        block,
        houseNumber,
        fullName: name?.trim() || null,
        notes: notes?.trim() || null,
        date: parsedDate,
        imageUrl,
        status: "PENDING",
      },
    });

    // Invalidate Cache
    await invalidateBreakdown(parsedDate);

    return res.status(201).json({
      message: "Monthly fee submitted",
      data: fee,
    });

  } catch (err) {
    console.error("Monthly Fee error:", err);
    return res.status(500).json({ message: "Failed to submit monthly fee" });
  }
});

router.get('/monthly-fee/breakdown/:year/:month', async (req, res) => {
  try {
    const { year, month } = req.params
    const period = `${year}-${month.padStart(2, '0')}`

    // CACHING LOGIC
    const key = `breakdown:${year}:${month.padStart(2, '0')}`;
    const cached = await redis.get(key);

    if (cached) {
      console.log(`🔥 Cache HIT: ${key}`);
      return res.json(typeof cached === "string" ? JSON.parse(cached) : cached);
    }

    const startDate = new Date(`${period}-01`)
    const endDate = new Date(`${period}-31`)

    // 1️⃣ BASE: semua resident
    const residents = await prisma.resident.findMany({
      select: {
        block: true,
        houseNumber: true,
        fullName: true,
      },
      orderBy: { id: "asc" }
    })

    // 2️⃣ Deferred aktif + in range
    const deferredSubs = await prisma.deferredSubscription.findMany({
      where: { isActive: true },
      select: {
        block: true,
        houseNumber: true,
        monthlyAmount: true,
        startMonth: true,
        endMonth: true
      }
    })

    const isInRange = (period, start, end) =>
      period >= start && period <= end

    const deferredMap = new Map()
    deferredSubs.forEach(d => {
      if (isInRange(period, d.startMonth, d.endMonth)) {
        deferredMap.set(`${d.block}-${d.houseNumber}`, d)
      }
    })

    // 3️⃣ MonthlyFee bulan tsb
    const monthlyFees = await prisma.monthlyFee.findMany({
      where: {
        date: {
          gte: startDate,
          lt: endDate
        }
      },
      select: {
        block: true,
        houseNumber: true,
        amount: true
      }
    })

    const feeMap = new Map()
    monthlyFees.forEach(f => {
      feeMap.set(`${f.block}-${f.houseNumber}`, f)
    })

    // 4️⃣ BUILD RESULT (SELALU PUSH RESIDENT)
    const data = []

    for (const resi of residents) {
      const key = `${resi.block}-${resi.houseNumber}`

      // default kosong
      let row = {
        block: resi.block,
        houseNumber: resi.houseNumber,
        fullName: resi.fullName,
        source: null,
        totalAmount: null,
        kasRT: null,
        agamaRT: null,
        sampah: null,
        keamanan: null,
        agamaRW: null,
        kasRW: null,
        kkmRW: null
      }

      // PRIORITAS 1: DEFERRED (valid)
      if (deferredMap.has(key)) {
        const sub = deferredMap.get(key)
        const breakdown = breakdownAmount(sub.monthlyAmount)

        row = {
          ...row,
          source: 'DEFERRED',
          totalAmount: sub.monthlyAmount,
          ...breakdown
        }
      }
      // PRIORITAS 2: MONTHLY_FEE
      else if (feeMap.has(key)) {
        const fee = feeMap.get(key)
        if (fee.amount == null) continue
        const breakdown = breakdownAmount(fee.amount)

        row = {
          ...row,
          source: 'MONTHLY_FEE',
          totalAmount: fee.amount,
          ...breakdown
        }
      }

      data.push(row)
    }

    const responsePayload = {
      period,
      total: data.length,
      data
    };

    res.json(responsePayload)

    // SET CACHE (1h for current month, 24h for past)
    const now = new Date();
    const isCurrentMonth = now.getFullYear() == year && (now.getMonth() + 1) == parseInt(month);
    const ttl = isCurrentMonth ? 3600 : 86400;

    await redis.set(key, JSON.stringify(responsePayload), { ex: ttl });

  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})

module.exports = router;
