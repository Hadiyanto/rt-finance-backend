const db = require("../lib/db");
const { AppError } = require("../lib/errors");

/**
 * Hitung tarif tiap item (rumah × periode) dari house_fee_plan dan cek apakah periodenya sudah dilaporkan.
 * Nominal selalu dihitung di server, tidak pernah dari client.
 */
async function priceItems(client, items) {
  const { rows } = await client.query(
    `SELECT i.ord, i.house_id, i.period,
            h.id IS NOT NULL AS house_exists,
            h.block || '/' || h.number AS label,
            fp.id AS fee_plan_id, fp.code AS fee_plan_code, fp.total_amount AS amount,
            EXISTS (
              SELECT 1 FROM payment_item pi
              WHERE pi.house_id = i.house_id AND pi.period = i.period
                AND pi.kind = 'MONTHLY_FEE' AND pi.voided_at IS NULL
            ) AS already_reported
     FROM unnest($1::int[], $2::text[]) WITH ORDINALITY AS i(house_id, period, ord)
     LEFT JOIN house h ON h.id = i.house_id
     LEFT JOIN LATERAL (
       SELECT hfp.fee_plan_id FROM house_fee_plan hfp
       WHERE hfp.house_id = i.house_id AND hfp.start_period <= i.period
       ORDER BY hfp.start_period DESC LIMIT 1
     ) plan ON true
     LEFT JOIN fee_plan fp ON fp.id = plan.fee_plan_id
     ORDER BY i.ord`,
    [items.map((i) => i.houseId), items.map((i) => i.period)]
  );
  return rows;
}

function summarize(priced) {
  const unknownHouses = priced.filter((r) => !r.house_exists).map((r) => r.house_id);
  if (unknownHouses.length > 0) {
    throw new AppError(422, "UNKNOWN_HOUSE", "Rumah tidak ditemukan", { houseIds: [...new Set(unknownHouses)] });
  }

  const notBilled = priced.filter((r) => r.fee_plan_id == null);
  if (notBilled.length > 0) {
    throw new AppError(422, "PERIOD_NOT_BILLED", "Ada bulan yang belum ditagih untuk rumah tersebut", {
      items: notBilled.map((r) => ({ houseId: r.house_id, label: r.label, period: r.period })),
    });
  }

  return {
    items: priced.map((r) => ({
      houseId: r.house_id,
      label: r.label,
      period: r.period,
      feePlanCode: r.fee_plan_code,
      amount: r.amount,
    })),
    expectedTotal: priced.reduce((sum, r) => sum + r.amount, 0),
    conflicts: priced
      .filter((r) => r.already_reported)
      .map((r) => ({ houseId: r.house_id, label: r.label, period: r.period })),
  };
}

// Perkiraan nominal + bulan yang sudah dilaporkan, tanpa menyimpan apa pun.
async function quote(items) {
  return summarize(await priceItems(db.pool, items));
}

const conflictError = (conflicts) =>
  new AppError(409, "PERIOD_ALREADY_REPORTED", "Ada bulan yang sudah pernah dilaporkan", { conflicts });

/**
 * Laporan "Setor Iuran" dari warga: 1 payment (status PENDING) + N payment_item.
 * Unique index payment_item_active_uniq tetap jadi penjaga terakhir kalau ada submit bersamaan.
 */
async function createPublic({ payerName, reportedAmount, proofUrl, items }) {
  try {
    return await db.withTransaction(async (client) => {
      const summary = summarize(await priceItems(client, items));
      if (summary.conflicts.length > 0) {
        throw conflictError(summary.conflicts);
      }

      const { rows: [payment] } = await client.query(
        `INSERT INTO payment (payer_name, reported_amount, proof_url, status)
         VALUES ($1, $2, $3, 'PENDING')
         RETURNING id, status, created_at`,
        [payerName, reportedAmount, proofUrl]
      );

      await client.query(
        `INSERT INTO payment_item (payment_id, house_id, kind, period, fee_plan_id, amount)
         SELECT $1, i.house_id, 'MONTHLY_FEE', i.period, fp.id, fp.total_amount
         FROM unnest($2::int[], $3::text[], $4::text[]) AS i(house_id, period, fee_plan_code)
         JOIN fee_plan fp ON fp.code = i.fee_plan_code`,
        [
          payment.id,
          summary.items.map((i) => i.houseId),
          summary.items.map((i) => i.period),
          summary.items.map((i) => i.feePlanCode),
        ]
      );

      return {
        paymentId: payment.id,
        status: payment.status,
        payerName,
        reportedAmount,
        expectedTotal: summary.expectedTotal,
        items: summary.items,
      };
    });
  } catch (err) {
    if (db.isUniqueViolation(err)) {
      // kalah balapan dengan submit lain: laporkan bulan yang sekarang sudah terisi
      const { conflicts } = summarize(await priceItems(db.pool, items));
      throw conflictError(conflicts);
    }
    throw err;
  }
}

/**
 * Laporan THR dari warga: nominal sukarela (diisi warga), 1 rumah per tahun.
 */
async function createPublicThr({ payerName, houseId, year, amount, proofUrl }) {
  const period = String(year);
  try {
    return await db.withTransaction(async (client) => {
      const { rows: [house] } = await client.query("SELECT id, block || '/' || number AS label FROM house WHERE id = $1", [houseId]);
      if (!house) {
        throw new AppError(422, "UNKNOWN_HOUSE", "Rumah tidak ditemukan", { houseIds: [houseId] });
      }

      const { rows: [payment] } = await client.query(
        `INSERT INTO payment (payer_name, reported_amount, proof_url, status)
         VALUES ($1, $2, $3, 'PENDING') RETURNING id, status`,
        [payerName, amount, proofUrl ?? null]
      );
      await client.query(
        `INSERT INTO payment_item (payment_id, house_id, kind, period, amount) VALUES ($1, $2, 'THR', $3, $4)`,
        [payment.id, houseId, period, amount]
      );
      return { paymentId: payment.id, status: payment.status, payerName, houseId, label: house.label, year, amount };
    });
  } catch (err) {
    if (db.isUniqueViolation(err)) {
      throw new AppError(409, "THR_ALREADY_REPORTED", `THR ${year} untuk rumah ini sudah pernah dilaporkan`);
    }
    throw err;
  }
}

module.exports = { quote, createPublic, createPublicThr };
