const db = require("../lib/db");
const { monthsOfYear } = require("../lib/period");

const houseLabel = (h) => `${h.block}/${h.number}`;

// Urut blok, lalu nomor secara numerik (2 sebelum 10, 12A setelah 12).
const NATURAL_ORDER = `block, nullif(substring(number from '^\\d+'), '')::int, number`;

// Data publik: tanpa nomor HP.
async function listPublic() {
  const { rows } = await db.query(
    `SELECT id, block, number, resident_name, status
     FROM v_house_current
     ORDER BY ${NATURAL_ORDER}`
  );
  return rows.map((h) => ({
    id: h.id,
    label: houseLabel(h),
    block: h.block,
    number: h.number,
    residentName: h.resident_name,
    status: h.status,
  }));
}

/**
 * Status iuran per rumah per bulan dalam satu tahun.
 * REPORTED   = sudah ada laporan aktif (menunggu approval atau sudah disetujui)
 * NOT_BILLED = rumah belum/tidak ditagih di periode itu
 * ARREARS    = bulan sebelum bulan berjalan yang ditagih tapi belum dilaporkan (tunggakan)
 * OPEN       = bulan berjalan / ke depan yang belum dilaporkan
 */
async function periodStatus(houseIds, year, current) {
  const { rows } = await db.query(
    `SELECT h.id AS house_id, h.block, h.number, m.period,
            fp.code AS fee_plan_code, fp.total_amount AS fee,
            CASE
              WHEN pi.id IS NOT NULL   THEN 'REPORTED'
              WHEN fp.id IS NULL       THEN 'NOT_BILLED'
              WHEN m.period < $3       THEN 'ARREARS'
              ELSE                          'OPEN'
            END AS status
     FROM house h
     CROSS JOIN unnest($2::text[]) AS m(period)
     LEFT JOIN LATERAL (
       SELECT hfp.fee_plan_id FROM house_fee_plan hfp
       WHERE hfp.house_id = h.id AND hfp.start_period <= m.period
       ORDER BY hfp.start_period DESC LIMIT 1
     ) plan ON true
     LEFT JOIN fee_plan fp ON fp.id = plan.fee_plan_id
     LEFT JOIN payment_item pi ON pi.house_id = h.id AND pi.period = m.period
                              AND pi.kind = 'MONTHLY_FEE' AND pi.voided_at IS NULL
     WHERE h.id = ANY($1::int[])
     ORDER BY h.id, m.period`,
    [houseIds, monthsOfYear(year), current]
  );

  const byHouse = new Map();
  for (const r of rows) {
    if (!byHouse.has(r.house_id)) {
      byHouse.set(r.house_id, { houseId: r.house_id, label: houseLabel(r), months: [] });
    }
    byHouse.get(r.house_id).months.push({
      period: r.period,
      status: r.status,
      feePlanCode: r.fee_plan_code,
      fee: r.fee,
    });
  }
  // urutan mengikuti permintaan client
  return houseIds.filter((id) => byHouse.has(id)).map((id) => byHouse.get(id));
}

module.exports = { listPublic, periodStatus };
