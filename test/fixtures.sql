-- Data uji (fiktif) untuk test API publik.
--   A1/1  : IURAN_210 sejak 2025-12; 2026-01 sudah lunas; laporan 2026-02 ditolak (item di-void)
--   A1/2  : IURAN_210 sejak 2025-12, kosong mulai 2026-08 (KEAMANAN_100)
--   B1/12A: baru ditagih mulai 2026-03
--   A1/10 : untuk cek urutan nomor rumah (10 setelah 2)
--   user: bendahara@rt.test (bendahara), rt@rt.test (rt), nonaktif@rt.test (tidak aktif); password semua 'rahasia123'
--   kas: saldo awal 500.000 (APPROVED), pengeluaran 150.000 (APPROVED), pengeluaran 99.000 (PENDING)
TRUNCATE ledger_entry, ledger_category, payment_item, payment, house_fee_plan, house_occupancy, house, app_user
  RESTART IDENTITY CASCADE;

INSERT INTO ledger_category (id, name, direction) VALUES (1, 'Iuran Bulanan', 'IN'), (2, 'Operasional', 'OUT');
SELECT setval(pg_get_serial_sequence('ledger_category', 'id'), 2);

INSERT INTO app_user (id, name, email, password_hash, role, is_active) VALUES
  (1, 'Bendahara', 'bendahara@rt.test', '$2b$10$5MLj.tkPKg/xdOElz73oVOwKcX6TVAIGeUGtOMilbBxIss1Ux8YO.', 'bendahara', true),
  (2, 'Pak RT',    'rt@rt.test',        '$2b$10$5MLj.tkPKg/xdOElz73oVOwKcX6TVAIGeUGtOMilbBxIss1Ux8YO.', 'rt',        true),
  (3, 'Mantan',    'nonaktif@rt.test',  '$2b$10$5MLj.tkPKg/xdOElz73oVOwKcX6TVAIGeUGtOMilbBxIss1Ux8YO.', 'admin',     false);
SELECT setval(pg_get_serial_sequence('app_user', 'id'), 3);

INSERT INTO house (id, block, number) VALUES (1, 'A1', '1'), (2, 'A1', '2'), (3, 'B1', '12A'), (4, 'A1', '10');
SELECT setval(pg_get_serial_sequence('house', 'id'), 4);

INSERT INTO house_occupancy (house_id, start_period, status, resident_name, phone, occupancy_type) VALUES
  (1, '2025-12', 'OCCUPIED', 'Budi Santoso', '081200000001', 'OWNER'),
  (2, '2025-12', 'OCCUPIED', 'Budi Santoso', '081200000001', 'OWNER'),
  (2, '2026-08', 'VACANT',   'Budi Santoso', '081200000001', 'OWNER'),
  (3, '2026-03', 'OCCUPIED', 'Siti Rahma',   '081200000003', 'TENANT'),
  (4, '2025-12', 'OCCUPIED', 'Andi Wijaya',  NULL,           'OWNER');

INSERT INTO house_fee_plan (house_id, start_period, fee_plan_id)
SELECT v.house_id, v.start_period, fp.id
FROM (VALUES (1, '2025-12', 'IURAN_210'), (2, '2025-12', 'IURAN_210'), (2, '2026-08', 'KEAMANAN_100'),
             (3, '2026-03', 'IURAN_210'), (4, '2025-12', 'IURAN_186')) AS v (house_id, start_period, code)
JOIN fee_plan fp ON fp.code = v.code;

INSERT INTO payment (id, payer_name, reported_amount, status) VALUES
  (1, 'Budi Santoso', 210000, 'APPROVED'),
  (2, 'Budi Santoso', 210000, 'REJECTED');
SELECT setval(pg_get_serial_sequence('payment', 'id'), 2);

INSERT INTO payment_item (payment_id, house_id, kind, period, fee_plan_id, amount, voided_at)
SELECT v.payment_id, 1, 'MONTHLY_FEE', v.period, fp.id, 210000, v.voided_at
FROM (VALUES (1, '2026-01', NULL::timestamptz), (2, '2026-02', now())) AS v (payment_id, period, voided_at)
JOIN fee_plan fp ON fp.code = 'IURAN_210';

INSERT INTO ledger_entry (entry_date, direction, amount, category_id, description, status) VALUES
  ('2026-01-05', 'IN',  500000, 1, 'Kas Desember 2025', 'APPROVED'),
  ('2026-01-12', 'OUT', 150000, 2, 'Lampu jalan',       'APPROVED'),
  ('2026-02-01', 'OUT',  99000, 2, 'Belum disetujui',   'PENDING');
