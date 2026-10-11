-- migrate:up

-- Snapshot iuran → kas: iuran sebulan (laporan yang sudah disetujui) dicatat sebagai pemasukan kas,
-- dipisah per pos seperti rekap di /report-iuran.

-- Kategori sistem punya code; tidak boleh dipakai untuk input manual.
ALTER TABLE ledger_category ADD COLUMN code text UNIQUE;

INSERT INTO ledger_category (code, name, direction) VALUES
  ('FEE_KAS_RT',      'Iuran: Kas + Agama RT',               'IN'),
  ('FEE_SAMPAH',      'Iuran: Sampah',                       'IN'),
  ('FEE_KEAMANAN_RW', 'Iuran: Keamanan + Agama RW + Kas RW', 'IN'),
  ('FEE_KKM_RW',      'Iuran: KKM RW',                       'IN');

-- Komponen tarif → pos kas
CREATE TABLE fee_ledger_mapping (
  component     text PRIMARY KEY CHECK (component IN ('KAS_RT', 'AGAMA_RT', 'SAMPAH', 'KEAMANAN', 'AGAMA_RW', 'KAS_RW', 'KKM_RW')),
  category_code text NOT NULL REFERENCES ledger_category (code)
);
INSERT INTO fee_ledger_mapping VALUES
  ('KAS_RT',   'FEE_KAS_RT'),
  ('AGAMA_RT', 'FEE_KAS_RT'),
  ('SAMPAH',   'FEE_SAMPAH'),
  ('KEAMANAN', 'FEE_KEAMANAN_RW'),
  ('AGAMA_RW', 'FEE_KEAMANAN_RW'),
  ('KAS_RW',   'FEE_KEAMANAN_RW'),
  ('KKM_RW',   'FEE_KKM_RW');

-- Periode iuran yang diwakili entri kas (snapshot, atau entri iuran manual lama yang akan diganti snapshot)
ALTER TABLE ledger_entry ADD COLUMN fee_period period_month;

-- VOID = entri lama yang digantikan snapshot (tetap disimpan untuk riwayat, tidak dihitung saldo)
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_status_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_status_check
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'VOID'));

ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_ref_type_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_ref_type_check
  CHECK (ref_type IN ('PAYMENT', 'RW_SUBMISSION', 'FEE_SNAPSHOT', 'LEGACY_FEE_INCOME'));

ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_fee_period_check
  CHECK ((ref_type IN ('FEE_SNAPSHOT', 'LEGACY_FEE_INCOME')) = (fee_period IS NOT NULL));

CREATE INDEX ledger_entry_fee_period_idx ON ledger_entry (fee_period) WHERE fee_period IS NOT NULL;

-- migrate:down

DROP INDEX ledger_entry_fee_period_idx;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_fee_period_check;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_ref_type_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_ref_type_check CHECK (ref_type IN ('PAYMENT', 'RW_SUBMISSION'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_status_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE ledger_entry DROP COLUMN fee_period;
DROP TABLE fee_ledger_mapping;
DELETE FROM ledger_category WHERE code IS NOT NULL;
ALTER TABLE ledger_category DROP COLUMN code;
