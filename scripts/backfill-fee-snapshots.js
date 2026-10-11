// Catat iuran ke kas (snapshot) untuk setiap bulan dalam rentang, sama seperti tombol "Iuran" di /pengeluaran:
// pemasukan per pos + setoran otomatis untuk pos yang diteruskan ke RW/yayasan.
// Aman diulang: bulan yang sudah tercatat hanya ditambah selisihnya (kalau ada).
// Pakai: DATABASE_URL=... node scripts/backfill-fee-snapshots.js [dari=2025-12] [sampai=bulan lalu] [--thr TAHUN:TANGGAL ...]
//   --thr 2026:2026-03-10  → catat THR 2026 (pemasukan + setoran ke RW) bertanggal 10 Mar 2026
require("dotenv").config({ quiet: true });

const db = require("../lib/db");
const ledger = require("../repositories/ledger");
const { currentPeriod } = require("../lib/period");

const shift = (period, delta) => {
  const [y, m] = period.split("-").map(Number);
  const i = y * 12 + (m - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};

async function main() {
  const args = process.argv.slice(2);
  const thr = [];
  for (let i = args.indexOf("--thr"); i !== -1; i = args.indexOf("--thr")) {
    thr.push(args[i + 1]);
    args.splice(i, 2);
  }
  const from = args[0] || "2025-12";
  const to = args[1] || shift(currentPeriod(), -1);
  const rp = (n) => `Rp${n.toLocaleString("id-ID")}`;

  for (let period = from; period <= to; period = shift(period, 1)) {
    const r = await ledger.feeSnapshot(period, null);
    const added = r.created.length ? `+${r.created.length} pemasukan, ${r.payouts.length} setoran RW/yayasan` : "tidak ada tambahan";
    const voided = r.voided.length ? `, ${r.voided.length} entri lama di-VOID` : "";
    console.log(`  ${period}: ${added}${voided} (total iuran ${rp(r.collectedTotal)})`);
  }

  for (const spec of thr) {
    const [year, date] = spec.split(":");
    const r = await ledger.thrSnapshot(Number(year), null, date);
    const added = r.created.length ? "+pemasukan & setoran THR" : "tidak ada tambahan";
    console.log(`  THR ${year}: ${added} (${r.houses} rumah, ${rp(r.collected)}, tanggal ${date})`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
