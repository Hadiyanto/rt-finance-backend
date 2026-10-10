-- Migrasi data schema `legacy` (Prisma lama) → `public` (skema v2).
-- Jalankan di DB yang schema public-nya baru di-migrate (kosong selain fee_plan):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrate-legacy.sql
-- Semua dalam 1 transaksi; cek rekonsiliasi di akhir akan membatalkan semuanya kalau angka tidak cocok.
-- Keputusan & data yang sengaja tidak dimigrasi: docs/catatan-migrasi-data.md
--
-- Catatan: kolom timestamp Prisma bertipe `timestamp without time zone` dan berisi waktu UTC.

\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM payment) OR EXISTS (SELECT 1 FROM house) THEN
    RAISE EXCEPTION 'Schema public sudah berisi data; jalankan scripts/db-reset-local.sh dulu';
  END IF;
END $$;

-- Baris legacy yang sengaja tidak dimigrasi
CREATE TEMP TABLE legacy_excluded (source text, legacy_id int, reason text) ON COMMIT DROP;
INSERT INTO legacy_excluded VALUES
  ('MonthlyFee', 229, 'B1/10 periode 2031-04: salah input, periode 2026-04 sudah tercatat');

CREATE TEMP VIEW legacy_fee AS
SELECT f.*, to_char(f.date, 'YYYY-MM') AS period
FROM legacy."MonthlyFee" f
WHERE NOT EXISTS (SELECT 1 FROM legacy_excluded x WHERE x.source = 'MonthlyFee' AND x.legacy_id = f.id);

-- === app_user (id dipertahankan) ===
INSERT INTO app_user (id, name, email, password_hash, role, created_at, updated_at)
SELECT id, name, email, password, role, "createdAt" AT TIME ZONE 'UTC', "updatedAt" AT TIME ZONE 'UTC'
FROM legacy."User";
SELECT setval(pg_get_serial_sequence('app_user', 'id'), (SELECT max(id) FROM app_user));

-- === house ===
INSERT INTO house (block, number, occupant_name, phone, occupancy_type, status, notes, created_at, updated_at)
SELECT block, "houseNumber", "fullName", "phoneNumber",
       CASE lower("occupancyType") WHEN 'tenant' THEN 'TENANT' ELSE 'OWNER' END,
       CASE lower("houseStatus") WHEN 'vacant' THEN 'VACANT' ELSE 'OCCUPIED' END,
       notes, "createdAt" AT TIME ZONE 'UTC', "updatedAt" AT TIME ZONE 'UTC'
FROM legacy."Resident";

-- === rw_submission ===
INSERT INTO rw_submission (period, total_amount, submitted_at, notes, legacy_ref)
SELECT period, "totalAmount", "submittedAt" AT TIME ZONE 'UTC', notes, 'RWSubmission:' || id
FROM legacy."RWSubmission";

-- === Iuran bulanan: 1 MonthlyFee = 1 payment + 1 payment_item ===
-- Termasuk baris "from DEFERRED" (sudah 210rb di legacy); DeferredSubscription sendiri tidak dimigrasi.
INSERT INTO payment (payer_name, paid_at, method, reported_amount, proof_url, status,
                     ocr_text, ocr_attempts, ocr_error, notes, legacy_ref, created_at, updated_at)
SELECT f."fullName",
       (f."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jakarta')::date,
       'TRANSFER',
       f.amount,
       f."imageUrl",
       CASE trim(f.status) WHEN 'COMPLETED' THEN 'APPROVED' WHEN 'FAILED' THEN 'WAITING_MANUAL_INPUT' ELSE trim(f.status) END,
       f."rawText", f.attempt, f."errorMessage", f.notes,
       'MonthlyFee:' || f.id,
       f."createdAt" AT TIME ZONE 'UTC', f."updatedAt" AT TIME ZONE 'UTC'
FROM legacy_fee f;

INSERT INTO payment_item (payment_id, house_id, kind, period, fee_plan_id, amount, rw_submission_id)
SELECT p.id, h.id, 'MONTHLY_FEE', f.period, fp.id, f.amount, rs.id
FROM legacy_fee f
JOIN payment p ON p.legacy_ref = 'MonthlyFee:' || f.id
JOIN house h ON h.block = f.block AND h.number = f."houseNumber"
JOIN fee_plan fp ON fp.total_amount = f.amount
LEFT JOIN rw_submission rs ON rs.legacy_ref = 'RWSubmission:' || f."rwSubmissionId";

-- === Tarif per rumah, diturunkan dari riwayat nominal iuran ===
-- Baris pertama berlaku mulai 2025-12 (awal app dipakai); baris berikutnya di setiap bulan nominalnya berubah.
WITH seq AS (
  SELECT pi.house_id, pi.period, pi.fee_plan_id,
         lag(pi.fee_plan_id) OVER (PARTITION BY pi.house_id ORDER BY pi.period) AS prev_plan,
         row_number() OVER (PARTITION BY pi.house_id ORDER BY pi.period) AS rn
  FROM payment_item pi
  WHERE pi.kind = 'MONTHLY_FEE' AND pi.period >= '2025-12'
)
INSERT INTO house_fee_plan (house_id, start_period, fee_plan_id)
SELECT house_id, CASE WHEN rn = 1 THEN '2025-12' ELSE period END, fee_plan_id
FROM seq
WHERE rn = 1 OR fee_plan_id IS DISTINCT FROM prev_plan;

-- === THR: 1 Thr = 1 payment + 1 item kind THR, periode = tahun ===
INSERT INTO payment (payer_name, paid_at, method, reported_amount, proof_url, status,
                     ocr_attempts, ocr_error, notes, legacy_ref, created_at, updated_at)
SELECT t."fullName",
       (t."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jakarta')::date,
       'TRANSFER', t.amount, t."imageUrl",
       CASE trim(t.status) WHEN 'COMPLETED' THEN 'APPROVED' WHEN 'FAILED' THEN 'WAITING_MANUAL_INPUT' ELSE trim(t.status) END,
       t.attempt, t."errorMessage", t.notes,
       'Thr:' || t.id,
       t."createdAt" AT TIME ZONE 'UTC', t."updatedAt" AT TIME ZONE 'UTC'
FROM legacy."Thr" t;

INSERT INTO payment_item (payment_id, house_id, kind, period, amount)
SELECT p.id, h.id, 'THR', to_char(t.date, 'YYYY'), t.amount
FROM legacy."Thr" t
JOIN payment p ON p.legacy_ref = 'Thr:' || t.id
JOIN house h ON h.block = t.block AND h.number = t."houseNumber";

-- === Kas ===
INSERT INTO ledger_category (name, direction)
SELECT c.name, CASE tt.name WHEN 'income' THEN 'IN' ELSE 'OUT' END
FROM legacy."Category" c
JOIN legacy."TransactionType" tt ON tt.id = c."typeId";

INSERT INTO ledger_entry (entry_date, direction, amount, category_id, description, proof_url, status,
                          approved_by, approved_at, legacy_ref, created_at, updated_at)
SELECT (e.date AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jakarta')::date,
       CASE tt.name WHEN 'income' THEN 'IN' ELSE 'OUT' END,
       e.amount, lc.id, e.description, e."imageUrl", e.status,
       e."approvedBy", e."approvedAt" AT TIME ZONE 'UTC',
       'FinanceEntry:' || e.id,
       e."createdAt" AT TIME ZONE 'UTC', e."updatedAt" AT TIME ZONE 'UTC'
FROM legacy."FinanceEntry" e
JOIN legacy."Category" c ON c.id = e."categoryId"
JOIN legacy."TransactionType" tt ON tt.id = e."typeId"
JOIN ledger_category lc ON lc.name = c.name AND lc.direction = CASE tt.name WHEN 'income' THEN 'IN' ELSE 'OUT' END;

-- === Rekonsiliasi: batalkan semua kalau ada yang tidak cocok ===
DO $$
DECLARE
  diff int;
BEGIN
  -- setiap MonthlyFee (kecuali yang dikecualikan) ada tepat 1 item dengan nominal & periode sama
  SELECT count(*) INTO diff FROM (
    SELECT period, block, "houseNumber", amount FROM legacy_fee
    EXCEPT ALL
    SELECT pi.period, h.block, h.number, pi.amount
    FROM payment_item pi JOIN house h ON h.id = pi.house_id WHERE pi.kind = 'MONTHLY_FEE'
  ) d;
  IF diff <> 0 THEN RAISE EXCEPTION 'Rekonsiliasi iuran: % baris legacy tidak ada di v2', diff; END IF;

  IF (SELECT count(*) FROM payment_item WHERE kind = 'MONTHLY_FEE') <> (SELECT count(*) FROM legacy_fee) THEN
    RAISE EXCEPTION 'Rekonsiliasi iuran: jumlah item berbeda';
  END IF;

  IF (SELECT coalesce(sum(amount), 0) FROM payment_item WHERE kind = 'THR')
     <> (SELECT coalesce(sum(amount), 0) FROM legacy."Thr")
     OR (SELECT count(*) FROM payment_item WHERE kind = 'THR') <> (SELECT count(*) FROM legacy."Thr") THEN
    RAISE EXCEPTION 'Rekonsiliasi THR tidak cocok';
  END IF;

  IF (SELECT count(*) FROM house) <> (SELECT count(*) FROM legacy."Resident") THEN
    RAISE EXCEPTION 'Rekonsiliasi rumah tidak cocok';
  END IF;

  IF (SELECT sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END) FROM ledger_entry WHERE status = 'APPROVED')
     <> (SELECT sum(CASE tt.name WHEN 'income' THEN e.amount ELSE -e.amount END)
         FROM legacy."FinanceEntry" e JOIN legacy."TransactionType" tt ON tt.id = e."typeId"
         WHERE e.status = 'APPROVED') THEN
    RAISE EXCEPTION 'Rekonsiliasi saldo kas tidak cocok';
  END IF;

  SELECT count(*) INTO diff FROM (
    SELECT "rwSubmissionId" FROM legacy_fee WHERE "rwSubmissionId" IS NOT NULL
  ) l;
  IF diff <> (SELECT count(*) FROM payment_item WHERE rw_submission_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Rekonsiliasi setoran RW tidak cocok';
  END IF;

  IF EXISTS (SELECT 1 FROM house h WHERE NOT EXISTS (SELECT 1 FROM house_fee_plan hfp WHERE hfp.house_id = h.id)) THEN
    RAISE EXCEPTION 'Ada rumah tanpa tarif (house_fee_plan)';
  END IF;
END $$;

COMMIT;
