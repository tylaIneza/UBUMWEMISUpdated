# Rental Property Management System

Manages a property organization's buildings → floors → rooms → contracts → tenants → rent charges → payments → receipts,
with expenses, maintenance, EBM/invoice tracking, approvals, audit trail and reporting (screen, print, PDF, Excel).

- **Stack:** React + TypeScript (Vite) · Node.js + TypeScript (Express 5) · MariaDB 10.4+/MySQL 8 · Prisma · Zod · Vitest · Playwright
- **Docs:** [Architecture & design decisions](docs/ARCHITECTURE.md) · [Deployment, backup & restore](docs/DEPLOYMENT.md)

## Run it locally

Prerequisites: Node.js ≥ 22.18 and a running MariaDB/MySQL server (XAMPP's is fine).
LibreOffice is needed to download lease contracts as PDF (`brew install --cask libreoffice` on macOS,
`apt install libreoffice-writer` on Linux; set `SOFFICE_PATH` if it is not in a standard place). The contract
itself is the company's Word file, kept as `server/templates/contract-ubumwe.docx`; only its blanks are filled.

**Large portfolios (10,000+ tenants).** Tested with 15,000 tenants, 180,000 monthly rent charges and 165,000 payments.
Give MariaDB enough memory to keep the data cached: in XAMPP's `etc/my.cnf` set `innodb_buffer_pool_size=1G` (XAMPP ships
with 16M) and `max_allowed_packet=16M` under `[mysqld]`, then restart MySQL. Set `SLOW_QUERY_MS=300` to log any database
query slower than 300 ms.

```bash
npm install
cp .env.example .env            # then set DATABASE_URL, TEST_DATABASE_URL, SESSION_SECRET
npm run db:migrate              # create the tables, constraints and triggers
npm run db:seed                 # DEMO data (3 buildings, ~60 tenants, payments, expenses…)
npm run dev:server              # API on http://localhost:4000
npm run dev:web                 # web app on http://localhost:5173   (second terminal)
```

Create the two databases and a dedicated user first (as a database administrator):

```sql
CREATE DATABASE rpms      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE rpms_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'rpms_app'@'localhost' IDENTIFIED BY '<strong password>';
GRANT ALL PRIVILEGES ON rpms.* TO 'rpms_app'@'localhost';
GRANT ALL PRIVILEGES ON rpms_test.* TO 'rpms_app'@'localhost';
```

### Demo accounts (seed data only)

All use the password printed by the seed (`Demo@Pass2026` unless `SEED_PASSWORD` is set):
`admin@demo.rw` · `manager@demo.rw` · `accountant@demo.rw` · `cashier@demo.rw` · `staff@demo.rw` · `viewer@demo.rw`

The seed marks the organization as **demo**: a "DEMO DATA" banner appears on every screen, report and receipt. The seed
refuses to run in production and refuses to touch a database that holds non-demo data. For a real installation use
`npm run bootstrap -w server` instead (see the deployment guide).

## Commands

| Command | What it does |
|---|---|
| `npm run check` | typecheck + lint + all server tests + production build |
| `npm test` | 130 unit/integration tests against the `*_test` database (wiped on each run) |
| `npm run test:e2e` | 8 browser tests (desktop + phone) against the running demo app |
| `npm run db:migrate` | apply pending migrations |
| `npm run db:seed -- --reset` | wipe and re-create the DEMO data |
| `npm run build` / `npm start` | production build / run |
| `./scripts/backup.sh` / `./scripts/restore.sh` | database + documents backup / restore |

## Layout

```
server/prisma/        schema, migrations (incl. hand-written integrity rules), bootstrap, demo seed
server/src/services/  business logic — one module per domain (payments, charges, contracts, reports…)
server/src/routes/    REST API (validation + authorization, then calls a service)
server/tests/         unit, integration and acceptance tests
web/src/              React app (pages/, shared UI, API client)
e2e/                  Playwright tests
scripts/              backup and restore
```
