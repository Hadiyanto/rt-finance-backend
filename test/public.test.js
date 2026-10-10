const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TEST_DATABASE_URL, resetSchema } = require("./helpers/db");

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = "test";
delete process.env.CLOUDINARY_CLOUD_NAME;

const app = require("../app");
const db = require("../lib/db");
const houses = require("../repositories/houses");

const FIXTURES = fs.readFileSync(path.join(__dirname, "fixtures.sql"), "utf8");
const PROOF = "https://res.cloudinary.com/demo/image/upload/bukti.jpg";

let server;
let baseUrl;

before(async () => {
  await resetSchema();
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await db.query(FIXTURES);
});

after(async () => {
  server.close();
  await db.pool.end();
});

async function api(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const monthsOf = (house) => Object.fromEntries(house.months.map((m) => [m.period, m]));

test("GET /houses: urut alami, tanpa nomor HP", async () => {
  const { status, body } = await api("GET", "/api/public/houses");
  assert.equal(status, 200);
  assert.deepEqual(body.data.map((h) => h.label), ["A1/1", "A1/2", "A1/10", "B1/12A"]);
  assert.equal(body.data[0].residentName, "Budi Santoso");
  assert.equal(body.data[1].status, "VACANT");
  for (const h of body.data) {
    assert.equal("phone" in h, false);
  }
});

test("status per bulan: lunas, ditolak, tunggakan, kosong, belum ditagih", async () => {
  const [a11, a12, b112a] = await houses.periodStatus([1, 2, 3], 2026, "2026-10");

  const m1 = monthsOf(a11);
  assert.equal(m1["2026-01"].status, "REPORTED");
  assert.equal(m1["2026-02"].status, "ARREARS", "laporan yang ditolak membuka bulan lagi");
  assert.equal(m1["2026-09"].status, "ARREARS");
  assert.equal(m1["2026-10"].status, "OPEN", "bulan berjalan bukan tunggakan");
  assert.equal(m1["2026-12"].fee, 210000);

  const m2 = monthsOf(a12);
  assert.equal(m2["2026-07"].fee, 210000);
  assert.equal(m2["2026-08"].fee, 100000, "rumah kosong ditagih 100rb");

  const m3 = monthsOf(b112a);
  assert.equal(m3["2026-02"].status, "NOT_BILLED");
  assert.equal(m3["2026-03"].status, "ARREARS");
});

test("GET /house-periods: validasi houseIds", async () => {
  const ok = await api("GET", "/api/public/house-periods?houseIds=1,2&year=2026");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.houses.length, 2);
  assert.equal(ok.body.houses[0].months.length, 12);

  const bad = await api("GET", "/api/public/house-periods?houseIds=abc");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "VALIDATION_ERROR");
});

test("quote: nominal dari tarif rumah per bulan + daftar bentrok", async () => {
  const { status, body } = await api("POST", "/api/public/payments/quote", {
    items: [
      { houseId: 1, period: "2026-01" },
      { houseId: 1, period: "2026-11" },
      { houseId: 2, period: "2026-07" },
      { houseId: 2, period: "2026-08" },
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.expectedTotal, 210000 + 210000 + 210000 + 100000);
  assert.deepEqual(body.conflicts, [{ houseId: 1, label: "A1/1", period: "2026-01" }]);
});

test("POST /payments: 1 laporan untuk 2 rumah × beberapa bulan", async () => {
  const { status, body } = await api("POST", "/api/public/payments", {
    payerName: "  Budi Santoso ",
    reportedAmount: 730000,
    proofUrl: PROOF,
    items: [
      { houseId: 1, period: "2026-10" },
      { houseId: 1, period: "2026-11" },
      { houseId: 2, period: "2026-10" },
      { houseId: 2, period: "2026-11" },
    ],
    amount: 1, // diabaikan: nominal dihitung server
  });
  assert.equal(status, 201);
  assert.equal(body.status, "PENDING");
  assert.equal(body.payerName, "Budi Santoso");
  assert.equal(body.expectedTotal, 210000 * 2 + 100000 * 2);
  assert.equal(body.reportedAmount, 730000);

  const { rows } = await db.query(
    "SELECT house_id, period, amount FROM payment_item WHERE payment_id = $1 ORDER BY house_id, period",
    [body.paymentId]
  );
  assert.deepEqual(rows, [
    { house_id: 1, period: "2026-10", amount: 210000 },
    { house_id: 1, period: "2026-11", amount: 210000 },
    { house_id: 2, period: "2026-10", amount: 100000 },
    { house_id: 2, period: "2026-11", amount: 100000 },
  ]);
});

test("POST /payments: bulan yang sudah dilaporkan ditolak 409 tanpa menyimpan apa pun", async () => {
  const { status, body } = await api("POST", "/api/public/payments", {
    payerName: "Budi Santoso",
    reportedAmount: 420000,
    proofUrl: PROOF,
    items: [{ houseId: 1, period: "2026-01" }, { houseId: 1, period: "2026-03" }],
  });
  assert.equal(status, 409);
  assert.equal(body.code, "PERIOD_ALREADY_REPORTED");
  assert.deepEqual(body.details.conflicts, [{ houseId: 1, label: "A1/1", period: "2026-01" }]);

  const { rows } = await db.query("SELECT count(*) AS n FROM payment");
  assert.equal(rows[0].n, 2);
});

test("POST /payments: bulan yang laporannya ditolak boleh dilaporkan lagi", async () => {
  const { status } = await api("POST", "/api/public/payments", {
    payerName: "Budi Santoso",
    reportedAmount: 210000,
    proofUrl: PROOF,
    items: [{ houseId: 1, period: "2026-02" }],
  });
  assert.equal(status, 201);
});

test("POST /payments: submit bersamaan untuk bulan yang sama → hanya satu yang masuk", async () => {
  const payload = {
    payerName: "Budi Santoso",
    reportedAmount: 210000,
    proofUrl: PROOF,
    items: [{ houseId: 1, period: "2026-12" }],
  };
  const results = await Promise.all([1, 2, 3].map(() => api("POST", "/api/public/payments", payload)));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);

  const { rows } = await db.query(
    "SELECT count(*) AS n FROM payment_item WHERE house_id = 1 AND period = '2026-12' AND voided_at IS NULL"
  );
  assert.equal(rows[0].n, 1);
});

test("POST /payments: validasi input", async () => {
  const base = { payerName: "Budi", reportedAmount: 210000, proofUrl: PROOF, items: [{ houseId: 1, period: "2026-10" }] };

  const cases = [
    [{ items: [] }, 400, "VALIDATION_ERROR"],
    [{ items: [{ houseId: 1, period: "2026-10" }, { houseId: 1, period: "2026-10" }] }, 400, "VALIDATION_ERROR"],
    [{ items: [{ houseId: 1, period: "2026-13" }] }, 400, "VALIDATION_ERROR"],
    [{ reportedAmount: 0 }, 400, "VALIDATION_ERROR"],
    [{ payerName: " " }, 400, "VALIDATION_ERROR"],
    [{ proofUrl: "http://contoh.com/a.jpg" }, 400, "VALIDATION_ERROR"],
    [{ items: [{ houseId: 999, period: "2026-10" }] }, 422, "UNKNOWN_HOUSE"],
    [{ items: [{ houseId: 3, period: "2026-01" }] }, 422, "PERIOD_NOT_BILLED"],
  ];
  for (const [override, expectedStatus, expectedCode] of cases) {
    const { status, body } = await api("POST", "/api/public/payments", { ...base, ...override });
    assert.equal(status, expectedStatus, JSON.stringify(override));
    assert.equal(body.code, expectedCode, JSON.stringify(override));
  }

  const { rows } = await db.query("SELECT count(*) AS n FROM payment");
  assert.equal(rows[0].n, 2, "tidak ada laporan yang tersimpan dari input tidak valid");
});

test("POST /upload-proof tanpa file → 400", async () => {
  const res = await fetch(`${baseUrl}/api/public/upload-proof`, { method: "POST", body: new FormData() });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "FILE_REQUIRED");
});
