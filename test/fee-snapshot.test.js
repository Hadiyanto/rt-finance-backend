const { test } = require("node:test");
const assert = require("node:assert/strict");
const { useTestServer } = require("./helpers/server");

const ctx = useTestServer();
const { db } = ctx;

const PROOF = "https://res.cloudinary.com/demo/image/upload/bukti.jpg";

// Fixture: A1/1 bulan 2026-01 sudah lunas (IURAN_210, disetujui). Saldo kas awal 350.000.
const JAN_POSTS = {
  FEE_KAS_RT: 30000 + 2400,
  FEE_SAMPAH: 50000,
  FEE_KEAMANAN_RW: 97500 + 21600 + 3000,
  FEE_KKM_RW: 5500,
};

const byCode = (items) => Object.fromEntries(items.map((i) => [i.code, i]));

// yang tetap di kas RT; 3 pos lain langsung disetor (pemasukan + pengeluaran setoran)
const KEPT = JAN_POSTS.FEE_KAS_RT;

test("pratinjau: iuran disetujui dipecah ke 4 pos sesuai rekap /report-iuran", async () => {
  const token = await ctx.login();
  const { status, body } = await ctx.api("GET", "/api/admin/ledger/fee-snapshot?period=2026-01", null, token);
  assert.equal(status, 200);
  assert.equal(body.label, "Januari 2026");
  assert.equal(body.alreadySnapshotted, false);
  const items = byCode(body.items);
  for (const [code, amount] of Object.entries(JAN_POSTS)) {
    assert.equal(items[code].collected, amount, code);
    assert.equal(items[code].toAdd, amount, code);
  }
  assert.equal(body.collectedTotal, 210000);
  assert.equal(items.FEE_KAS_RT.payout, false);
  assert.ok(items.FEE_SAMPAH.payout && items.FEE_KEAMANAN_RW.payout && items.FEE_KKM_RW.payout);
  assert.equal(body.keptToAddTotal, KEPT);
  assert.equal(body.payoutToAddTotal, 210000 - KEPT);
  assert.equal("_items" in body, false);

  // sama dengan total breakdown laporan iuran
  const report = await ctx.api("GET", "/api/public/reports/fee-breakdown?period=2026-01");
  assert.equal(report.body.data.reduce((s, r) => s + (r.totalAmount || 0), 0), body.collectedTotal);
});

test("snapshot: 4 pemasukan + 3 setoran RW/yayasan di akhir bulan; saldo hanya bertambah Kas + Agama RT; diulang tidak menambah apa pun", async () => {
  const token = await ctx.login();
  const first = await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.created.length, 4);
  assert.equal(first.body.payouts.length, 3);
  assert.equal(first.body.alreadySnapshotted, true);
  assert.equal(first.body.toAddTotal, 0);

  const { rows } = await db.query(
    "SELECT entry_date, direction, amount, status, description FROM ledger_entry WHERE ref_type = 'FEE_SNAPSHOT' ORDER BY id"
  );
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.entry_date === "2026-01-31" && r.status === "APPROVED"));
  assert.equal(rows[0].description, "Iuran Januari 2026 – Kas + Agama RT");
  const out = rows.filter((r) => r.direction === "OUT");
  assert.deepEqual(out.map((r) => r.description), [
    "Setoran iuran Januari 2026 – Sampah",
    "Setoran iuran Januari 2026 – Keamanan + Agama RW + Kas RW",
    "Setoran iuran Januari 2026 – KKM RW",
  ]);
  assert.equal(out.reduce((s, r) => s + r.amount, 0), 210000 - KEPT);

  assert.equal((await ctx.api("GET", "/api/public/ledger")).body.balance, 350000 + KEPT);

  const again = await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, token);
  assert.equal(again.body.created.length, 0);
  assert.equal(again.body.payouts.length, 0);
  assert.equal((await ctx.api("GET", "/api/public/ledger")).body.balance, 350000 + KEPT);
});

test("bayar telat: setelah laporan baru disetujui, snapshot ulang hanya menambah selisih sebagai susulan", async () => {
  const token = await ctx.login();
  await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, token);

  // A1/2 melapor Januari (telat) lalu disetujui
  const report = await ctx.api("POST", "/api/public/payments", {
    payerName: "Budi Santoso", reportedAmount: 210000, proofUrl: PROOF, items: [{ houseId: 2, period: "2026-01" }],
  });
  await ctx.api("POST", `/api/admin/payments/${report.body.paymentId}/approve`, {}, token);

  const preview = await ctx.api("GET", "/api/admin/ledger/fee-snapshot?period=2026-01", null, token);
  assert.equal(preview.body.toAddTotal, 210000);
  assert.equal(byCode(preview.body.items).FEE_KAS_RT.recorded, JAN_POSTS.FEE_KAS_RT);

  const second = await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, token);
  assert.equal(second.body.created.length, 4);
  assert.equal(second.body.payouts.length, 3, "setoran susulan ikut dicatat");
  const { rows } = await db.query(
    "SELECT description FROM ledger_entry WHERE ref_type = 'FEE_SNAPSHOT' AND description LIKE '%susulan%'"
  );
  assert.equal(rows.length, 7);
  assert.equal((await ctx.api("GET", "/api/public/ledger")).body.balance, 350000 + 2 * KEPT);
});

test("entri iuran manual lama bulan itu di-VOID (tetap tersimpan, tidak dihitung saldo)", async () => {
  const token = await ctx.login();
  await db.query(
    `INSERT INTO ledger_entry (entry_date, direction, amount, category_id, description, status, ref_type, fee_period)
     VALUES ('2026-02-04', 'IN', 30000, 101, 'Kas Jan 2026', 'APPROVED', 'LEGACY_FEE_INCOME', '2026-01')`
  );
  assert.equal((await ctx.api("GET", "/api/public/ledger")).body.balance, 380000);

  const preview = await ctx.api("GET", "/api/admin/ledger/fee-snapshot?period=2026-01", null, token);
  assert.equal(preview.body.legacyEntries.length, 1);

  const result = await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, token);
  assert.equal(result.body.voided.length, 1);
  assert.equal((await ctx.api("GET", "/api/public/ledger")).body.balance, 350000 + KEPT, "kas lama diganti, bukan ditambah");

  const admin = await ctx.api("GET", "/api/admin/ledger", null, token);
  assert.equal(admin.body.data.find((e) => e.description === "Kas Jan 2026").status, "VOID");
  const pub = await ctx.api("GET", "/api/public/ledger");
  assert.equal(pub.body.data.some((e) => e.description === "Kas Jan 2026"), false);
});

test("snapshot: bulan yang belum berjalan ditolak, format salah 400, wajib login admin", async () => {
  const token = await ctx.login();
  assert.equal((await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2099-01" }, token)).status, 422);
  assert.equal((await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-1" }, token)).status, 400);
  assert.equal((await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" })).status, 401);
  assert.equal((await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, await ctx.login("rt@rt.test"))).status, 403);
});

test("kategori sistem iuran & setoran tidak bisa dipakai untuk input manual", async () => {
  const token = await ctx.login();
  for (const [code, direction] of [["FEE_SAMPAH", "IN"], ["SETOR_KKM_RW", "OUT"]]) {
    const { rows: [cat] } = await db.query("SELECT id FROM ledger_category WHERE code = $1", [code]);
    const res = await ctx.api(
      "POST", "/api/admin/ledger",
      { entryDate: "2026-03-01", direction, amount: 1000, categoryId: cat.id, description: "Manual" },
      token
    );
    assert.equal(res.status, 422, code);
    assert.equal(res.body.code, "SYSTEM_CATEGORY");
  }
});

// === Dana iuran mengendap ===

test("mengendap: iuran disetujui yang belum tercatat di kas, bergeser setelah snapshot", async () => {
  const token = await ctx.login();
  const held = async () => (await ctx.api("GET", "/api/public/ledger/held-fees")).body;

  // belum ada snapshot sama sekali → semua iuran disetujui dihitung
  let h = await held();
  assert.equal(h.lastSnapshotPeriod, null);
  assert.deepEqual(h.months.map((m) => [m.period, m.total]), [["2026-01", 210000]]);

  // snapshot Januari → Januari tidak lagi mengendap
  await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, token);
  h = await held();
  assert.equal(h.lastSnapshotPeriod, "2026-01");
  assert.equal(h.total, 0);

  // A1/1 bayar di muka Mar–Apr → mengendap sampai bulannya di-snapshot
  const prepaid = await ctx.api("POST", "/api/public/payments", {
    payerName: "Budi Santoso", reportedAmount: 420000, proofUrl: PROOF,
    items: [{ houseId: 1, period: "2026-03" }, { houseId: 1, period: "2026-04" }],
  });
  await ctx.api("POST", `/api/admin/payments/${prepaid.body.paymentId}/approve`, {}, token);
  // A1/2 bayar Januari (telat, setelah Januari di-snapshot)
  const late = await ctx.api("POST", "/api/public/payments", {
    payerName: "Budi Santoso", reportedAmount: 210000, proofUrl: PROOF, items: [{ houseId: 2, period: "2026-01" }],
  });
  await ctx.api("POST", `/api/admin/payments/${late.body.paymentId}/approve`, {}, token);

  h = await held();
  assert.deepEqual(
    h.months.map((m) => [m.period, m.total, m.afterLastSnapshot]),
    [["2026-01", 210000, false], ["2026-03", 210000, true], ["2026-04", 210000, true]]
  );
  assert.equal(h.total, 630000);
  assert.equal(h.kept, 3 * JAN_POSTS.FEE_KAS_RT, "bagian Kas + Agama RT");
  assert.equal(h.kept + h.payout, h.total);

  // laporan yang belum disetujui tidak dihitung (uang belum diverifikasi)
  await ctx.api("POST", "/api/public/payments", {
    payerName: "Budi Santoso", reportedAmount: 210000, proofUrl: PROOF, items: [{ houseId: 1, period: "2026-05" }],
  });
  assert.equal((await held()).total, 630000);

  // susulan Januari + snapshot Maret → tinggal April
  await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-01" }, token);
  await ctx.api("POST", "/api/admin/ledger/fee-snapshot", { period: "2026-03" }, token);
  h = await held();
  assert.equal(h.lastSnapshotPeriod, "2026-03");
  assert.deepEqual(h.months.map((m) => [m.period, m.total]), [["2026-04", 210000]]);
});

// === THR → kas ===

test("THR: snapshot mencatat pemasukan THR + setoran THR ke RW (saldo tetap), susulan hanya selisih", async () => {
  const token = await ctx.login();
  const report = async (houseId, amount) => {
    const r = await ctx.api("POST", "/api/public/thr", { payerName: "Budi", houseId, year: 2026, amount, proofUrl: PROOF });
    await ctx.api("POST", `/api/admin/payments/${r.body.paymentId}/approve`, {}, token);
  };
  const balance = async () => (await ctx.api("GET", "/api/public/ledger")).body.balance;
  const before = await balance();

  await report(1, 172000);
  const preview = await ctx.api("GET", "/api/admin/ledger/thr-snapshot?year=2026", null, token);
  assert.deepEqual(preview.body, { year: 2026, houses: 1, collected: 172000, recorded: 0, toAdd: 172000 });

  const first = await ctx.api("POST", "/api/admin/ledger/thr-snapshot", { year: 2026, entryDate: "2026-03-10" }, token);
  assert.equal(first.status, 200);
  assert.equal(first.body.created.length, 2);
  const { rows } = await db.query(
    "SELECT entry_date, direction, amount, description, status FROM ledger_entry WHERE ref_type = 'THR_SNAPSHOT' ORDER BY id"
  );
  assert.deepEqual(rows, [
    { entry_date: "2026-03-10", direction: "IN", amount: 172000, description: "THR 2026 dari warga (1 rumah)", status: "APPROVED" },
    { entry_date: "2026-03-10", direction: "OUT", amount: 172000, description: "Setoran THR 2026 ke RW", status: "APPROVED" },
  ]);
  assert.equal(await balance(), before, "THR hanya titip lewat");

  assert.equal((await ctx.api("POST", "/api/admin/ledger/thr-snapshot", { year: 2026 }, token)).body.created.length, 0);

  await report(2, 200000);
  const second = await ctx.api("POST", "/api/admin/ledger/thr-snapshot", { year: 2026 }, token);
  assert.equal(second.body.created.length, 2);
  assert.equal(second.body.recorded, 372000);
  const { rows: late } = await db.query("SELECT amount FROM ledger_entry WHERE description LIKE '%(susulan)' AND ref_type = 'THR_SNAPSHOT'");
  assert.deepEqual(late.map((r) => r.amount), [200000, 200000]);

  assert.equal((await ctx.api("POST", "/api/admin/ledger/thr-snapshot", { year: 2026 })).status, 401);
});
