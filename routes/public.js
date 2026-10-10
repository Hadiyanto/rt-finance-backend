// API publik untuk form "Setor Iuran" (warga, tanpa login).
// Tidak pernah mengembalikan nomor HP, nominal transfer orang lain, atau bukti transfer.
const express = require("express");
const multer = require("multer");
const { z } = require("zod");
const { rateLimit } = require("express-rate-limit");
const cloudinary = require("../config/cloudinary");
const houses = require("../repositories/houses");
const payments = require("../repositories/payments");
const reports = require("../repositories/reports");
const ledger = require("../repositories/ledger");
const { AppError } = require("../lib/errors");
const { PERIOD_RE, currentPeriod } = require("../lib/period");

const router = express.Router();

const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

const MAX_ITEMS = 60; // mis. 2 rumah × 24 bulan, dengan ruang lebih

const itemsSchema = z
  .array(z.object({ houseId: z.coerce.number().int().positive(), period: z.string().regex(PERIOD_RE, "Format periode YYYY-MM") }))
  .min(1, "Pilih minimal satu bulan")
  .max(MAX_ITEMS, `Maksimal ${MAX_ITEMS} bulan per laporan`)
  .refine(
    (items) => new Set(items.map((i) => `${i.houseId}:${i.period}`)).size === items.length,
    "Ada rumah dan bulan yang dipilih lebih dari sekali"
  );

// Bukti hanya boleh URL hasil upload ke Cloudinary milik RT (kalau cloud name diset).
const proofUrlSchema = z
  .string()
  .url()
  .refine((url) => {
    const cloud = process.env.CLOUDINARY_CLOUD_NAME;
    return cloud ? url.startsWith(`https://res.cloudinary.com/${cloud}/`) : url.startsWith("https://");
  }, "URL bukti transfer tidak valid");

const paymentSchema = z.object({
  payerName: z.string().trim().min(2, "Nama pelapor harus diisi").max(100),
  reportedAmount: z.coerce.number().int().positive("Jumlah transfer harus diisi").max(100_000_000),
  proofUrl: proofUrlSchema,
  items: itemsSchema,
});

const periodsQuerySchema = z.object({
  houseIds: z
    .string()
    .transform((s) => s.split(",").map((v) => Number(v.trim())))
    .pipe(z.array(z.number().int().positive()).min(1).max(10)),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

router.get("/houses", readLimiter, async (req, res) => {
  res.json({ data: await houses.listPublic() });
});

router.get("/house-periods", readLimiter, async (req, res) => {
  const { houseIds, year } = periodsQuerySchema.parse(req.query);
  const current = currentPeriod();
  const targetYear = year ?? Number(current.slice(0, 4));
  res.json({ year: targetYear, currentPeriod: current, houses: await houses.periodStatus(houseIds, targetYear, current) });
});

router.post("/payments/quote", readLimiter, async (req, res) => {
  const { items } = z.object({ items: itemsSchema }).parse(req.body);
  res.json(await payments.quote(items));
});

router.post("/payments", writeLimiter, async (req, res) => {
  const input = paymentSchema.parse(req.body);
  res.status(201).json(await payments.createPublic(input));
});

// === THR ===

const thrSchema = z.object({
  payerName: z.string().trim().min(2, "Nama pelapor harus diisi").max(100),
  houseId: z.coerce.number().int().positive(),
  year: z.coerce.number().int().min(2020).max(2100),
  amount: z.coerce.number().int().min(1000, "Nominal THR minimal Rp1.000").max(100_000_000),
  proofUrl: proofUrlSchema,
});

router.post("/thr", writeLimiter, async (req, res) => {
  res.status(201).json(await payments.createPublicThr(thrSchema.parse(req.body)));
});

const yearSchema = z.coerce.number().int().min(2020).max(2100);

router.get("/thr/recap", readLimiter, async (req, res) => {
  const year = yearSchema.parse(req.query.year ?? currentPeriod().slice(0, 4));
  res.json(await reports.thrRecap(year));
});

// === Laporan & kas (sama seperti app lama, terbuka untuk warga) ===

router.get("/reports/fee-breakdown", readLimiter, async (req, res) => {
  const period = z.string().regex(PERIOD_RE, "Format periode YYYY-MM").parse(req.query.period ?? currentPeriod());
  const data = await reports.feeBreakdown(period);
  res.json({ period, total: data.length, data });
});

router.get("/ledger", readLimiter, async (req, res) => {
  res.json(await ledger.list());
});

router.get("/ledger/categories", readLimiter, async (req, res) => {
  res.json({ data: await ledger.categories() });
});

// === Upload bukti ===

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new AppError(400, "INVALID_FILE_TYPE", "Hanya file gambar yang diperbolehkan"));
    }
    cb(null, true);
  },
});

router.post("/upload-proof", writeLimiter, upload.single("image"), async (req, res) => {
  if (!req.file) {
    throw new AppError(400, "FILE_REQUIRED", "Foto bukti transfer harus diunggah");
  }
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder: "rt-finance", resource_type: "image" }, (err, uploaded) => (err ? reject(err) : resolve(uploaded)))
      .end(req.file.buffer);
  });
  res.status(201).json({ proofUrl: result.secure_url });
});

module.exports = router;
