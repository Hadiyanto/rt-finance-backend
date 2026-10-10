#!/usr/bin/env bash
# Reset DB lokal dari backup produksi: data lama masuk ke schema `legacy`, schema `public` dikosongkan untuk skema v2.
# Pakai: scripts/db-reset-local.sh [path/ke/file.dump]   (default: dump terbaru di ~/backups/rt-finance)
set -euo pipefail

cd "$(dirname "$0")/.."

DUMP="${1:-$(ls -t ~/backups/rt-finance/*.dump | head -1)}"
LOCAL="${LOCAL_DATABASE_URL:-postgres://rt:rt@localhost:5433/rt_finance}"

case "$LOCAL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "Menolak: LOCAL_DATABASE_URL bukan localhost ($LOCAL)" >&2; exit 1 ;;
esac

echo "Dump : $DUMP"
echo "Target: $LOCAL"

docker compose -f docker-compose.dev.yml up -d --wait db

# dump dibuat dengan `-n public`, jadi berisi CREATE SCHEMA public sendiri
psql "$LOCAL" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA IF EXISTS legacy CASCADE; DROP SCHEMA IF EXISTS public CASCADE;'
# lewati RLS POLICY: policy Supabase memakai role (authenticated/anon) yang tidak ada di lokal
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
pg_restore -l "$DUMP" | grep -v ' POLICY ' > "$LIST"
pg_restore -d "$LOCAL" --no-owner --no-acl --exit-on-error -L "$LIST" "$DUMP"
psql "$LOCAL" -v ON_ERROR_STOP=1 -q -c 'ALTER SCHEMA public RENAME TO legacy; CREATE SCHEMA public;'

# skema v2 di public
docker compose -f docker-compose.dev.yml run --rm migrate

psql "$LOCAL" -At -F'|' -c "
  SELECT 'User', count(*) FROM legacy.\"User\"
  UNION ALL SELECT 'Resident', count(*) FROM legacy.\"Resident\"
  UNION ALL SELECT 'MonthlyFee', count(*) FROM legacy.\"MonthlyFee\"
  UNION ALL SELECT 'Thr', count(*) FROM legacy.\"Thr\"
  UNION ALL SELECT 'FinanceEntry', count(*) FROM legacy.\"FinanceEntry\"
  UNION ALL SELECT 'DeferredSubscription', count(*) FROM legacy.\"DeferredSubscription\"
  UNION ALL SELECT 'RWSubmission', count(*) FROM legacy.\"RWSubmission\"
  UNION ALL SELECT 'Category', count(*) FROM legacy.\"Category\"
  UNION ALL SELECT 'TransactionType', count(*) FROM legacy.\"TransactionType\";"
