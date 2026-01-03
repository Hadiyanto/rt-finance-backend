const express = require("express");
const axios = require("axios");
const fs = require("fs");
const Tesseract = require("tesseract.js");
const prisma = require("../lib/prisma"); // Singleton
const redis = require("../lib/redisClient"); // For invalidation
const { sendApprovalRequest, sendManualInputRequest } = require("./tele");
const router = express.Router();

// ===============================
// SMART AMOUNT EXTRACTOR
// ===============================
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


function getMonthYearLabel(ym) {
  const [year, month] = ym.split('-').map(Number)

  const months = [
    'Januari', 'Februari', 'Maret', 'April',
    'Mei', 'Juni', 'Juli', 'Agustus',
    'September', 'Oktober', 'November', 'Desember'
  ]

  return `${months[month - 1]} ${year}`
}


// ===============================
// CRON OCR RUNNER
// ===============================
router.post("/cron/run-ocr", async (req, res) => {
  // 🔐 SECURITY
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(403).json({ message: "Forbidden" });
  }

  try {
    // Ambil batch kecil biar server aman
    const jobs = await prisma.monthlyFee.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 3, // 🔥 batasi!
    });

    if (jobs.length === 0) {
      return res.json({ message: "No pending OCR jobs" });
    }

    let processed = 0;

    for (const job of jobs) {
      try {
        // Mark as processing (optional tapi bagus)
        await prisma.monthlyFee.update({
          where: { id: job.id },
          data: { status: "PROCESSING" },
        });

        // Download image
        const img = await axios.get(job.imageUrl, {
          responseType: "arraybuffer",
        });

        const tmpPath = `tmp_ocr_${job.id}.jpg`;
        fs.writeFileSync(tmpPath, img.data);

        // OCR
        const result = await Tesseract.recognize(tmpPath, "eng");
        const rawText = result.data.text;
        const amount = extractAmountSmart(rawText);

        fs.unlinkSync(tmpPath);

        const status = (amount && amount >= 100000) ? "WAITING_APPROVAL" : "WAITING_MANUAL_INPUT";

        const updated = await prisma.monthlyFee.update({
          where: { id: job.id },
          data: {
            rawText,
            amount: amount || undefined, // Jangan set null explicit jika undefined
            status: status,
            attempt: { increment: 1 },
          },
        });

        if (status === "WAITING_APPROVAL") {
          sendApprovalRequest(updated).catch(e => console.error("Tele error", e));
        } else if (status === "WAITING_MANUAL_INPUT") {
          sendManualInputRequest(updated).catch(e => console.error("Tele error input", e));
        }

        // Invalidate Cache for this month
        const date = job.date;
        if (date) {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          await redis.del(`breakdown:${year}:${month}`);
        }

        processed++;
      } catch (err) {
        await prisma.monthlyFee.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            errorMessage: String(err),
            attempt: { increment: 1 },
          },
        });
      }
    }

    res.json({
      message: "OCR cron finished",
      processed,
    });

  } catch (err) {
    console.error("CRON OCR ERROR:", err);
    res.status(500).json({ message: "Cron OCR failed" });
  }
});

router.post('/cron/release-deferred-v1/:date', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ message: 'Forbidden' })
  }

  // 🔥 HARDCODE BULAN (NANTI DINAMIS)
  const RELEASE_MONTH = req.params.date
  const now = new Date()

  try {
    const subs = await prisma.deferredSubscription.findMany({
      where: { isActive: true }
    })

    let processed = 0
    let skipped = 0

    for (const sub of subs) {
      // ---- RANGE CHECK ----
      if (
        RELEASE_MONTH < sub.startMonth ||
        RELEASE_MONTH > sub.endMonth
      ) {
        skipped++
        continue
      }

      if (sub.remaining < sub.monthlyAmount) {
        skipped++
        continue
      }

      await prisma.$transaction(async (tx) => {
        // 1️⃣ INSERT LEDGER (DEFERRED EVENT LOG)
        await tx.cashLedger.create({
          data: {
            type: 'OUT', // 🔥 hanya event log
            amount: sub.monthlyAmount,
            bucket: 'DEFERRED',
            balance: null, // 🔥 WAJIB NULL
            description: `Iuran ${getMonthYearLabel(RELEASE_MONTH)} - Blok ${sub.block} No ${sub.houseNumber}`,
            date: now,
            source: 'MONTHLY_FEE',
            sourceRef: sub.id,
            createdBy: 'cron'
          }
        })

        // 2️⃣ UPDATE SUBSCRIPTION
        const newRemaining = sub.remaining - sub.monthlyAmount

        await tx.deferredSubscription.update({
          where: { id: sub.id },
          data: {
            remaining: newRemaining,
            isActive: newRemaining > 0
          }
        })
      })

      // Invalidate Cache for Release Month
      if (processed > 0) {
        const [y, m] = RELEASE_MONTH.split('-');
        await redis.del(`breakdown:${y}:${m}`);
      }

      processed++
    }

    res.json({
      message: 'Deferred monthly release completed',
      releaseMonth: RELEASE_MONTH,
      processed,
      skipped
    })
  } catch (err) {
    res.status(500).json({ message: err.message })
  }
})


module.exports = router;
