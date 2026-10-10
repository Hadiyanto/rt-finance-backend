const db = require("../lib/db");

const COMPONENTS = ["KAS_RT", "AGAMA_RT", "SAMPAH", "KEAMANAN", "AGAMA_RW", "KAS_RW", "KKM_RW"];
// nama field mengikuti response lama supaya halaman laporan & PDF tetap sama
const COMPONENT_FIELD = {
  KAS_RT: "kasRT",
  AGAMA_RT: "agamaRT",
  SAMPAH: "sampah",
  KEAMANAN: "keamanan",
  AGAMA_RW: "agamaRW",
  KAS_RW: "kasRW",
  KKM_RW: "kkmRW",
};

/**
 * Breakdown iuran per rumah untuk 1 bulan (hanya laporan yang sudah disetujui).
 * Semua rumah selalu muncul; yang belum bayar bernilai null.
 */
async function feeBreakdown(period) {
  const { rows } = await db.query(
    `SELECT h.id, h.block, h.number, h.resident_name, pi.amount AS total_amount,
            ${COMPONENTS.map((c) => `sum(fpc.amount) FILTER (WHERE fpc.component = '${c}') AS "${c}"`).join(",\n            ")}
     FROM v_house_current h
     LEFT JOIN payment_item pi ON pi.house_id = h.id AND pi.period = $1
                              AND pi.kind = 'MONTHLY_FEE' AND pi.voided_at IS NULL
                              AND EXISTS (SELECT 1 FROM payment p WHERE p.id = pi.payment_id AND p.status = 'APPROVED')
     LEFT JOIN fee_plan_component fpc ON fpc.fee_plan_id = pi.fee_plan_id
     GROUP BY h.id, h.block, h.number, h.resident_name, pi.amount
     ORDER BY h.block, nullif(substring(h.number from '^\\d+'), '')::int, h.number`,
    [period]
  );

  return rows.map((r) => {
    const paid = r.total_amount != null;
    const row = {
      houseId: r.id,
      block: r.block,
      houseNumber: r.number,
      fullName: r.resident_name,
      source: paid ? "MONTHLY_FEE" : null,
      totalAmount: r.total_amount,
    };
    for (const c of COMPONENTS) {
      row[COMPONENT_FIELD[c]] = paid ? r[c] ?? 0 : null;
    }
    return row;
  });
}

/**
 * Tunggakan per rumah dalam rentang periode. Bulan berjalan & ke depan tidak dihitung tunggakan.
 * Laporan yang masih menunggu approval dihitung "pending", bukan tunggakan.
 */
async function arrears(from, to, current) {
  const { rows } = await db.query(
    `WITH months AS (
       SELECT to_char(d, 'YYYY-MM') AS period
       FROM generate_series(to_date($1, 'YYYY-MM'), to_date($2, 'YYYY-MM'), interval '1 month') d
     ),
     grid AS (
       SELECT h.id AS house_id, m.period, fp.total_amount AS fee, p.status AS payment_status
       FROM house h
       CROSS JOIN months m
       LEFT JOIN LATERAL (
         SELECT hfp.fee_plan_id FROM house_fee_plan hfp
         WHERE hfp.house_id = h.id AND hfp.start_period <= m.period
         ORDER BY hfp.start_period DESC LIMIT 1
       ) plan ON true
       LEFT JOIN fee_plan fp ON fp.id = plan.fee_plan_id
       LEFT JOIN payment_item pi ON pi.house_id = h.id AND pi.period = m.period
                                AND pi.kind = 'MONTHLY_FEE' AND pi.voided_at IS NULL
       LEFT JOIN payment p ON p.id = pi.payment_id
       WHERE m.period < $3 AND fp.id IS NOT NULL
     )
     SELECT h.id, h.block, h.number, h.resident_name, h.phone, h.status,
            count(g.period) AS billed_months,
            count(g.period) FILTER (WHERE g.payment_status = 'APPROVED') AS paid_months,
            count(g.period) FILTER (WHERE g.payment_status IS NOT NULL AND g.payment_status <> 'APPROVED') AS pending_months,
            coalesce(array_agg(g.period ORDER BY g.period) FILTER (WHERE g.payment_status IS NULL), '{}') AS unpaid_periods,
            coalesce(sum(g.fee) FILTER (WHERE g.payment_status IS NULL), 0) AS unpaid_amount
     FROM v_house_current h
     LEFT JOIN grid g ON g.house_id = h.id
     GROUP BY h.id, h.block, h.number, h.resident_name, h.phone, h.status
     ORDER BY h.block, nullif(substring(h.number from '^\\d+'), '')::int, h.number`,
    [from, to, current]
  );

  const data = rows.map((r) => ({
    houseId: r.id,
    block: r.block,
    houseNumber: r.number,
    fullName: r.resident_name,
    phoneNumber: r.phone,
    houseStatus: r.status,
    billedMonths: r.billed_months,
    paidMonths: r.paid_months,
    pendingMonths: r.pending_months,
    unpaidMonths: r.unpaid_periods.length,
    unpaidPeriods: r.unpaid_periods,
    unpaidAmount: r.unpaid_amount,
  }));

  return {
    startMonth: from,
    endMonth: to,
    currentPeriod: current,
    totalHouses: data.length,
    housesWithUnpaid: data.filter((d) => d.unpaidMonths > 0).length,
    totalUnpaidAmount: data.reduce((s, d) => s + d.unpaidAmount, 0),
    data,
  };
}

// Rekap THR per rumah untuk satu tahun.
async function thrRecap(year) {
  const { rows } = await db.query(
    `SELECT h.id, h.block, h.number, h.resident_name, pi.amount, p.status, p.paid_at
     FROM v_house_current h
     LEFT JOIN payment_item pi ON pi.house_id = h.id AND pi.kind = 'THR' AND pi.period = $1 AND pi.voided_at IS NULL
     LEFT JOIN payment p ON p.id = pi.payment_id
     ORDER BY h.block, nullif(substring(h.number from '^\\d+'), '')::int, h.number`,
    [String(year)]
  );
  const data = rows.map((r) => ({
    houseId: r.id,
    block: r.block,
    houseNumber: r.number,
    fullName: r.resident_name,
    hasPaid: r.status === "APPROVED",
    amount: r.status === "APPROVED" ? r.amount : null,
    status: r.status,
    date: r.paid_at,
  }));
  return {
    year,
    totalResidents: data.length,
    totalPaid: data.filter((d) => d.hasPaid).length,
    totalAmount: data.reduce((s, d) => s + (d.amount || 0), 0),
    data,
  };
}

module.exports = { feeBreakdown, arrears, thrRecap };
