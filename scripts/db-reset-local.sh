#!/usr/bin/env bash
# Reset DB lokal ke kondisi siap pakai dari backup produksi:
#   1. data lama → schema `legacy`
#   2. skema v2 (dbmate) → schema `public`
#   3. migrasi data legacy → v2 (scripts/migrate-legacy.sql, termasuk koreksi bendahara)
#   4. akun admin khusus lokal: dev@local.test / rahasia123
# Pakai: scripts/db-reset-local.sh [path/ke/file.dump]   (default: dump terbaru di ~/backups/rt-finance)
#        SKIP_LEGACY_MIGRATION=1 scripts/db-reset-local.sh   → berhenti setelah langkah 2 (public kosong)
set -euo pipefail

cd "$(dirname "$0")/.."

DUMP="${1:-$(ls -t ~/backups/rt-finance/*.dump | head -1)}"
LOCAL="${LOCAL_DATABASE_URL:-postgres://rt:rt@localhost:5433/rt_finance}"

case "$LOCAL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "Menolak: LOCAL_DATABASE_URL bukan localhost ($LOCAL)" >&2; exit 1 ;;
esac

echo "Dump  : $DUMP"
echo "Target: $LOCAL"

docker compose -f docker-compose.dev.yml up -d --wait db

# putuskan koneksi lain (mis. backend yang sedang jalan) supaya DROP SCHEMA tidak tertahan
psql "$LOCAL" -q -At -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                         WHERE datname = current_database() AND pid <> pg_backend_pid()" > /dev/null

# 1. dump dibuat dengan `-n public`, jadi berisi CREATE SCHEMA public sendiri
psql "$LOCAL" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS legacy CASCADE; DROP SCHEMA IF EXISTS public CASCADE;' 2> /dev/null
# lewati RLS POLICY: policy Supabase memakai role (authenticated/anon) yang tidak ada di lokal
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
pg_restore -l "$DUMP" | grep -v ' POLICY ' > "$LIST"
pg_restore -d "$LOCAL" --no-owner --no-acl --exit-on-error -L "$LIST" "$DUMP"
psql "$LOCAL" -v ON_ERROR_STOP=1 -q -c 'ALTER SCHEMA public RENAME TO legacy; CREATE SCHEMA public;'
echo "✓ backup dipulihkan ke schema legacy"

# 2. skema v2 di public
docker compose -f docker-compose.dev.yml run --rm migrate 2>&1 | grep -E 'Applied|Error' || true
echo "✓ skema v2"

if [ "${SKIP_LEGACY_MIGRATION:-0}" = "1" ]; then
  exit 0
fi

# 3. data legacy → v2 (gagal & batal otomatis kalau rekonsiliasi tidak cocok)
psql "$LOCAL" -v ON_ERROR_STOP=1 -q -f scripts/migrate-legacy.sql > /dev/null
echo "✓ data lama dimigrasi"

# 4. admin lokal (hash bcrypt untuk 'rahasia123'); hanya untuk development
psql "$LOCAL" -v ON_ERROR_STOP=1 -q -c "
  INSERT INTO app_user (name, email, password_hash, role)
  VALUES ('Dev Lokal', 'dev@local.test', '\$2b\$10\$5MLj.tkPKg/xdOElz73oVOwKcX6TVAIGeUGtOMilbBxIss1Ux8YO.', 'bendahara')
  ON CONFLICT (email) DO NOTHING"
echo "✓ admin lokal: dev@local.test / rahasia123"

psql "$LOCAL" -At -F' | ' -c "
  SELECT 'rumah', count(*) FROM house
  UNION ALL SELECT 'laporan iuran/THR', count(*) FROM payment
  UNION ALL SELECT 'item rumah×bulan', count(*) FROM payment_item
  UNION ALL SELECT 'transaksi kas', count(*) FROM ledger_entry
  UNION ALL SELECT 'saldo kas', sum(CASE direction WHEN 'IN' THEN amount ELSE -amount END) FROM ledger_entry WHERE status = 'APPROVED'
  UNION ALL SELECT 'user', count(*) FROM app_user"
