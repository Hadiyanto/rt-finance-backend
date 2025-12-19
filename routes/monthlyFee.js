const express = require("express");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const Tesseract = require("tesseract.js");
const cloudinary = require("../config/cloudinary");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = express.Router();
const upload = multer({ dest: "uploads/" });

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

router.post("/monthly-fee-manual", async (req, res) => {
  try {
    const { block, houseNumber, date, imageUrl } = req.body;

    let amount = null;
    let rawText = null;

    if (!block || !houseNumber || !date || !imageUrl) {
      return res.status(400).json({ message: "block, houseNumber, date, imageUrl required" });
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

    if (imageUrl) {
      const img = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const tempPath = `tmp_${Date.now()}.jpg`;
      fs.writeFileSync(tempPath, img.data);

      const ocr = await Tesseract.recognize(tempPath, "eng");
      rawText = ocr.data.text;
      amount = extractAmountSmart(rawText);

      fs.unlinkSync(tempPath);
    }

    // Ambil fullName otomatis dari table Resident
    const resident = await prisma.resident.findFirst({
      where: { block, houseNumber }
    });

    const fullName = resident ? resident.fullName : "Unknown";

    // SIMPAN KE DB
    const saved = await prisma.monthlyFee.create({
      data: {
        block,
        houseNumber,
        fullName,
        date: finalDate,
        amount: amount ?? null,
        imageUrl: imageUrl,
        residentId: resident ? resident.id : null,
      }
    });

    return res.json({
      success: true,
      data: saved,
      rawText,
      amount,
      imageUrl: imageUrl,
    });

  } catch (error) {
    console.error("Monthly Fee error:", error);
    return res.status(500).json({ message: "Failed to process monthly fee" });
  }
});

module.exports = router;
