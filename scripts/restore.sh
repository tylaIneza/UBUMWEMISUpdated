#!/usr/bin/env bash
# Restore a backup made by backup.sh INTO THE DATABASE NAMED IN DATABASE_URL.
#   ./scripts/restore.sh backups/rpms-YYYYMMDD-HHMMSS.sql.gz [backups/documents-YYYYMMDD-HHMMSS.tar.gz]
# This REPLACES the contents of that database. Stop the application first.
set -euo pipefail
cd "$(dirname "$0")/.."
SQL="${1:?usage: restore.sh <database dump .sql.gz> [documents .tar.gz]}"
FILES="${2:-}"
[ -f "$SQL" ] || { echo "No such file: $SQL" >&2; exit 1; }
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
CLIENT="${MYSQL:-$(command -v mysql || echo /Applications/XAMPP/xamppfiles/bin/mysql)}"
[ -x "$CLIENT" ] || { echo "mysql client not found; set MYSQL=/path/to/mysql" >&2; exit 1; }

eval "$(node -e '
  const u = new URL(process.env.DATABASE_URL);
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log(`DB_HOST=${q(u.hostname)} DB_PORT=${q(u.port || 3306)} DB_USER=${q(decodeURIComponent(u.username))} DB_PASS=${q(decodeURIComponent(u.password))} DB_NAME=${q(u.pathname.slice(1))}`);
')"

echo "This will REPLACE every table in database \"$DB_NAME\" on $DB_HOST with the contents of $SQL."
if [ "${RESTORE_CONFIRM:-}" != "$DB_NAME" ]; then
  printf 'Type the database name to continue: '
  read -r ANSWER
  [ "$ANSWER" = "$DB_NAME" ] || { echo "Cancelled."; exit 1; }
fi
run() { MYSQL_PWD="$DB_PASS" "$CLIENT" --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --default-character-set=utf8mb4 "$@"; }
run -e "DROP DATABASE \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
gzip -dc "$SQL" | run "$DB_NAME"
echo "Database restored: $(run -N -e "SELECT CONCAT(COUNT(*), ' payments, ') FROM \`$DB_NAME\`.payments; SELECT CONCAT(COUNT(*), ' audit entries') FROM \`$DB_NAME\`.audit_logs;" | tr -d '\n')"

if [ -n "$FILES" ]; then
  STORE="${STORAGE_DIR:-./storage}"
  case "$STORE" in /*) ;; *) STORE="./server/${STORE#./}" ;; esac
  mkdir -p "$(dirname "$STORE")"
  tar -xzf "$FILES" -C "$(dirname "$STORE")"
  echo "Documents restored to $STORE"
fi
echo "Now run:  npm run migrate:status -w server   (it must report the schema is up to date)"
