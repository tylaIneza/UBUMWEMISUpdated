#!/usr/bin/env bash
# Full backup: database dump (schema, data, triggers) + uploaded documents.
#   ./scripts/backup.sh [output-dir]
# Reads DATABASE_URL and STORAGE_DIR from the environment or ./.env.
# Set MYSQLDUMP if mysqldump is not on PATH (XAMPP: /Applications/XAMPP/xamppfiles/bin/mysqldump).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set}"

OUT="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="${MYSQLDUMP:-$(command -v mysqldump || echo /Applications/XAMPP/xamppfiles/bin/mysqldump)}"
[ -x "$DUMP" ] || { echo "mysqldump not found; set MYSQLDUMP=/path/to/mysqldump" >&2; exit 1; }

# Split the URL with Node (already required by the app) so special characters in passwords are handled.
eval "$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log(`DB_HOST=${q(u.hostname)} DB_PORT=${q(u.port || 3306)} DB_USER=${q(decodeURIComponent(u.username))} DB_PASS=${q(decodeURIComponent(u.password))} DB_NAME=${q(u.pathname.slice(1))}`);
')"

mkdir -p "$OUT"
chmod 700 "$OUT"
SQL="$OUT/${DB_NAME}-${STAMP}.sql.gz"
# --single-transaction gives a consistent snapshot without locking staff out.
MYSQL_PWD="$DB_PASS" "$DUMP" --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
  --single-transaction --triggers --routines --hex-blob --default-character-set=utf8mb4 "$DB_NAME" | gzip > "$SQL"
[ "$(gzip -dc "$SQL" | head -c 200 | wc -c)" -gt 0 ] || { echo "The dump is empty — backup FAILED" >&2; exit 1; }
gzip -dc "$SQL" | tail -n 5 | grep -q "Dump completed" || { echo "The dump is incomplete — backup FAILED" >&2; exit 1; }
echo "database : $SQL ($(du -h "$SQL" | cut -f1))"

STORE="${STORAGE_DIR:-./storage}"
case "$STORE" in /*) ;; *) STORE="./server/${STORE#./}" ;; esac
if [ -d "$STORE" ]; then
  FILES="$OUT/documents-${STAMP}.tar.gz"
  tar -czf "$FILES" -C "$(dirname "$STORE")" "$(basename "$STORE")"
  echo "documents: $FILES ($(du -h "$FILES" | cut -f1))"
else
  echo "documents: no storage directory at $STORE (nothing uploaded yet)"
fi
chmod 600 "$OUT"/*"${STAMP}"*
echo "Backup complete. Copy these files to another machine or off-site storage."
