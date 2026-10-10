const { test } = require("node:test");
const assert = require("node:assert/strict");
const { useTestServer } = require("./helpers/server");
const { extractAmount } = require("../lib/ocr");
const { runOcrBatch, MAX_ATTEMPTS } = require("../services/ocr");

const ctx = useTestServer();
const { db } = ctx;

const PROOF = "https://res.cloudinary.com/demo/image/upload/bukti.jpg";

async function submitReport(items, reportedAmount = 210000) {
  const { status, body } = await ctx.api("POST", "/api/public/payments", {
    payerName: "Budi Santoso",
    reportedAmount,
    proofUrl: PROOF,
    items,
  });
  assert.equal(status, 201);
  return body.paymentId;
}

// === Auth ===

test("login: benar → token + data user", async () => {
  const { status, body } = await ctx.api("POST", "/api/auth/login", { email: " Bendahara@RT.test ", password: "rahasia123" });
  assert.equal(status, 200);
  assert.ok(body.token);
  assert.deepEqual(body.user, { id: 1, name: "Bendahara", role: "bendahara" });

  const me = await ctx.api("GET", "/api/auth/me", null, body.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, "bendahara");
});

test("login: email tidak terdaftar, password salah, dan user nonaktif → pesan yang sama", async () => {
  for (const [email, password] of [
    ["tidakada@rt.test", "rahasia123"],
    ["bendahara@rt.test", "salah"],
    ["nonaktif@rt.test", "rahasia123"],
  ]) {
    const { status, body } = await ctx.api("POST", "/api/auth/login", { email, password });
    assert.equal(status, 401, email);
    assert.equal(body.message, "Email atau kata sandi salah");
  }
});

test("endpoint admin: tanpa token 401, token rusak 401, role rt 403", async () => {
  assert.equal((await ctx.api("GET", "/api/admin/payments")).status, 401);
  assert.equal((await ctx.api("GET", "/api/admin/payments", null, "bukan.token.valid")).status, 401);
  const rtToken = await ctx.login("rt@rt.test");
  assert.equal((await ctx.api("GET", "/api/admin/payments", null, rtToken)).status, 403);
});

// === Review laporan ===

test("daftar review: laporan baru muncul dengan nominal seharusnya & tanda selisih", async () => {
  const token = await ctx.login();
  const id = await submitReport([{ houseId: 1, period: "2026-10" }, { houseId: 2, period: "2026-10" }], 300000);

  const { status, body } = await ctx.api("GET", "/api/admin/payments", null, token);
  assert.equal(status, 200);
  const p = body.data.find((d) => d.id === id);
  assert.equal(p.status, "PENDING");
  assert.equal(p.expectedTotal, 210000 + 100000);
  assert.equal(p.reportedAmount, 300000);
  assert.equal(p.amountMatches, false);
  assert.deepEqual(p.items.map((i) => `${i.label} ${i.period} ${i.amount}`), ["A1/1 2026-10 210000", "A1/2 2026-10 100000"]);
  assert.equal(body.summary.PENDING, 1);

  // laporan yang sudah disetujui/ditolak tidak ikut di daftar default
  assert.equal(body.data.some((d) => d.status === "APPROVED" || d.status === "REJECTED"), false);
});

test("approve: status APPROVED, tercatat siapa yang menyetujui, koreksi nominal transfer", async () => {
  const token = await ctx.login();
  const id = await submitReport([{ houseId: 1, period: "2026-10" }], 200000);

  const { status, body } = await ctx.api("POST", `/api/admin/payments/${id}/approve`, { reportedAmount: 210000 }, token);
  assert.equal(status, 200);
  assert.equal(body.status, "APPROVED");
  assert.equal(body.reportedAmount, 210000);
  assert.equal(body.reviewedByName, "Bendahara");
  assert.ok(body.reviewedAt);

  const again = await ctx.api("POST", `/api/admin/payments/${id}/approve`, {}, token);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "ALREADY_REVIEWED");
});

test("reject: wajib alasan, item di-void, bulan bisa dilaporkan lagi", async () => {
  const token = await ctx.login();
  const id = await submitReport([{ houseId: 1, period: "2026-10" }, { houseId: 1, period: "2026-11" }], 420000);

  const noReason = await ctx.api("POST", `/api/admin/payments/${id}/reject`, {}, token);
  assert.equal(noReason.status, 400);

  const { status, body } = await ctx.api("POST", `/api/admin/payments/${id}/reject`, { reason: "Bukti transfer tidak terbaca" }, token);
  assert.equal(status, 200);
  assert.equal(body.status, "REJECTED");
  assert.equal(body.rejectReason, "Bukti transfer tidak terbaca");
  assert.ok(body.items.every((i) => i.voided));

  await submitReport([{ houseId: 1, period: "2026-10" }]);
});

test("approve/reject laporan yang tidak ada → 404", async () => {
  const token = await ctx.login();
  assert.equal((await ctx.api("POST", "/api/admin/payments/9999/approve", {}, token)).status, 404);
  assert.equal((await ctx.api("POST", "/api/admin/payments/9999/reject", { reason: "tidak ada" }, token)).status, 404);
});

// === OCR ===

test("extractAmount: format struk umum", () => {
  assert.equal(extractAmount("Transfer Berhasil\nRp 210.000,00\nBiaya Rp 0"), 210000);
  assert.equal(extractAmount("Total IDR 1,350,000.00"), 1350000);
  assert.equal(extractAmount("Nominal 420.000"), 420000);
  assert.equal(extractAmount("Rp212.500"), 210000, "biaya admin 2.500 dibuang");
  assert.equal(extractAmount("Rp 216.500"), 210000, "biaya admin 6.500 dibuang");
  assert.equal(extractAmount("no ref 998877665544 jumlah 210000 tgl 20261010"), 210000);
  assert.equal(extractAmount(""), null);
  assert.equal(extractAmount("tidak ada angka"), null);
});

test("OCR batch: PENDING → WAITING_APPROVAL dengan nominal terbaca", async () => {
  const id = await submitReport([{ houseId: 1, period: "2026-10" }]);

  const result = await runOcrBatch({
    download: async (url) => Buffer.from(url),
    recognize: async () => "BCA Transfer Berhasil Rp 210.000,00",
  });
  assert.deepEqual(result, { skipped: false, processed: 1, failed: 0 });

  const { rows: [p] } = await db.query("SELECT status, ocr_amount, ocr_attempts FROM payment WHERE id = $1", [id]);
  assert.deepEqual(p, { status: "WAITING_APPROVAL", ocr_amount: 210000, ocr_attempts: 1 });

  const token = await ctx.login();
  const { body } = await ctx.api("GET", `/api/admin/payments/${id}`, null, token);
  assert.equal(body.ocrMatches, true);
});

test("OCR batch: gagal terus → setelah percobaan terakhir diteruskan ke admin dengan pesan error", async () => {
  const id = await submitReport([{ houseId: 1, period: "2026-10" }]);
  const failing = { download: async () => { throw new Error("timeout"); }, recognize: async () => "" };

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    await runOcrBatch(failing);
    const { rows: [p] } = await db.query("SELECT status, ocr_attempts, ocr_error FROM payment WHERE id = $1", [id]);
    assert.equal(p.ocr_attempts, i);
    assert.equal(p.ocr_error, "timeout");
    assert.equal(p.status, i < MAX_ATTEMPTS ? "PENDING" : "WAITING_APPROVAL");
  }
});

test("POST /admin/ocr/run butuh login admin", async () => {
  assert.equal((await ctx.api("POST", "/api/admin/ocr/run")).status, 401);
});
