const { test } = require("node:test");
const assert = require("node:assert/strict");
const { useTestServer } = require("./helpers/server");
const reports = require("../repositories/reports");

const ctx = useTestServer();

const PROOF = "https://res.cloudinary.com/demo/image/upload/bukti.jpg";

// === Breakdown iuran ===

test("breakdown: hanya laporan yang disetujui, komponen sesuai tarif, semua rumah tampil", async () => {
  const { status, body } = await ctx.api("GET", "/api/public/reports/fee-breakdown?period=2026-01");
  assert.equal(status, 200);
  assert.equal(body.period, "2026-01");
  assert.deepEqual(body.data.map((r) => `${r.block}/${r.houseNumber}`), ["A1/1", "A1/2", "A1/10", "B1/12A"]);

  const a11 = body.data[0];
  assert.equal(a11.source, "MONTHLY_FEE");
  assert.equal(a11.totalAmount, 210000);
  assert.deepEqual(
    [a11.kasRT, a11.agamaRT, a11.sampah, a11.keamanan, a11.agamaRW, a11.kasRW, a11.kkmRW],
    [30000, 2400, 50000, 97500, 21600, 3000, 5500]
  );

  const a12 = body.data[1];
  assert.equal(a12.totalAmount, null);
  assert.equal(a12.kasRT, null);
});

test("breakdown: laporan PENDING belum masuk, setelah disetujui masuk", async () => {
  const report = await ctx.api("POST", "/api/public/payments", {
    payerName: "Budi Santoso",
    reportedAmount: 100000,
    proofUrl: PROOF,
    items: [{ houseId: 2, period: "2026-08" }],
  });
  const before = await ctx.api("GET", "/api/public/reports/fee-breakdown?period=2026-08");
  assert.equal(before.body.data.find((r) => r.houseId === 2).totalAmount, null);

  const token = await ctx.login();
  await ctx.api("POST", `/api/admin/payments/${report.body.paymentId}/approve`, {}, token);

  const after = await ctx.api("GET", "/api/public/reports/fee-breakdown?period=2026-08");
  const row = after.body.data.find((r) => r.houseId === 2);
  assert.equal(row.totalAmount, 100000);
  assert.equal(row.keamanan, 100000);
  assert.equal(row.kasRT, 0);
});

// === Tunggakan ===

test("tunggakan: dihitung sampai bulan lalu, laporan pending tidak dihitung tunggakan", async () => {
  // laporan A1/1 Maret masih menunggu approval
  await ctx.api("POST", "/api/public/payments", {
    payerName: "Budi Santoso",
    reportedAmount: 210000,
    proofUrl: PROOF,
    items: [{ houseId: 1, period: "2026-03" }],
  });

  const result = await reports.arrears("2026-01", "2026-12", "2026-05");
  const a11 = result.data.find((d) => d.houseId === 1);
  assert.equal(a11.billedMonths, 4); // Jan–Apr
  assert.equal(a11.paidMonths, 1); // Jan
  assert.equal(a11.pendingMonths, 1); // Mar
  assert.deepEqual(a11.unpaidPeriods, ["2026-02", "2026-04"]); // Feb ditolak → tunggakan lagi
  assert.equal(a11.unpaidAmount, 420000);

  const b112a = result.data.find((d) => d.houseId === 3);
  assert.deepEqual(b112a.unpaidPeriods, ["2026-03", "2026-04"], "belum ditagih sebelum 2026-03");

  const a110 = result.data.find((d) => d.houseId === 4);
  assert.equal(a110.unpaidAmount, 186000 * 4, "tarif non-muslim");
});

test("tunggakan: hanya admin, berisi nomor HP", async () => {
  assert.equal((await ctx.api("GET", "/api/admin/arrears")).status, 401);
  const token = await ctx.login();
  const { status, body } = await ctx.api("GET", "/api/admin/arrears?from=2026-01&to=2026-12", null, token);
  assert.equal(status, 200);
  assert.equal(body.data.find((d) => d.houseId === 1).phoneNumber, "081200000001");

  const bad = await ctx.api("GET", "/api/admin/arrears?from=2026-12&to=2026-01", null, token);
  assert.equal(bad.status, 400);
});

// === THR ===

test("THR: lapor, tidak bisa dobel per rumah per tahun, rekap hanya hitung yang disetujui", async () => {
  const payload = { payerName: "Budi Santoso", houseId: 1, year: 2026, amount: 172000, proofUrl: PROOF };
  const first = await ctx.api("POST", "/api/public/thr", payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.label, "A1/1");

  const dup = await ctx.api("POST", "/api/public/thr", { ...payload, amount: 200000 });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "THR_ALREADY_REPORTED");

  const pending = await ctx.api("GET", "/api/public/thr/recap?year=2026");
  const row = pending.body.data.find((d) => d.houseId === 1);
  assert.equal(row.status, "PENDING");
  assert.equal(row.hasPaid, false);

  const token = await ctx.login();
  const list = await ctx.api("GET", "/api/admin/payments?kind=THR", null, token);
  assert.equal(list.body.total, 1);
  await ctx.api("POST", `/api/admin/payments/${first.body.paymentId}/approve`, {}, token);

  const approved = await ctx.api("GET", "/api/public/thr/recap?year=2026");
  assert.equal(approved.body.totalPaid, 1);
  assert.equal(approved.body.totalAmount, 172000);
  assert.equal(approved.body.data.find((d) => d.houseId === 1).hasPaid, true);
});

test("THR: rumah tidak ada → 422, nominal terlalu kecil → 400", async () => {
  const base = { payerName: "Budi", houseId: 1, year: 2026, amount: 172000, proofUrl: PROOF };
  assert.equal((await ctx.api("POST", "/api/public/thr", { ...base, houseId: 999 })).status, 422);
  assert.equal((await ctx.api("POST", "/api/public/thr", { ...base, amount: 500 })).status, 400);
});

// === Kas ===

test("kas publik: hanya transaksi disetujui, saldo dari yang disetujui", async () => {
  const { status, body } = await ctx.api("GET", "/api/public/ledger");
  assert.equal(status, 200);
  assert.equal(body.total, 2);
  assert.equal(body.balance, 350000);
  assert.equal(body.data[0].entryDate, "2026-01-12", "tanggal tetap string, urut terbaru dulu");

  const cats = await ctx.api("GET", "/api/public/ledger/categories");
  assert.deepEqual(cats.body.data.map((c) => c.direction), ["IN", "OUT"]);
});

test("kas admin: tambah, kategori harus cocok, approve sekali, saldo berubah", async () => {
  const token = await ctx.login();
  assert.equal((await ctx.api("GET", "/api/admin/ledger", null, token)).body.total, 3);

  const mismatch = await ctx.api(
    "POST", "/api/admin/ledger",
    { entryDate: "2026-03-01", direction: "IN", amount: 50000, categoryId: 2, description: "Salah kategori" },
    token
  );
  assert.equal(mismatch.status, 422);

  const created = await ctx.api(
    "POST", "/api/admin/ledger",
    { entryDate: "2026-03-01", direction: "OUT", amount: 50000, categoryId: 2, description: "Potong rumput" },
    token
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "PENDING");
  assert.equal(created.body.createdByName, "Bendahara");

  const approved = await ctx.api("POST", `/api/admin/ledger/${created.body.id}/approve`, {}, token);
  assert.equal(approved.body.status, "APPROVED");
  assert.equal((await ctx.api("POST", `/api/admin/ledger/${created.body.id}/reject`, {}, token)).status, 409);

  assert.equal((await ctx.api("GET", "/api/public/ledger")).body.balance, 300000);
});

test("kas admin: tanpa login tidak bisa menambah", async () => {
  const res = await ctx.api("POST", "/api/admin/ledger", {
    entryDate: "2026-03-01", direction: "OUT", amount: 1, categoryId: 2, description: "x",
  });
  assert.equal(res.status, 401);
});
