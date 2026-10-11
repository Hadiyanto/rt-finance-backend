-- Seed kas dari rekap rekening koran Jan–Sep 2026 (rekening RT …6181).
-- Rincian & keputusan: docs/rekap-pengeluaran-2026.md
--
-- Semua entri baru berstatus PENDING: direview & di-approve bendahara di /pengeluaran setelah dicocokkan
-- dengan rekening. Setoran iuran ke RW / KKM / yayasan sampah TIDAK ada di sini (sudah tercatat otomatis
-- lewat snapshot iuran). Aman dijalankan ulang (setiap entri ditandai legacy_ref 'Rekap2026:<kode>').
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/seed-ledger-rekap-2026.sql

\set ON_ERROR_STOP on
BEGIN;

-- kategori manual tambahan
INSERT INTO ledger_category (name, direction) VALUES
  ('THR', 'IN'),
  ('Setoran THR', 'OUT'),
  ('Kegiatan RW', 'OUT')
ON CONFLICT (name, direction) DO NOTHING;

WITH seed (ref, entry_date, direction, amount, category, description) AS (VALUES
  -- biaya bank per bulan: administrasi, BI-FAST, ATM Prima, PPh atas bunga
  ('Rekap2026:bank-2026-01', DATE '2026-01-31', 'OUT',   21500, 'Administrasi', 'Biaya bank Januari 2026 (admin, BI-FAST, ATM)'),
  ('Rekap2026:bank-2026-02', DATE '2026-02-28', 'OUT',   15000, 'Administrasi', 'Biaya bank Februari 2026 (admin, BI-FAST)'),
  ('Rekap2026:bank-2026-03', DATE '2026-03-31', 'OUT',   15773, 'Administrasi', 'Biaya bank Maret 2026 (admin, BI-FAST, PPh bunga)'),
  ('Rekap2026:bank-2026-04', DATE '2026-04-30', 'OUT',   13159, 'Administrasi', 'Biaya bank April 2026 (admin, BI-FAST, PPh bunga)'),
  ('Rekap2026:bank-2026-05', DATE '2026-05-31', 'OUT',   17218, 'Administrasi', 'Biaya bank Mei 2026 (admin, ATM, PPh bunga)'),
  ('Rekap2026:bank-2026-06', DATE '2026-06-30', 'OUT',   23791, 'Administrasi', 'Biaya bank Juni 2026 (admin, ATM, PPh bunga)'),
  ('Rekap2026:bank-2026-07', DATE '2026-07-31', 'OUT',   19737, 'Administrasi', 'Biaya bank Juli 2026 (admin, BI-FAST, ATM, PPh bunga)'),
  ('Rekap2026:bank-2026-08', DATE '2026-08-31', 'OUT',   21941, 'Administrasi', 'Biaya bank Agustus 2026 (admin, BI-FAST, ATM, PPh bunga)'),
  ('Rekap2026:bank-2026-09', DATE '2026-09-30', 'OUT',   23279, 'Administrasi', 'Biaya bank September 2026 (admin, ATM, PPh bunga)'),

  -- THR: diterima dari warga lalu diteruskan ke RW (saldo tetap)
  ('Rekap2026:thr-in',       DATE '2026-03-10', 'IN',  8062000, 'THR',          'THR 2026 dari warga (47 rumah)'),
  ('Rekap2026:thr-out',      DATE '2026-03-10', 'OUT', 8062000, 'Setoran THR',  'Setoran THR 2026 ke RW 016'),

  -- pengeluaran RT yang belum ada di kas
  ('Rekap2026:rw-2026-07-06', DATE '2026-07-06', 'OUT', 2000000, 'Kegiatan RW',  'Kegiatan RW (transfer ke RW 016)'),
  ('Rekap2026:rw-2026-08-04', DATE '2026-08-04', 'OUT', 1000000, 'Kegiatan RW',  'Kegiatan RW (transfer ke RW 016)'),
  ('Rekap2026:lampu-2026-08', DATE '2026-08-02', 'OUT',  550000, 'Operasional',  'Pembelian lampu'),
  ('Rekap2026:17an-2026',     DATE '2026-08-17', 'OUT',  405000, 'Sosial',       '17 Agustus 2026'),
  ('Rekap2026:kasih-2026-09', DATE '2026-09-22', 'OUT',  400000, 'Sosial',       'Tanda kasih')
)
INSERT INTO ledger_entry (entry_date, direction, amount, category_id, description, status, legacy_ref)
SELECT s.entry_date, s.direction, s.amount, c.id, s.description, 'PENDING', s.ref
FROM seed s
JOIN ledger_category c ON c.name = s.category AND c.direction = s.direction AND c.code IS NULL
WHERE NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.legacy_ref = s.ref);

-- koreksi tanggal: "Tanda Kasih B1/11" terlambat diinput; tanggal sebenarnya sesuai rekening koran
UPDATE ledger_entry SET entry_date = DATE '2026-07-20'
WHERE legacy_ref = 'FinanceEntry:12' AND entry_date <> DATE '2026-07-20';

DO $$
BEGIN
  IF (SELECT count(*) FROM ledger_entry WHERE legacy_ref LIKE 'Rekap2026:%') <> 16 THEN
    RAISE EXCEPTION 'Seed rekap 2026 tidak lengkap (kategori tidak ditemukan?)';
  END IF;
END $$;

COMMIT;
