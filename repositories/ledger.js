// Kas RT: pemasukan/pengeluaran manual oleh bendahara + snapshot iuran bulanan sebagai pemasukan.
const db = require("../lib/db");
const { AppError } = require("../lib/errors");
const { currentPeriod } = require("../lib/period");

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const periodLabel = (period) => `${MONTHS[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}`;

async function categories() {
  // code != null = kategori sistem (diisi snapshot iuran), tidak untuk input manual
  const { rows } = await db.query("SELECT id, code, name, direction FROM ledger_category ORDER BY direction, code NULLS LAST, id");
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
  feePeriod: r.fee_period,
  source: r.ref_type === "FEE_SNAPSHOT" ? "FEE_SNAPSHOT" : "MANUAL",
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
  const { rows: [cat] } = await db.query("SELECT direction, code FROM ledger_category WHERE id = $1", [categoryId]);
  if (!cat) {
    throw new AppError(422, "UNKNOWN_CATEGORY", "Kategori tidak ditemukan");
  }
  if (cat.code) {
    throw new AppError(422, "SYSTEM_CATEGORY", "Kategori ini diisi otomatis lewat snapshot iuran, bukan input manual");
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

// === Snapshot iuran → kas ===

/**
 * Bandingkan iuran yang sudah disetujui untuk 1 periode (per pos kas) dengan yang sudah tercatat di kas.
 * toAdd = selisih yang akan dicatat saat snapshot; legacyEntries = entri iuran manual lama yang akan di-VOID.
 */
async function buildPreview(period, client = db.pool) {
  const { rows: posts } = await client.query(
    `WITH collected AS (
       -- sama dengan /report-iuran: nominal komponen dari tarif tiap item
       SELECT m.category_code, sum(fpc.amount) AS amount
       FROM payment_item pi
       JOIN payment p ON p.id = pi.payment_id AND p.status = 'APPROVED'
       JOIN fee_plan_component fpc ON fpc.fee_plan_id = pi.fee_plan_id
       JOIN fee_ledger_mapping m ON m.component = fpc.component
       WHERE pi.kind = 'MONTHLY_FEE' AND pi.period = $1 AND pi.voided_at IS NULL
       GROUP BY m.category_code
     ),
     recorded AS (
       SELECT category_id, sum(amount) AS amount
       FROM ledger_entry
       WHERE ref_type = 'FEE_SNAPSHOT' AND fee_period = $1 AND status = 'APPROVED'
       GROUP BY category_id
     )
     SELECT c.id AS category_id, c.code, c.name, pc.id AS payout_category_id,
            coalesce(col.amount, 0)::int AS collected,
            coalesce(rec.amount, 0)::int AS recorded
     FROM ledger_category c
     LEFT JOIN ledger_category pc ON pc.code = c.payout_code
     LEFT JOIN collected col ON col.category_code = c.code
     LEFT JOIN recorded rec ON rec.category_id = c.id
     WHERE c.code LIKE 'FEE_%'
     ORDER BY c.id`,
    [period]
  );

  const { rows: legacy } = await client.query(
    `SELECT id, entry_date, amount, description FROM ledger_entry
     WHERE ref_type = 'LEGACY_FEE_INCOME' AND fee_period = $1 AND status = 'APPROVED'
     ORDER BY id`,
    [period]
  );

  const items = posts.map((r) => ({
    categoryId: r.category_id,
    code: r.code,
    name: r.name,
    collected: r.collected,
    recorded: r.recorded,
    toAdd: r.collected - r.recorded,
    // true = langsung disetor ke RW/yayasan (dicatat juga sebagai pengeluaran)
    payout: r.payout_category_id != null,
    payoutCategoryId: r.payout_category_id,
  }));
  const positive = (i) => Math.max(i.toAdd, 0);

  return {
    period,
    label: periodLabel(period),
    alreadySnapshotted: items.some((i) => i.recorded > 0),
    items: items.map(({ payoutCategoryId, ...rest }) => rest),
    _items: items,
    collectedTotal: items.reduce((s, i) => s + i.collected, 0),
    recordedTotal: items.reduce((s, i) => s + i.recorded, 0),
    toAddTotal: items.reduce((s, i) => s + positive(i), 0),
    payoutToAddTotal: items.filter((i) => i.payout).reduce((s, i) => s + positive(i), 0),
    keptToAddTotal: items.filter((i) => !i.payout).reduce((s, i) => s + positive(i), 0),
    legacyEntries: legacy.map((e) => ({ id: e.id, entryDate: e.entry_date, amount: e.amount, description: e.description })),
  };
}

// _items (berisi id kategori setoran) hanya untuk internal
const strip = ({ _items, ...rest }) => rest;

function lastDayOfMonth(period) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * Catat iuran 1 periode ke kas (langsung APPROVED). Bisa diulang: hanya selisih yang ditambahkan
 * sebagai entri "susulan". Entri iuran manual lama periode itu di-VOID.
 */
async function feeSnapshot(period, userId) {
  if (period > currentPeriod()) {
    throw new AppError(422, "FUTURE_PERIOD", "Bulan yang dipilih belum berjalan");
  }
  return db.withTransaction(async (client) => {
    // satu snapshot per periode pada satu waktu
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fee-snapshot:' || $1))", [period]);
    const preview = await buildPreview(period, client);

    const { _items: items } = preview;
    const negative = items.filter((i) => i.toAdd < 0);
    if (negative.length > 0) {
      throw new AppError(409, "RECORDED_EXCEEDS_COLLECTED", "Jumlah di kas lebih besar dari iuran yang disetujui; cek entri kas bulan ini", {
        items: negative.map((i) => i.name),
      });
    }

    const toAdd = items.filter((i) => i.toAdd > 0);
    if (toAdd.length === 0 && preview.legacyEntries.length === 0) {
      return { ...strip(preview), created: [], payouts: [], voided: [] };
    }

    const insert = async (direction, categoryId, amount, description) => {
      const { rows: [row] } = await client.query(
        `INSERT INTO ledger_entry (entry_date, direction, amount, category_id, description, status,
                                   ref_type, fee_period, created_by, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, 'APPROVED', 'FEE_SNAPSHOT', $6, $7, $7, now())
         RETURNING id`,
        [lastDayOfMonth(period), direction, amount, categoryId, description, period, userId]
      );
      return row.id;
    };

    const created = [];
    const payouts = [];
    for (const item of toAdd) {
      const suffix = item.recorded > 0 ? " (susulan)" : "";
      const post = item.name.replace(/^Iuran: /, "");
      created.push(await insert("IN", item.categoryId, item.toAdd, `Iuran ${preview.label} – ${post}${suffix}`));
      if (item.payoutCategoryId) {
        payouts.push(await insert("OUT", item.payoutCategoryId, item.toAdd, `Setoran iuran ${preview.label} – ${post}${suffix}`));
      }
    }

    const { rows: voided } = await client.query(
      `UPDATE ledger_entry SET status = 'VOID', approved_by = $2, approved_at = now()
       WHERE ref_type = 'LEGACY_FEE_INCOME' AND fee_period = $1 AND status = 'APPROVED'
       RETURNING id`,
      [period, userId]
    );

    return { ...strip(await buildPreview(period, client)), created, payouts, voided: voided.map((v) => v.id) };
  });
}

const feeSnapshotPreview = async (period) => strip(await buildPreview(period));

module.exports = { categories, list, create, review, feeSnapshotPreview, feeSnapshot };
