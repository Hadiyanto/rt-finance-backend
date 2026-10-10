// Review laporan iuran oleh admin/bendahara: daftar, detail, setujui, tolak.
const db = require("../lib/db");
const { AppError } = require("../lib/errors");

const REVIEWABLE = ["PENDING", "WAITING_APPROVAL", "WAITING_MANUAL_INPUT"];

const PAYMENT_SELECT = `
  SELECT p.id, p.payer_name, p.paid_at, p.method, p.reported_amount, p.proof_url, p.status,
         p.ocr_amount, p.ocr_error, p.notes, p.reject_reason, p.reviewed_at, p.created_at,
         u.name AS reviewed_by_name,
         coalesce(sum(pi.amount) FILTER (WHERE pi.voided_at IS NULL), 0) AS expected_total,
         coalesce(json_agg(json_build_object(
           'id', pi.id, 'houseId', h.id, 'label', h.block || '/' || h.number,
           'kind', pi.kind, 'period', pi.period, 'amount', pi.amount, 'voided', pi.voided_at IS NOT NULL
         ) ORDER BY h.block, h.number, pi.period) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
  FROM payment p
  LEFT JOIN payment_item pi ON pi.payment_id = p.id
  LEFT JOIN house h ON h.id = pi.house_id
  LEFT JOIN app_user u ON u.id = p.reviewed_by`;

function toDto(r) {
  return {
    id: r.id,
    payerName: r.payer_name,
    paidAt: r.paid_at,
    method: r.method,
    reportedAmount: r.reported_amount,
    expectedTotal: r.expected_total,
    ocrAmount: r.ocr_amount,
    ocrError: r.ocr_error,
    // admin cepat melihat laporan yang perlu dicek lebih teliti
    amountMatches: r.reported_amount === r.expected_total,
    ocrMatches: r.ocr_amount == null ? null : r.ocr_amount === r.reported_amount,
    proofUrl: r.proof_url,
    status: r.status,
    notes: r.notes,
    rejectReason: r.reject_reason,
    reviewedAt: r.reviewed_at,
    reviewedByName: r.reviewed_by_name,
    createdAt: r.created_at,
    items: r.items,
  };
}

async function list({ statuses = REVIEWABLE, kind } = {}) {
  const { rows } = await db.query(
    `${PAYMENT_SELECT}
     WHERE p.status = ANY($1::text[])
       AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM payment_item k WHERE k.payment_id = p.id AND k.kind = $2))
     GROUP BY p.id, u.name
     ORDER BY p.created_at`,
    [statuses, kind ?? null]
  );
  const data = rows.map(toDto);
  const summary = Object.fromEntries(statuses.map((s) => [s, data.filter((d) => d.status === s).length]));
  return { total: data.length, summary, data };
}

async function getById(id, client = db.pool) {
  const { rows: [row] } = await client.query(`${PAYMENT_SELECT} WHERE p.id = $1 GROUP BY p.id, u.name`, [id]);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "Laporan tidak ditemukan");
  }
  return toDto(row);
}

// Kunci baris & pastikan masih bisa direview (mencegah approve/reject ganda).
async function lockReviewable(client, id) {
  const { rows: [p] } = await client.query("SELECT id, status FROM payment WHERE id = $1 FOR UPDATE", [id]);
  if (!p) {
    throw new AppError(404, "NOT_FOUND", "Laporan tidak ditemukan");
  }
  if (!REVIEWABLE.includes(p.status)) {
    throw new AppError(409, "ALREADY_REVIEWED", `Laporan sudah berstatus ${p.status}`);
  }
}

async function approve(id, userId, { reportedAmount, notes } = {}) {
  return db.withTransaction(async (client) => {
    await lockReviewable(client, id);
    await client.query(
      `UPDATE payment
       SET status = 'APPROVED', reviewed_by = $2, reviewed_at = now(),
           reported_amount = coalesce($3, reported_amount),
           notes = coalesce($4, notes)
       WHERE id = $1`,
      [id, userId, reportedAmount ?? null, notes ?? null]
    );
    return getById(id, client);
  });
}

// Tolak: item di-void supaya bulan-bulannya bisa dilaporkan ulang.
async function reject(id, userId, reason) {
  return db.withTransaction(async (client) => {
    await lockReviewable(client, id);
    await client.query(
      `UPDATE payment SET status = 'REJECTED', reject_reason = $3, reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
      [id, userId, reason]
    );
    await client.query("UPDATE payment_item SET voided_at = now() WHERE payment_id = $1 AND voided_at IS NULL", [id]);
    return getById(id, client);
  });
}

module.exports = { REVIEWABLE, list, getById, approve, reject };
