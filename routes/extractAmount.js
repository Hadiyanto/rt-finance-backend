const express = require("express");
const multer = require("multer");
const fs = require("fs");
const Tesseract = require("tesseract.js");

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// -------------------------------------------------------
// SMART RULE ENGINE — Extract amount dari teks OCR
// -------------------------------------------------------
function extractAmountSmart(raw) {
  let text = raw;

  // Normalize: remove spaces after Rp/IDR
  text = text.replace(/\s+/g, " ");

  // 1. MATCH Rp or IDR with decimals
  const matches = [...text.matchAll(/(Rp|IDR)\s*([0-9\.\,]+)/gi)];

  const candidates = [];

  for (const m of matches) {
    let numStr = m[2];

    // Remove .00 or ,00
    numStr = numStr.replace(/(\.|\,)00$/i, "");

    // Remove thousand separators dot/comma
    numStr = numStr.replace(/\./g, "").replace(/,/g, "");

    const num = parseInt(numStr);

    if (!isNaN(num) && num >= 1000) {
      candidates.push(num);
    }
  }

  // If Rp/IDR found → pick largest (amount/total)
  if (candidates.length > 0) {
    return Math.max(...candidates);
  }

  // 2. Fallback: handle format like "Nominal 100.000,00"
  const nominalMatches = [...text.matchAll(/nominal\s*([0-9\.\,]+)/gi)];
  for (const m of nominalMatches) {
    let numStr = m[1];

    numStr = numStr.replace(/(\.|\,)00$/i, "");
    numStr = numStr.replace(/\./g, "").replace(/,/g, "");

    const num = parseInt(numStr);
    if (!isNaN(num) && num >= 1000) {
      candidates.push(num);
    }
  }

  if (candidates.length > 0) {
    return Math.max(...candidates);
  }

  // 3. Hard fallback: all 4+ digit numbers except account numbers
  const fallback = text.match(/[0-9]{4,}/g);
  if (!fallback) return null;

  const nums = fallback.map(n => parseInt(n)).filter(n => n < 100000000);

  if (nums.length === 0) return null;

  const sorted = nums.sort((a, b) => a - b);

  return sorted.length === 1 ? sorted[0] : sorted[sorted.length - 2];
}


// -------------------------------------------------------
// OCR ENDPOINT
// -------------------------------------------------------
router.post("/extract-amount", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const imgPath = req.file.path;

    // OCR dengan Tesseract
    const result = await Tesseract.recognize(imgPath, "eng");

    const text = result.data.text;

    // Jalankan rule engine
    const amount = extractAmountSmart(text);

    // Hapus file setelah selesai
    fs.unlinkSync(imgPath);

    res.json({
      raw: text,
      amount: amount || null
    });

  } catch (err) {
    console.error("Extract amount error:", err);
    res.status(500).json({ message: "Failed to extract amount" });
  }
});

module.exports = router;
