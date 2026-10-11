-- migrate:up

-- Snapshot THR → kas: THR yang disetujui untuk satu tahun dicatat sebagai pemasukan, lalu otomatis
-- diikuti setoran THR ke RW dengan nominal yang sama (saldo kas RT tidak berubah).
INSERT INTO ledger_category (code, name, direction) VALUES
  ('SETOR_THR', 'Setoran THR', 'OUT'),
  ('THR_IN',    'THR',         'IN')
ON CONFLICT (name, direction) DO UPDATE SET code = EXCLUDED.code;

UPDATE ledger_category SET payout_code = 'SETOR_THR' WHERE code = 'THR_IN';

ALTER TABLE ledger_entry ADD COLUMN thr_year int CHECK (thr_year BETWEEN 2020 AND 2100);

ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_ref_type_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_ref_type_check
  CHECK (ref_type IN ('PAYMENT', 'RW_SUBMISSION', 'FEE_SNAPSHOT', 'LEGACY_FEE_INCOME', 'THR_SNAPSHOT'));

ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_thr_year_check2
  CHECK ((ref_type = 'THR_SNAPSHOT') = (thr_year IS NOT NULL));

-- migrate:down

ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_thr_year_check2;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_ref_type_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_ref_type_check
  CHECK (ref_type IN ('PAYMENT', 'RW_SUBMISSION', 'FEE_SNAPSHOT', 'LEGACY_FEE_INCOME'));
ALTER TABLE ledger_entry DROP COLUMN thr_year;
UPDATE ledger_category SET payout_code = NULL WHERE code = 'THR_IN';
DELETE FROM ledger_category WHERE code IN ('THR_IN', 'SETOR_THR');
