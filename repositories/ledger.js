// Kas RT: pemasukan/pengeluaran manual oleh bendahara.
const db = require("../lib/db");
const { AppError } = require("../lib/errors");

async function categories() {
  const { rows } = await db.query("SELECT id, name, direction FROM ledger_category ORDER BY direction, id");
  return rows;
}

const toDto = (r) => ({
  id: r.id,
  entryDate: r.entry_date,
  direction: r.direction,
  amount: r.amount,
  category: { id: r.category_id, name: r.category_name },
  description: r.description,
  proofUrl: r.proof_url,
  status: r.status,
  createdByName: r.created_by_name,
  approvedByName: r.approved_by_name,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
});

const ENTRY_SELECT = `
  SELECT e.*, c.name AS category_name, cu.name AS created_by_name, au.name AS approved_by_name
  FROM ledger_entry e
  JOIN ledger_category c ON c.id = e.category_id
  LEFT JOIN app_user cu ON cu.id = e.created_by
  LEFT JOIN app_user au ON au.id = e.approved_by`;

// Publik hanya melihat transaksi yang sudah disetujui; admin melihat semua.
async function list({ includeUnapproved = false } = {}) {
  const { rows } = await db.query(
    `${ENTRY_SELECT}
     WHERE $1 OR e.status = 'APPROVED'
     ORDER BY e.entry_date DESC, e.id DESC`,
    [includeUnapproved]
  );
  const { rows: [{ balance }] } = await db.query(
    `SELECT coalesce(sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END), 0) AS balance
     FROM ledger_entry WHERE status = 'APPROVED'`
  );
  return { total: rows.length, balance, data: rows.map(toDto) };
}

async function create({ entryDate, direction, amount, categoryId, description, proofUrl }, userId) {
  const { rows: [cat] } = await db.query("SELECT direction FROM ledger_category WHERE id = $1", [categoryId]);
  if (!cat) {
    throw new AppError(422, "UNKNOWN_CATEGORY", "Kategori tidak ditemukan");
  }
  if (cat.direction !== direction) {
    throw new AppError(422, "CATEGORY_MISMATCH", "Kategori tidak sesuai dengan jenis transaksi");
  }
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO ledger_entry (entry_date, direction, amount, category_id, description, proof_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [entryDate, direction, amount, categoryId, description, proofUrl ?? null, userId]
  );
  return getById(id);
}

async function getById(id) {
  const { rows: [row] } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "Transaksi tidak ditemukan");
  }
  return toDto(row);
}

async function review(id, userId, status) {
  const { rowCount } = await db.query(
    `UPDATE ledger_entry SET status = $3, approved_by = $2, approved_at = now()
     WHERE id = $1 AND status = 'PENDING'`,
    [id, userId, status]
  );
  if (rowCount === 0) {
    const current = await getById(id); // 404 kalau tidak ada
    throw new AppError(409, "ALREADY_REVIEWED", `Transaksi sudah berstatus ${current.status}`);
  }
  return getById(id);
}

module.exports = { categories, list, create, review };
