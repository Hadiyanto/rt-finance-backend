// Baca nominal dari bukti transfer laporan yang masih PENDING, lalu pindahkan ke WAITING_APPROVAL.
// Hasil OCR hanya membantu admin membandingkan; approval tetap keputusan admin.
const db = require("../lib/db");
const { extractAmount } = require("../lib/ocr");

const MAX_ATTEMPTS = 3;

async function tesseractRecognize(image) {
  const Tesseract = require("tesseract.js");
  const { data } = await Tesseract.recognize(image, "eng");
  return data.text;
}

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gagal mengunduh bukti (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

let running = false;

/**
 * Proses beberapa laporan sekaligus (batch kecil supaya server tidak berat).
 * recognize/download bisa diganti untuk test.
 */
async function runOcrBatch({ limit = 3, recognize = tesseractRecognize, download = fetchImage } = {}) {
  if (running) {
    return { skipped: true, processed: 0, failed: 0 };
  }
  running = true;
  try {
    const { rows: jobs } = await db.query(
      `SELECT id, proof_url, ocr_attempts FROM payment
       WHERE status = 'PENDING' AND proof_url IS NOT NULL AND ocr_attempts < $1
       ORDER BY created_at
       LIMIT $2`,
      [MAX_ATTEMPTS, limit]
    );

    let processed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        const text = await recognize(await download(job.proof_url));
        await db.query(
          `UPDATE payment
           SET ocr_text = $2, ocr_amount = $3, ocr_error = NULL, ocr_attempts = ocr_attempts + 1,
               status = 'WAITING_APPROVAL'
           WHERE id = $1 AND status = 'PENDING'`,
          [job.id, text, extractAmount(text)]
        );
        processed++;
      } catch (err) {
        failed++;
        // setelah percobaan terakhir tetap diteruskan ke admin untuk dicek manual
        await db.query(
          `UPDATE payment
           SET ocr_error = $2, ocr_attempts = ocr_attempts + 1,
               status = CASE WHEN ocr_attempts + 1 >= $3 THEN 'WAITING_APPROVAL' ELSE status END
           WHERE id = $1 AND status = 'PENDING'`,
          [job.id, String(err.message || err), MAX_ATTEMPTS]
        );
      }
    }
    return { skipped: false, processed, failed };
  } finally {
    running = false;
  }
}

module.exports = { runOcrBatch, MAX_ATTEMPTS };
