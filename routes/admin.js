// API admin/bendahara (wajib login).
const express = require("express");
const { z } = require("zod");
const adminPayments = require("../repositories/adminPayments");
const reports = require("../repositories/reports");
const ledger = require("../repositories/ledger");
const { PERIOD_RE, currentPeriod, todayJakarta } = require("../lib/period");
const { runOcrBatch } = require("../services/ocr");
const { requireAuth, ADMIN_ROLES } = require("../lib/auth");

const router = express.Router();
router.use(requireAuth(ADMIN_ROLES));

const idParam = z.coerce.number().int().positive();

const listQuery = z.object({
  status: z
    .string()
    .transform((s) => s.split(",").map((v) => v.trim().toUpperCase()))
    .pipe(z.array(z.enum(["PENDING", "WAITING_APPROVAL", "WAITING_MANUAL_INPUT", "APPROVED", "REJECTED"])).min(1))
    .optional(),
  kind: z.enum(["MONTHLY_FEE", "THR"]).optional(),
});

router.get("/payments", async (req, res) => {
  const { status, kind } = listQuery.parse(req.query);
  res.json(await adminPayments.list({ statuses: status, kind }));
});

router.get("/payments/:id", async (req, res) => {
  res.json(await adminPayments.getById(idParam.parse(req.params.id)));
});

const approveBody = z
  .object({
    reportedAmount: z.coerce.number().int().positive().max(100_000_000).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .default({});

router.post("/payments/:id/approve", async (req, res) => {
  const body = approveBody.parse(req.body ?? {});
  res.json(await adminPayments.approve(idParam.parse(req.params.id), req.user.id, body));
});

const rejectBody = z.object({ reason: z.string().trim().min(3, "Alasan penolakan harus diisi").max(500) });

router.post("/payments/:id/reject", async (req, res) => {
  const { reason } = rejectBody.parse(req.body ?? {});
  res.json(await adminPayments.reject(idParam.parse(req.params.id), req.user.id, reason));
});

// === Tunggakan (termasuk nomor HP untuk menghubungi warga) ===

const arrearsQuery = z
  .object({
    from: z.string().regex(PERIOD_RE).optional(),
    to: z.string().regex(PERIOD_RE).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Periode awal harus sebelum periode akhir")
  .refine((q) => !q.from || !q.to || Number(q.to.slice(0, 4)) - Number(q.from.slice(0, 4)) <= 5, "Rentang maksimal 5 tahun");

router.get("/arrears", async (req, res) => {
  const current = currentPeriod();
  const { from, to } = arrearsQuery.parse(req.query);
  const year = current.slice(0, 4);
  res.json(await reports.arrears(from ?? `${year}-01`, to ?? `${year}-12`, current));
});

// === Kas ===

router.get("/ledger", async (req, res) => {
  res.json(await ledger.list({ includeUnapproved: true }));
});

const ledgerBody = z.object({
  entryDate: z.iso.date(),
  direction: z.enum(["IN", "OUT"]),
  amount: z.coerce.number().int().positive().max(1_000_000_000),
  categoryId: z.coerce.number().int().positive(),
  description: z.string().trim().min(3, "Keterangan harus diisi").max(500),
  proofUrl: z.string().url().startsWith("https://").optional(),
});

router.post("/ledger", async (req, res) => {
  res.status(201).json(await ledger.create(ledgerBody.parse(req.body), req.user.id));
});

// Snapshot iuran → kas: pratinjau lalu catat (bisa diulang, hanya selisih yang ditambahkan)
const periodSchema = z.string().regex(PERIOD_RE, "Format periode YYYY-MM");

router.get("/ledger/fee-snapshot", async (req, res) => {
  res.json(await ledger.feeSnapshotPreview(periodSchema.parse(req.query.period)));
});

router.post("/ledger/fee-snapshot", async (req, res) => {
  const { period } = z.object({ period: periodSchema }).parse(req.body ?? {});
  res.json(await ledger.feeSnapshot(period, req.user.id));
});

// Snapshot THR → kas (pemasukan THR + setoran THR ke RW)
const yearSchema = z.coerce.number().int().min(2020).max(2100);

router.get("/ledger/thr-snapshot", async (req, res) => {
  res.json(await ledger.thrPreview(yearSchema.parse(req.query.year)));
});

router.post("/ledger/thr-snapshot", async (req, res) => {
  const { year, entryDate } = z
    .object({ year: yearSchema, entryDate: z.iso.date().optional() })
    .parse(req.body ?? {});
  res.json(await ledger.thrSnapshot(year, req.user.id, entryDate ?? todayJakarta()));
});

router.post("/ledger/:id/approve", async (req, res) => {
  res.json(await ledger.review(idParam.parse(req.params.id), req.user.id, "APPROVED"));
});

router.post("/ledger/:id/reject", async (req, res) => {
  res.json(await ledger.review(idParam.parse(req.params.id), req.user.id, "REJECTED"));
});

// Jalankan OCR sekarang tanpa menunggu jadwal.
router.post("/ocr/run", async (req, res) => {
  res.json(await runOcrBatch());
});

module.exports = router;
