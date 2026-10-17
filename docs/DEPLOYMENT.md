# Deployment, configuration, backup and restore

## Environments

Use a separate database, `.env` and `SESSION_SECRET` for each of **development**, **staging** and **production**
(`NODE_ENV`). Never copy production data into development without removing personal data, and never run the demo seed
or the test suite against production (both refuse to, but do not rely on that alone). `.env` is git-ignored; only
`.env.example` (names, no values) is committed.

## Requirements

- Node.js ≥ 22.18
- MariaDB ≥ 10.4 or MySQL ≥ 8.0 (a currently supported release is recommended), `utf8mb4`
- HTTPS in front of the application (reverse proxy such as nginx or Caddy). Session cookies are `Secure` in production.

## First installation

```bash
# 1. Database and a dedicated user (as a database administrator)
mysql -u root -p -e "CREATE DATABASE rpms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'rpms_app'@'localhost' IDENTIFIED BY '<strong password>';
  GRANT ALL PRIVILEGES ON rpms.* TO 'rpms_app'@'localhost';"

# 2. Code and configuration
npm ci
cp .env.example .env     # set NODE_ENV=production, DATABASE_URL, SESSION_SECRET, APP_URL, STORAGE_DIR,
                         # WEB_DIST=../web/dist, TRUST_PROXY=1 (behind a proxy)

# 3. Schema
npm run db:migrate
npm run migrate:status -w server      # must say "Database schema is up to date!"

# 4. Organization and first administrator (idempotent; do NOT run the demo seed)
ORG_NAME="Your Company Ltd" ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<strong password>' ADMIN_NAME="Your Name" \
  npm run bootstrap -w server

# 5. Build and start
npm run build
npm start                              # serves the API and the web app on PORT
```

Then sign in, complete **Settings** (organization details, due day, grace period, numbering prefixes), register
buildings/floors/rooms or use **Settings → Import data**, and create the staff accounts.

Keep the process running with a supervisor (systemd, pm2, or the platform's own). Run **one** instance (it hosts the
hourly billing/status job).

### Environment variables

| Name | Required | Purpose |
|---|---|---|
| `NODE_ENV` | yes | `development`, `staging` or `production` |
| `DATABASE_URL` | yes | `mysql://user:password@host:3306/database` |
| `SESSION_SECRET` | yes | ≥ 32 random characters, unique per environment |
| `APP_URL` | yes | public URL of the web app (used in e-mailed/issued links) |
| `PORT` | no | default 4000 |
| `STORAGE_DIR` | yes | private directory for uploaded documents (not web-served; backed up) |
| `WEB_DIST` | prod | path of the built web app, e.g. `../web/dist` |
| `TRUST_PROXY` | prod | number of proxies in front (usually 1) |
| `SESSION_TTL_HOURS`, `MAX_UPLOAD_MB`, `LOG_LEVEL` | no | defaults 12, 10, `info` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | enables real e-mail delivery **and the login one-time code (OTP)** |
| `SMS_PROVIDER`, `SMS_USERNAME`, `SMS_API_KEY`, `SMS_SENDER_ID` | no | real SMS for tenant reminders (`africastalking` or `pindo`) |
| `TEST_DATABASE_URL` | dev only | database for automated tests; name must end in `_test` |
| `DISABLE_SCHEDULER`, `DISABLE_RATE_LIMIT` | no | operational switches (`true`/`false`) |

## Upgrading

```bash
./scripts/backup.sh                    # always back up first
git pull && npm ci
npm run db:migrate                     # applies only new migrations
npm run build && <restart the service>
curl -fsS https://your-host/health     # {"status":"ok","database":"ok",…}
```

Migrations are forward-only SQL files. To undo a release, restore the backup taken before it.

## Health check and logs

- `GET /health` → `200 {"status":"ok","database":"ok"}`, or `503` if the database cannot be reached. Point the load
  balancer / uptime monitor at it.
- The server writes structured JSON logs to stdout (requests, sign-ins, payments, reversals, job results, errors).
  Passwords, cookies and tokens are redacted. Collect stdout with your process manager.

## Backup

The system of record is **the database plus the document storage directory**. Both must be backed up; neither can be
recreated from the web application.

```bash
./scripts/backup.sh /path/to/backups   # → <db>-<timestamp>.sql.gz and documents-<timestamp>.tar.gz
```

- The dump is a consistent snapshot (`--single-transaction`) and includes triggers and constraints; the script fails
  if the dump is empty or incomplete.
- Schedule it at least daily (cron example: `15 1 * * * cd /opt/rpms && ./scripts/backup.sh /var/backups/rpms`).
- Copy the files **off the server** (another machine or cloud storage) and keep several generations
  (e.g. 14 daily, 12 monthly). Protect them like the database itself: they contain personal and financial data.
- If `mysqldump` is not on `PATH`, set `MYSQLDUMP=/path/to/mysqldump` (XAMPP:
  `/Applications/XAMPP/xamppfiles/bin/mysqldump`).

## Restore

```bash
<stop the application>
./scripts/restore.sh backups/rpms-YYYYMMDD-HHMMSS.sql.gz backups/documents-YYYYMMDD-HHMMSS.tar.gz
npm run migrate:status -w server       # must report the schema is up to date (or run db:migrate)
<start the application>;  curl -fsS http://localhost:4000/health
```

The script replaces the database named in `DATABASE_URL` and asks you to type its name first. **Rehearse a restore
into a spare database every few months** — an untested backup is not a backup:

```bash
DATABASE_URL=mysql://rpms_app:DB_PASSWORD@127.0.0.1:3306/rpms_restore_test ./scripts/restore.sh backups/<file>.sql.gz
```

## Importing existing records

Settings → Import data → download the Excel template, fill the sheets (Buildings, Floors, Rooms, Tenants, Contracts),
upload, review the preview, confirm. Rows that already exist are skipped; if any row has an error nothing is imported.
For contracts, `billFrom` is the first month this system should bill and `openingBalance` is unpaid rent carried over
from before that month.

## Going live checklist

- [ ] HTTPS enabled; `NODE_ENV=production`; unique `SESSION_SECRET`; `TRUST_PROXY` set
- [ ] Database user has rights on the application database only
- [ ] Demo seed **not** run; organization created with `bootstrap`; no "DEMO DATA" banner
- [ ] Daily backup scheduled, copied off the server, and one restore rehearsed
- [ ] `/health` monitored
- [ ] Staff accounts created with the right roles; the first administrator's password changed
- [ ] Organization settings, payment methods and expense categories reviewed
