# Architecture and design decisions

## 1. Starting point (audit)

The repository was empty: no code, database, routes or authentication existed, so there was nothing to preserve or
migrate. The database engine was chosen by the owner: the MySQL-compatible **MariaDB 10.4** bundled with XAMPP.
Everything below was built for that engine and also runs on MySQL 8.

## 2. Shape of the system

```
Browser (React SPA) ──HTTPS──▶ Express API ──▶ services (business rules, transactions) ──▶ MariaDB
        session cookie + CSRF header        │                                              ▲
                                            └─ private file storage (documents)            │
                                  hourly scheduler (billing, statuses, notifications) ─────┘
```

- **One deployable**: the API server also serves the built web app in production.
- **Layers**: `routes/` validate input (Zod) and check permission, then call a `services/` function. Services own
  every rule and every transaction; they never trust the caller. The web app contains no business rules — it asks the
  server (e.g. the payment allocation preview is computed by the server).
- **Money** is `DECIMAL(14,2)` in the database and exact decimals (`Prisma.Decimal`) in code. No floating point is
  used for any financial calculation. The API transfers amounts as strings.
- **Dates**: contract dates, billing periods and due dates are date-only. "Today" and the business day of a payment
  are taken in the organization's time zone (Africa/Kigali) and stored (`payments.businessDate`) so reports never
  depend on server time zone.

## 3. Database

Normalized relational schema (`server/prisma/schema.prisma`), 34 tables:

| Area | Tables |
|---|---|
| Organization & access | organizations, users, roles, permissions, role_permissions, user_roles, sessions, auth_tokens, sequences |
| Property | buildings, floors, rooms, room_rent_rates, reservations |
| Tenancy | tenants, contracts, contract_rent_rates, rent_adjustments |
| Rent ledger | rent_charges, payments, payment_allocations, receipts, invoices, deposit_transactions, accounting_periods, approval_requests, payment_methods |
| Operations | expenses, expense_categories, maintenance_requests |
| Cross-cutting | documents, notifications, message_logs, audit_logs |

Nothing is hard-coded to three buildings: buildings, floors and rooms are rows.

### Rules enforced by the database itself

These hold even if application code is bypassed (verified by tests that write directly to the database):

| Rule | Mechanism (`migrations/…_integrity_rules`) |
|---|---|
| A room has at most one occupying contract | unique index on a generated column (`occupyingRoomId`) |
| Contract periods for a room never overlap | trigger |
| One live rent charge per contract per month | unique index on generated column |
| `balance = due − paid − waived`; a PAID charge has zero balance; a PARTIAL one has paid > 0 and balance > 0 | CHECK constraints |
| `payment.amount = allocated + unallocated`; payments positive, reversals negative | CHECK constraints |
| Payments, allocations, receipts, deposit transactions, audit log: no UPDATE of financial fields, no DELETE | triggers |
| No payment dated inside a closed accounting period | trigger |
| Rent-rate history: no overlap, no editing closed rates, no deletion | triggers + unique index |
| A transaction reference is used once per payment method | unique index on generated column |
| Room/floor belong to the same building; expense scope matches its location | composite foreign key, CHECK |
| Users owning transactions cannot be hard-deleted | `ON DELETE RESTRICT` everywhere (users are soft-deleted) |

MariaDB has no partial indexes or exclusion constraints; generated-column unique indexes and triggers provide the
same guarantees.

### Migrations

`prisma migrate deploy` applies the SQL in `server/prisma/migrations`. The second migration is hand-written (constraints,
generated columns, triggers) — **when adding a migration, generate SQL with `prisma migrate diff`, review it, and make
sure it does not drop those objects** (Prisma does not know about them).

## 4. Financial model

- **Rent charges** – one row per contract per calendar month (`rent_charges`). Generated when a contract is activated,
  by the hourly job, and on demand ("Run billing now"); generation is idempotent.
- **Payments** – `payments` + `payment_allocations` say exactly which month(s) each payment covers. Allocation rule:
  oldest unpaid month first.
- **Recording a payment** is one transaction: lock the contract → plan allocation → payment → allocations → charge
  balances/status → receipt (gap-free number) → invoice (EBM pending) → audit log. Any failure rolls back everything.
- **Overpayment** is never silently accepted. The server answers `409 OVERPAYMENT` with the excess; the user can
  cancel, pay only what is outstanding, or (if authorised) record the excess as an **advance**, which is allocated to
  the following months of the contract. Anything that cannot be matched to a month stays on the payment as visible
  *advance credit* and is applied automatically when the next charge is created.
- **Duplicate protection** – every payment carries a client-generated idempotency key (unique per organization). A
  retry or double-click returns the original payment. Concurrent requests are serialised by a row lock on the contract.
- **Corrections** – payments are immutable. A reversal posts a negative `REVERSAL` row plus negative allocations,
  marks the original `REVERSED`, voids the receipt and cancels the invoice. Reversals, rent discounts/surcharges, debt
  waivers and deposit refunds go through the **approval workflow** (`approval_requests`); a user holding
  `approval.decide` approves by submitting.
- **Rent history** – room rent (`room_rent_rates`) and contractual rent (`contract_rent_rates`) are versioned; a change
  closes the open rate and opens a new one. Billed months are never re-priced by a rent change.
- **Security deposits** live in their own append-only ledger and are never included in rental income.
- **Accounting periods** – a closed month accepts no new payments or expenses; corrections are posted in an open month.
- **Reconciliation** – six automated checks (charges = allocations, payments = allocations, status = balance, room
  status = contracts, building = Σ rooms, consolidated = Σ buildings) run on the dashboard and on every financial
  report; a failure is printed as a warning.

### Decisions made where the specification was silent

| Topic | Decision |
|---|---|
| Partial months | A partial first/last calendar month is billed pro rata by days (setting, on by default). A room that changes tenant mid-month is therefore never billed two full months. An early move-out does not reduce that month's charge. |
| "Collected" vs "cash received" | *Collected* = payments applied to the months being reported (so Expected − Collected − Waived = Outstanding). *Cash received* = all money received in the date range, including arrears and advances. Net income = Collected − approved Expenses. Both are shown. |
| Overdue | A charge is overdue when its balance > 0 and today is after due date + grace period. A partly-paid overdue month is shown as "Partial · overdue". |
| Expired contracts | After its end date a contract becomes EXPIRED, still occupies the room, and is **not billed further**; it raises an alert until renewed or terminated. |
| New contract after move-out | May start the day after the previous tenant's move-out date. |
| Move-out with pre-paid months | Later months are voided and the money already applied to them is released as credit on the payment (visible on the contract; refund or reverse it). |
| Renewal | Old contract → RENEWED, new contract starts the next day; the deposit is transferred to it. Unused advance credit stays visible on the old contract. |
| Verification | A payment must be verified by someone other than the person who recorded it. |
| Expenses | Count in reports only when APPROVED. Organization-wide expenses appear as their own row in the consolidated report and not in building reports. |
| First password | Administrator sets it; the user must change it at first sign-in. |
| E-mail | Only sent if SMTP is configured. Otherwise reset/verification links are shown to the administrator to hand over, and the app says so. |

## 5. Security

- Passwords: scrypt (N=2¹⁷) with per-password salt; policy of ≥8 chars with mixed case and a digit; lock-out after 5
  failures; identical response for unknown user and wrong password.
- Login one-time code (OTP): when e-mail (SMTP) is configured, a correct password does **not** open a session. A random
  4-digit code is e-mailed and stored only as a salted hash bound to its challenge; it expires after 5 minutes, allows 5
  wrong guesses, can be resent 3 times (30 s apart) and works once. The session is created by `/auth/otp/verify`. If the
  code cannot be e-mailed the login fails (nothing is signed in). Without SMTP there is no way to deliver a code, so the
  step is skipped and the password alone signs in — configure SMTP to turn the second factor on.
- Sessions: opaque random token in an `HttpOnly`, `SameSite=Lax` (and `Secure` in production) cookie; only its SHA-256
  is stored; server-side expiry and revocation; password change/reset signs out other sessions.
- CSRF: every state-changing request must carry the session's CSRF token in a header; non-JSON bodies are refused.
- Authorization: 44 permissions, checked on the server for every route (`requirePermission`) and again inside
  services for finer rules (e.g. advance payments, rent overrides). Permission changes apply immediately.
- Input: all input validated with Zod; all SQL parameterised (Prisma / tagged templates); React escapes output;
  Content-Security-Policy and other headers via helmet; rate limiting on sign-in and on the API as a whole.
- Uploads: 10 MB limit, extension allow-list **and** content signature check, random stored names outside any web
  root, download only through an authorised endpoint with `Content-Disposition: attachment`.
- Audit: logins, failures, every create/change/approval/reversal/report, with user, old/new values, time, IP, device.
  The audit table is append-only at database level.
- Secrets come only from environment variables; logs redact cookies, tokens and passwords.

## 6. Roles

| Role | Can |
|---|---|
| Super Admin | Everything, including users, roles and settings |
| Management | Property, tenants, contracts, payments (incl. advance), expenses + approval, approvals, reports, exports, periods, import, audit log |
| Accountant | Payments (incl. advance), verification, deposits, invoices/EBM, expenses (record), reports, exports; requests need approval |
| Cashier | Record payments, receipts, EBM references, request reversals; no reports, expenses or rent configuration |
| Property Staff | Rooms, reservations, tenants, contracts, maintenance, occupancy reports; no payments or financial reports |
| Viewer | Read-only dashboards and reports |

Role permissions are editable (Users → Roles & permissions); custom roles can be created through the API.

## 7. API

REST under `/api/v1` (JSON; cookie session). Errors are `{ "error": { code, message, details } }` with a message
written for the user. Main resources: `auth` (+`/otp/verify`, `/otp/resend`), `meta`, `dashboard`, `search`, `buildings`, `floors`, `rooms`
(+`/map`, `/:id/rent`), `reservations`, `tenants`, `contracts` (+`/activate`, `/terminate`, `/renew`, `/rent`,
`/adjustments`, `/deposits`), `rent/charges`, `rent/generate`, `payments` (+`/preview`, `/:id/verify`,
`/:id/reverse`, `/:id/receipt.pdf`), `invoices`, `deposits`, `expenses` (+`/decision`), `maintenance`, `approvals`,
`periods`, `documents`, `messages`, `notifications`, `reports/:type` (+`/export?format=pdf|xlsx`), `users`, `roles`,
`settings`, `audit-logs`, `timeline`, `import` (`/template`, `/preview`, `/commit`), and `/health`.

Reports are produced once as a neutral structure (summary + tables) that the screen, the PDF and the Excel exporter
all render, so the three can never disagree.

## 8. Known limitations

- **External integrations**: e-mail (SMTP) and SMS (Africa's Talking or Pindo) are used only when configured. RRA/EBM,
  WhatsApp, Mobile Money and bank APIs are not integrated; EBM references are typed in by staff. Without an SMS provider,
  reminders are opened in the user's own SMS app (`sms:` link) or copied.
- Phone numbers are stored as +E.164 (Rwandan local numbers like 078… are converted to +25078…).
- Billing after a contract's end date does not continue automatically (see "Expired contracts").
- An early move-out is charged the full final month; adjust with an approved discount or waiver if a refund is agreed.
- Access is not restricted per building: a user's role applies to all buildings.
- Advance credit left on an ended contract is refunded outside the system; record it by reversing the payment or
  noting it — there is no dedicated "credit refund" transaction yet.
- Single currency (RWF) and a single organization per database.
- The interface is English only and designed for light mode.
- The scheduler runs inside the API process; run exactly one API instance (or set `DISABLE_SCHEDULER=true` on the others).
- `npm audit` reports advisories in tooling dependencies of the Prisma CLI and in `exceljs`'s `uuid`; neither path is
  reachable from user input in this application. Re-check on each dependency update.
- MariaDB 10.4 (XAMPP) is past its upstream end of life; plan a move to a maintained MariaDB/MySQL release for production.

## 9. Extending the system

- **EBM / payment / messaging integrations**: add a module beside `services/mailer.ts` and call it from
  `services/invoices.ts` (EBM), `services/messages.ts` (SMS/WhatsApp channel — the `MessageChannel` enum and channel
  status already exist) or a webhook route that calls `recordPayment` with the provider's transaction id as the
  idempotency key.
- **More organizations**: every table already carries `orgId` (directly or through its parent) and every query filters
  by the actor's organization.
- **Utility billing, tenant portal, bank reconciliation**: new charge types would add a `type` to `rent_charges` (or a
  sibling table) and reuse payments/allocations unchanged; a tenant portal is a new role plus read-only routes.
- **Per-building access**: add a `user_buildings` table and apply it in the route layer where `buildingId` filters are
  already accepted.
