// API admin/bendahara (wajib login).
const express = require("express");
const { z } = require("zod");
const adminPayments = require("../repositories/adminPayments");
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

// Jalankan OCR sekarang tanpa menunggu jadwal.
router.post("/ocr/run", async (req, res) => {
  res.json(await runOcrBatch());
});

module.exports = router;
