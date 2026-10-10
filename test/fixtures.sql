-- Data uji (fiktif) untuk test API publik.
--   A1/1  : IURAN_210 sejak 2025-12; 2026-01 sudah lunas; laporan 2026-02 ditolak (item di-void)
--   A1/2  : IURAN_210 sejak 2025-12, kosong mulai 2026-08 (KEAMANAN_100)
--   B1/12A: baru ditagih mulai 2026-03
--   A1/10 : untuk cek urutan nomor rumah (10 setelah 2)
TRUNCATE payment_item, payment, house_fee_plan, house_occupancy, house RESTART IDENTITY CASCADE;

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
