-- Laporan perbandingan legacy vs v2 (read-only). Jalankan setelah scripts/migrate-legacy.sql:
--   psql "$DATABASE_URL" -f scripts/reconcile.sql
-- Pengecualian yang disengaja: docs/catatan-migrasi-data.md

\pset pager off

\echo '== Iuran per periode (legacy vs v2) =='
WITH l AS (
  SELECT to_char(date, 'YYYY-MM') AS period, count(*) AS n, sum(amount) AS total
  FROM legacy."MonthlyFee" GROUP BY 1
), v AS (
  -- v2 dipisah: berasal dari MonthlyFee vs koreksi (Koreksi:… / DeferredSubscription:…)
  SELECT pi.period,
         count(*) FILTER (WHERE p.legacy_ref LIKE 'MonthlyFee:%') AS n,
         sum(pi.amount) FILTER (WHERE p.legacy_ref LIKE 'MonthlyFee:%') AS total,
         count(*) FILTER (WHERE p.legacy_ref NOT LIKE 'MonthlyFee:%') AS koreksi_n,
         sum(pi.amount) FILTER (WHERE p.legacy_ref NOT LIKE 'MonthlyFee:%') AS koreksi_total
  FROM payment_item pi JOIN payment p ON p.id = pi.payment_id
  WHERE pi.kind = 'MONTHLY_FEE' AND pi.voided_at IS NULL GROUP BY 1
)
SELECT coalesce(l.period, v.period) AS period,
       l.n AS legacy_n, v.n AS v2_n, l.total AS legacy_total, v.total AS v2_total,
       nullif(v.koreksi_n, 0) AS koreksi_n, v.koreksi_total,
       CASE WHEN l.n IS NOT DISTINCT FROM nullif(v.n, 0) AND l.total IS NOT DISTINCT FROM v.total THEN 'OK'
            WHEN l.period = '2031-04' THEN 'DIKECUALIKAN'
            ELSE 'BEDA' END AS cek
FROM l FULL JOIN v ON v.period = l.period
ORDER BY 1;

\echo '== Koreksi migrasi =='
SELECT p.legacy_ref, h.block || '/' || h.number AS rumah,
       string_agg(pi.period, ' ' ORDER BY pi.period) AS periode, sum(pi.amount) AS total
FROM payment p
JOIN payment_item pi ON pi.payment_id = p.id
JOIN house h ON h.id = pi.house_id
WHERE p.legacy_ref NOT LIKE 'MonthlyFee:%' AND p.legacy_ref NOT LIKE 'Thr:%'
GROUP BY p.legacy_ref, h.block, h.number ORDER BY 2;

\echo '== THR per tahun =='
SELECT 'legacy' AS src, to_char(date, 'YYYY') AS tahun, count(*), sum(amount) FROM legacy."Thr" GROUP BY 2
UNION ALL
SELECT 'v2', period, count(*), sum(amount) FROM payment_item WHERE kind = 'THR' GROUP BY 2
ORDER BY 2, 1;

\echo '== Saldo kas (APPROVED) =='
SELECT 'legacy' AS src, sum(CASE tt.name WHEN 'income' THEN e.amount ELSE -e.amount END) AS saldo
FROM legacy."FinanceEntry" e JOIN legacy."TransactionType" tt ON tt.id = e."typeId" WHERE e.status = 'APPROVED'
UNION ALL
SELECT 'v2', sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END) FROM ledger_entry WHERE status = 'APPROVED';

\echo '== Setoran RW =='
SELECT rs.period, rs.total_amount, count(pi.id) AS items, sum(pi.amount) AS sum_items
FROM rw_submission rs LEFT JOIN payment_item pi ON pi.rw_submission_id = rs.id
GROUP BY rs.id ORDER BY 1;

\echo '== Tarif per rumah (house_fee_plan) =='
SELECT h.block || '/' || h.number AS rumah,
       string_agg(hfp.start_period || ' ' || coalesce(fp.code, 'TIDAK_DITAGIH'), ' → ' ORDER BY hfp.start_period) AS riwayat_tarif
FROM house h
JOIN house_fee_plan hfp ON hfp.house_id = h.id
LEFT JOIN fee_plan fp ON fp.id = hfp.fee_plan_id
GROUP BY h.id, h.block, h.number
HAVING count(*) > 1 OR bool_or(fp.code IS DISTINCT FROM 'IURAN_210')
ORDER BY h.block, h.number;

\echo '== Tunggakan per rumah (bulan berjalan tidak dihitung) =='
WITH months AS (
  SELECT to_char(d, 'YYYY-MM') AS period
  FROM generate_series(date '2025-12-01', date_trunc('month', now()) - interval '1 month', interval '1 month') d
), grid AS (
  SELECT h.id AS house_id, h.block, h.number, m.period,
         (SELECT hfp.fee_plan_id FROM house_fee_plan hfp
          WHERE hfp.house_id = h.id AND hfp.start_period <= m.period
          ORDER BY hfp.start_period DESC LIMIT 1) AS fee_plan_id
  FROM house h CROSS JOIN months m
)
SELECT g.block || '/' || g.number AS rumah,
       count(*) AS bulan_tunggak,
       sum(fp.total_amount) AS perkiraan,
       string_agg(g.period, ' ' ORDER BY g.period) AS bulan
FROM grid g
JOIN fee_plan fp ON fp.id = g.fee_plan_id
WHERE NOT EXISTS (
  SELECT 1 FROM v_house_period_status s WHERE s.house_id = g.house_id AND s.period = g.period
)
GROUP BY g.block, g.number
ORDER BY count(*) DESC, 1;
