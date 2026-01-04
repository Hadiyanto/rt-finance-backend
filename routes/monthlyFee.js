const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const Tesseract = require("tesseract.js");
const cloudinary = require("../config/cloudinary");
const prisma = require("../lib/prisma"); // Singleton
const redis = require("../lib/redisClient");
const auth = require("../middlewares/auth");
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

    // =========================
    // PARALLEL CHECKS (EXISTING & DEFERRED)
    // =========================
    const [existingFee, deferred] = await Promise.all([
      prisma.monthlyFee.findFirst({
        where: { block, houseNumber, date: parsedDate },
        select: { id: true } // Optimization: Select only ID
      }),
      prisma.deferredSubscription.findFirst({
        where: { block, houseNumber, isActive: true },
        select: { id: true } // Optimization: Select only ID
      })
    ]);

    if (existingFee) {
      return res.status(409).json({
        code: "MONTHLY_FEE_ALREADY_SUBMITTED",
        message: "Monthly fee for this house and month has already been submitted",
      });
    }

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

    // Fire-and-forget Cache Invalidation (Non-blocking)
    invalidateBreakdown(parsedDate).catch(err => console.error("Cache invalidation error:", err));

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
        },
        status: "COMPLETED"
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

// ============================================================
// RW SUBMISSION ENDPOINTS
// ============================================================

// GET: List pending submission (COMPLETED but not submitted to RW)
router.get("/monthly-fee/pending-submission", async (req, res) => {
  try {
    const { year, month } = req.query;

    // Build date filter if year/month provided
    let dateFilter = {};
    if (year && month) {
      const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
      const endDate = new Date(parseInt(year), parseInt(month), 1);
      dateFilter = {
        date: {
          gte: startDate,
          lt: endDate
        }
      };
    }

    const pending = await prisma.monthlyFee.findMany({
      where: {
        status: "COMPLETED",
        rwSubmissionId: null,
        ...dateFilter
      },
      orderBy: [
        { date: 'asc' },
        { block: 'asc' },
        { houseNumber: 'asc' }
      ],
      select: {
        id: true,
        block: true,
        houseNumber: true,
        fullName: true,
        date: true,
        amount: true
      }
    });

    // Group by period and separate late vs on-time
    const currentPeriod = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

    let onTimeRecords = [];
    let lateRecords = [];
    let onTimeAmount = 0;
    let lateAmount = 0;

    pending.forEach(fee => {
      const feePeriod = fee.date.toISOString().slice(0, 7);
      const isLate = feePeriod < currentPeriod;

      const record = {
        id: fee.id,
        block: fee.block,
        houseNumber: fee.houseNumber,
        fullName: fee.fullName,
        period: feePeriod,
        amount: fee.amount,
        isLate
      };

      if (isLate) {
        lateRecords.push(record);
        lateAmount += fee.amount || 0;
      } else {
        onTimeRecords.push(record);
        onTimeAmount += fee.amount || 0;
      }
    });

    res.json({
      currentPeriod,
      summary: {
        totalRecords: pending.length,
        totalAmount: onTimeAmount + lateAmount,
        onTime: { count: onTimeRecords.length, amount: onTimeAmount },
        late: { count: lateRecords.length, amount: lateAmount }
      },
      onTimeRecords,
      lateRecords
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST: Submit to RW (mark as submitted) - requires login
router.post("/monthly-fee/submit-to-rw", auth(["admin", "bendahara", "RT"]), async (req, res) => {
  try {
    const { ids, period, notes } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array is required" });
    }

    if (!period) {
      return res.status(400).json({ message: "period is required (e.g. '2026-01')" });
    }

    // Get the fees to calculate total
    const fees = await prisma.monthlyFee.findMany({
      where: {
        id: { in: ids },
        status: "COMPLETED",
        rwSubmissionId: null
      }
    });

    if (fees.length === 0) {
      return res.status(400).json({ message: "No valid pending fees found for given IDs" });
    }

    const totalAmount = fees.reduce((sum, f) => sum + (f.amount || 0), 0);

    // Create RWSubmission
    const submission = await prisma.rWSubmission.create({
      data: {
        period,
        totalAmount,
        submittedAt: new Date(),
        notes: notes || null,
        monthlyFees: {
          connect: fees.map(f => ({ id: f.id }))
        }
      },
      include: {
        monthlyFees: {
          select: {
            id: true,
            block: true,
            houseNumber: true,
            amount: true
          }
        }
      }
    });

    res.json({
      success: true,
      message: `${fees.length} records submitted to RW`,
      submission: {
        id: submission.id,
        period: submission.period,
        totalAmount: submission.totalAmount,
        submittedAt: submission.submittedAt,
        records: submission.monthlyFees
      }
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET: List all RW submissions
router.get("/monthly-fee/rw-submissions", async (req, res) => {
  try {
    const { year, month } = req.query;

    // Build period filter if year/month provided
    let periodFilter = {};
    if (year && month) {
      const period = `${year}-${String(month).padStart(2, '0')}`; // "2026-01"
      periodFilter = { period };
    } else if (year) {
      periodFilter = { period: { startsWith: year } }; // "2026"
    }

    const submissions = await prisma.rWSubmission.findMany({
      where: periodFilter,
      orderBy: { submittedAt: 'desc' },
      include: {
        _count: {
          select: { monthlyFees: true }
        }
      }
    });

    res.json({
      total: submissions.length,
      data: submissions.map(s => ({
        id: s.id,
        period: s.period,
        totalAmount: s.totalAmount,
        submittedAt: s.submittedAt,
        notes: s.notes,
        recordCount: s._count.monthlyFees
      }))
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET: Detail of a specific RW submission
router.get("/monthly-fee/rw-submissions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const submission = await prisma.rWSubmission.findUnique({
      where: { id },
      include: {
        monthlyFees: {
          select: {
            id: true,
            block: true,
            houseNumber: true,
            fullName: true,
            date: true,
            amount: true
          },
          orderBy: [
            { block: 'asc' },
            { houseNumber: 'asc' }
          ]
        }
      }
    });

    if (!submission) {
      return res.status(404).json({ message: "Submission not found" });
    }

    // Check for late submissions
    const records = submission.monthlyFees.map(fee => {
      const feePeriod = fee.date.toISOString().slice(0, 7);
      return {
        ...fee,
        feePeriod,
        isLate: feePeriod !== submission.period
      };
    });

    res.json({
      id: submission.id,
      period: submission.period,
      totalAmount: submission.totalAmount,
      submittedAt: submission.submittedAt,
      notes: submission.notes,
      records
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET: Payment history for resident(s) with date range
// Usage: /monthly-fee/history?block=B1&houseNumber=11&startYear=2025&startMonth=1&endYear=2025&endMonth=12
// Or for all: /monthly-fee/history?startYear=2025&startMonth=1&endYear=2025&endMonth=12
router.get("/monthly-fee/history", async (req, res) => {
  try {
    const { block, houseNumber, startYear, startMonth, endYear, endMonth } = req.query;

    if (!startYear || !startMonth || !endYear || !endMonth) {
      return res.status(400).json({
        message: "startYear, startMonth, endYear, endMonth are required"
      });
    }

    // Build resident filter
    let residentFilter = {};
    if (block && houseNumber) {
      residentFilter = { block, houseNumber };
    } else if (block) {
      residentFilter = { block };
    }

    // Generate list of months in range
    const months = [];
    let current = new Date(parseInt(startYear), parseInt(startMonth) - 1, 1);
    const end = new Date(parseInt(endYear), parseInt(endMonth) - 1, 1);

    while (current <= end) {
      months.push({
        year: current.getFullYear(),
        month: current.getMonth() + 1,
        period: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`
      });
      current.setMonth(current.getMonth() + 1);
    }

    // Get all payments in range
    const startDate = new Date(parseInt(startYear), parseInt(startMonth) - 1, 1);
    const endDate = new Date(parseInt(endYear), parseInt(endMonth), 1);

    const payments = await prisma.monthlyFee.findMany({
      where: {
        ...residentFilter,
        date: {
          gte: startDate,
          lt: endDate
        }
      },
      select: {
        id: true,
        block: true,
        houseNumber: true,
        fullName: true,
        date: true,
        status: true,
        amount: true
      },
      orderBy: [
        { block: 'asc' },
        { houseNumber: 'asc' },
        { date: 'asc' }
      ]
    });

    // If specific resident requested
    if (block && houseNumber) {
      const history = months.map(m => {
        const payment = payments.find(p => {
          const pPeriod = p.date.toISOString().slice(0, 7);
          return pPeriod === m.period;
        });

        return {
          period: m.period,
          month: new Date(m.year, m.month - 1).toLocaleString('id-ID', { month: 'long', year: 'numeric' }),
          status: payment ? payment.status : 'NOT_PAID',
          amount: payment ? payment.amount : null,
          paymentId: payment ? payment.id : null
        };
      });

      return res.json({
        block,
        houseNumber,
        fullName: payments[0]?.fullName || null,
        range: `${months[0].period} - ${months[months.length - 1].period}`,
        history
      });
    }

    // If all residents - fetch from Resident table first
    let residentWhere = {};
    if (block) {
      residentWhere = { block };
    }

    const allResidents = await prisma.resident.findMany({
      where: residentWhere,
      select: {
        id: true,
        block: true,
        houseNumber: true,
        fullName: true
      },
      orderBy: [
        { id: 'asc' }
      ]
    });

    // Create payment lookup map
    const paymentMap = {};
    payments.forEach(p => {
      const key = `${p.block}/${p.houseNumber}`;
      if (!paymentMap[key]) {
        paymentMap[key] = [];
      }
      paymentMap[key].push(p);
    });

    // Build history for each resident
    const result = allResidents.map(r => {
      const key = `${r.block}/${r.houseNumber}`;
      const residentPayments = paymentMap[key] || [];

      const history = months.map(m => {
        const payment = residentPayments.find(p => {
          const pPeriod = p.date.toISOString().slice(0, 7);
          return pPeriod === m.period;
        });

        return {
          period: m.period,
          status: payment ? payment.status : 'NOT_PAID'
        };
      });

      return {
        block: r.block,
        houseNumber: r.houseNumber,
        fullName: r.fullName,
        history
      };
    });

    res.json({
      range: `${months[0].period} - ${months[months.length - 1].period}`,
      totalResidents: result.length,
      data: result
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
