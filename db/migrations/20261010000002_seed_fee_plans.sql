-- migrate:up

-- Tarif dari breakdownAmount() lama (routes/monthlyFee.js). Jumlah komponen = total_amount.
INSERT INTO fee_plan (code, name, total_amount) VALUES
  ('IURAN_210',    'Iuran penuh',                210000),
  ('IURAN_186',    'Iuran tanpa agama',          186000),
  ('KS_150',       'Keamanan + sampah 50rb',     150000),
  ('KS_140',       'Keamanan + sampah 40rb',     140000),
  ('KEAMANAN_100', 'Keamanan saja',              100000);

INSERT INTO fee_plan_component (fee_plan_id, component, amount)
SELECT fp.id, c.component, c.amount
FROM (VALUES
  ('IURAN_210', 'KAS_RT', 30000), ('IURAN_210', 'AGAMA_RT', 2400), ('IURAN_210', 'SAMPAH', 50000),
  ('IURAN_210', 'KEAMANAN', 97500), ('IURAN_210', 'AGAMA_RW', 21600), ('IURAN_210', 'KAS_RW', 3000),
  ('IURAN_210', 'KKM_RW', 5500),

  ('IURAN_186', 'KAS_RT', 30000), ('IURAN_186', 'SAMPAH', 50000), ('IURAN_186', 'KEAMANAN', 97500),
  ('IURAN_186', 'KAS_RW', 3000), ('IURAN_186', 'KKM_RW', 5500),

  ('KS_150', 'SAMPAH', 50000), ('KS_150', 'KEAMANAN', 100000),

  ('KS_140', 'SAMPAH', 40000), ('KS_140', 'KEAMANAN', 100000),

  ('KEAMANAN_100', 'KEAMANAN', 100000)
) AS c (code, component, amount)
JOIN fee_plan fp ON fp.code = c.code;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(code, ', ') INTO bad
  FROM (
    SELECT fp.code
    FROM fee_plan fp
    LEFT JOIN fee_plan_component c ON c.fee_plan_id = fp.id
    GROUP BY fp.id, fp.code, fp.total_amount
    HAVING fp.total_amount <> coalesce(sum(c.amount), 0)
  ) mismatched;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Komponen tarif tidak sama dengan total: %', bad;
  END IF;
END $$;

-- migrate:down

DELETE FROM fee_plan_component;
DELETE FROM fee_plan;
