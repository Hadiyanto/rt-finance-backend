-- migrate:up

-- Setoran ke RW / yayasan sampah: setiap pemasukan iuran untuk pos ini otomatis diikuti pengeluaran
-- dengan nominal yang sama (uang hanya "titip lewat" kas RT). Hanya Kas + Agama RT yang tetap di kas RT.
INSERT INTO ledger_category (code, name, direction) VALUES
  ('SETOR_SAMPAH',      'Setoran: Sampah',                       'OUT'),
  ('SETOR_KEAMANAN_RW', 'Setoran: Keamanan + Agama RW + Kas RW', 'OUT'),
  ('SETOR_KKM_RW',      'Setoran: KKM RW',                       'OUT');

ALTER TABLE ledger_category ADD COLUMN payout_code text REFERENCES ledger_category (code);

UPDATE ledger_category c SET payout_code = m.payout
FROM (VALUES ('FEE_SAMPAH', 'SETOR_SAMPAH'), ('FEE_KEAMANAN_RW', 'SETOR_KEAMANAN_RW'), ('FEE_KKM_RW', 'SETOR_KKM_RW')) AS m (code, payout)
WHERE c.code = m.code;

-- migrate:down

ALTER TABLE ledger_category DROP COLUMN payout_code;
DELETE FROM ledger_category WHERE code IN ('SETOR_SAMPAH', 'SETOR_KEAMANAN_RW', 'SETOR_KKM_RW');
