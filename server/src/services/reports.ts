import { prisma, Prisma } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { addDays, addMonths, businessDate, daysBetween, endOfMonth, isoDate, longDate, periodLabel, startOfMonth } from '../lib/dates.js';
import type { Money } from '../lib/money.js';
import { money, sum, ZERO } from '../lib/money.js';
import { audit } from './audit.js';
import { expectedRentForMonth } from './charges.js';
import { missingEbmWhere } from './invoices.js';
import { templateLogo } from './contractDocument.js';
import { reconcileCache } from './reconcileCache.js';
import { getOrg } from './org.js';
import { OCCUPYING_STATUSES } from './property.js';

// ───────────────────────── Report model ─────────────────────────
// Every report is produced as this neutral structure, which the screen, the PDF
// exporter and the Excel exporter all render. Numbers therefore cannot differ between
// what is shown, printed and exported.

export type ColumnType = 'text' | 'money' | 'number' | 'date' | 'datetime' | 'percent' | 'status';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
  note?: string;
}

export interface ReportSummaryItem {
  label: string;
  value: unknown;
  type: ColumnType;
}

export interface Report {
  type: ReportType;
  title: string;
  organization: string;
  scope: string;
  period: string;
  generatedAt: string;
  preparedBy: string;
  currency: string;
  summary: ReportSummaryItem[];
  tables: ReportTable[];
  /** Reconciliation problems and important caveats. Empty when everything agrees. */
  warnings: string[];
  notes: string[];
  signatures: boolean;
  isDemoData: boolean;
  /**
   * Who issues the report, printed in its letterhead: for a report on one building, the company that owns
   * that building (UBUMWE HOUSE's details on UBUMWE HOUSE reports, IHURIRO HOUSE's on IHURIRO HOUSE reports);
   * for reports across buildings, the organization.
   */
  issuer: ReportIssuer;
}

export interface ReportIssuer {
  name: string;
  /** Building the report is about, when it is about one building. */
  building: string | null;
  tin: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** data: URL of the company logo (taken from the building's contract), or null — a monogram is shown instead. */
  logo: string | null;
}

export const REPORT_TYPES = {
  building: { title: 'Building Report', financial: true },
  consolidated: { title: 'Consolidated Report — All Buildings', financial: true },
  'monthly-rent': { title: 'Monthly Rent Report', financial: true },
  'building-monthly': { title: 'Monthly Building Report', financial: true },
  'daily-collection': { title: 'Daily Collection Report', financial: true },
  arrears: { title: 'Tenant Arrears Report', financial: true },
  occupancy: { title: 'Occupancy Report', financial: false },
  payments: { title: 'Payments Report', financial: true },
  'rent-ledger': { title: 'Rent Ledger', financial: true },
  expenses: { title: 'Expense Report', financial: true },
  maintenance: { title: 'Maintenance Report', financial: false },
  'late-payers': { title: 'Repeated Late Payment Report', financial: true },
  tenants: { title: 'Tenant List', financial: false },
  rooms: { title: 'Room List', financial: false },
  contracts: { title: 'Contract List', financial: false },
} as const;

export type ReportType = keyof typeof REPORT_TYPES;

export interface ReportParams {
  from: Date;
  to: Date;
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  tenantId?: string;
  methodId?: string;
  /** Rent charge status. */
  paymentStatus?: string;
  contractStatus?: string;
  /** building report: break down by floor (default) or room. */
  groupBy?: 'floor' | 'room';
  sort?: string;
  /** arrears report: only rent whose grace period has passed. */
  overdueOnly?: boolean;
}

const col = (key: string, label: string, type: ColumnType = 'text'): ReportColumn => ({ key, label, type });

// ───────────────────────── Shared calculations ─────────────────────────

type GroupKey = 'buildingId' | 'floorId' | 'roomId';

export interface FinancialRow {
  expected: Money;
  collected: Money;
  waived: Money;
  outstanding: Money;
  cashReceived: Money;
  expenses: Money;
  net: Money;
  charges: number;
}

const emptyRow = (): FinancialRow => ({ expected: ZERO, collected: ZERO, waived: ZERO, outstanding: ZERO, cashReceived: ZERO, expenses: ZERO, net: ZERO, charges: 0 });

export function addRows(rows: FinancialRow[]): FinancialRow {
  const t = emptyRow();
  for (const r of rows) {
    t.expected = t.expected.plus(r.expected);
    t.collected = t.collected.plus(r.collected);
    t.waived = t.waived.plus(r.waived);
    t.outstanding = t.outstanding.plus(r.outstanding);
    t.cashReceived = t.cashReceived.plus(r.cashReceived);
    t.expenses = t.expenses.plus(r.expenses);
    t.net = t.net.plus(r.net);
    t.charges += r.charges;
  }
  return t;
}

interface Scope {
  orgId: string;
  from: Date;
  to: Date;
  buildingId?: string;
  floorId?: string;
  roomId?: string;
  tenantId?: string;
}

const placeFilter = (s: Scope) => ({
  ...(s.buildingId ? { buildingId: s.buildingId } : {}), ...(s.floorId ? { floorId: s.floorId } : {}), ...(s.roomId ? { roomId: s.roomId } : {}),
});

/**
 * The financial figures behind every report, grouped by building, floor or room.
 *
 *  expected     = rent charges billed for the months in range (void charges excluded)
 *  collected    = payments allocated to those charges
 *  waived       = approved waivers on those charges
 *  outstanding  = expected − collected − waived
 *  cashReceived = money actually received in the date range (includes arrears and advances, net of reversals)
 *  expenses     = approved expenses dated in the range
 *  net          = collected − expenses
 *
 * `null` group key = not attributable at this level (e.g. a building-wide expense when grouping by floor).
 */
export async function financialByGroup(scope: Scope, by: GroupKey): Promise<Map<string | null, FinancialRow>> {
  const place = placeFilter(scope);
  const periodFrom = startOfMonth(scope.from);
  const periodTo = startOfMonth(scope.to);
  const tenant = scope.tenantId ? { tenantId: scope.tenantId } : {};
  const [charges, cash, expenses] = await Promise.all([
    prisma.rentCharge.groupBy({
      by: [by], where: { orgId: scope.orgId, status: { not: 'VOID' }, period: { gte: periodFrom, lte: periodTo }, ...place, ...tenant },
      _sum: { amountDue: true, amountPaid: true, amountWaived: true, balance: true }, _count: { _all: true },
    }),
    prisma.payment.groupBy({ by: [by], where: { orgId: scope.orgId, businessDate: { gte: scope.from, lte: scope.to }, ...place, ...tenant }, _sum: { amount: true } }),
    scope.tenantId
      ? Promise.resolve([])
      : prisma.expense.groupBy({ by: [by], where: { orgId: scope.orgId, status: 'APPROVED', expenseDate: { gte: scope.from, lte: scope.to }, ...place }, _sum: { amount: true } }),
  ]);
  const out = new Map<string | null, FinancialRow>();
  const row = (key: string | null) => {
    let r = out.get(key);
    if (!r) out.set(key, (r = emptyRow()));
    return r;
  };
  for (const c of charges) {
    const r = row(c[by]);
    r.expected = money(c._sum.amountDue);
    r.collected = money(c._sum.amountPaid);
    r.waived = money(c._sum.amountWaived);
    r.outstanding = money(c._sum.balance);
    r.charges = c._count._all;
  }
  for (const p of cash) row(p[by]).cashReceived = money(p._sum.amount);
  for (const e of expenses) row((e as Record<string, unknown>)[by] as string | null).expenses = money((e as { _sum: { amount: Prisma.Decimal | null } })._sum.amount);
  for (const r of out.values()) r.net = r.collected.minus(r.expenses);
  return out;
}

/** Rent paid ahead in the range: allocations to months after the payment month, plus unallocated credit.
 * The joins start from the period's payments (STRAIGHT_JOIN), which is far faster than scanning all allocations. */
async function advanceInRange(scope: Scope): Promise<Money> {
  const rows = await prisma.$queryRaw<Array<{ total: Prisma.Decimal | null }>>(Prisma.sql`
    SELECT SUM(a.amount) AS total
    FROM payments p
    STRAIGHT_JOIN payment_allocations a ON a.paymentId = p.id
    STRAIGHT_JOIN rent_charges c ON c.id = a.rentChargeId
    WHERE p.orgId = ${scope.orgId} AND p.businessDate BETWEEN ${scope.from} AND ${scope.to}
      AND c.period > LAST_DAY(p.businessDate)
      ${scope.buildingId ? Prisma.sql`AND p.buildingId = ${scope.buildingId}` : Prisma.empty}
      ${scope.floorId ? Prisma.sql`AND p.floorId = ${scope.floorId}` : Prisma.empty}
      ${scope.roomId ? Prisma.sql`AND p.roomId = ${scope.roomId}` : Prisma.empty}
      ${scope.tenantId ? Prisma.sql`AND p.tenantId = ${scope.tenantId}` : Prisma.empty}`);
  const credit = await prisma.payment.aggregate({
    where: { orgId: scope.orgId, type: 'PAYMENT', status: 'POSTED', businessDate: { gte: scope.from, lte: scope.to }, ...placeFilter(scope), ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) },
    _sum: { unallocatedAmount: true },
  });
  return money(rows[0]?.total).plus(money(credit._sum.unallocatedAmount));
}

/** advanceInRange for every building at once: one query for allocations, one for credit. */
async function advanceByBuilding(scope: Scope): Promise<Map<string, Money>> {
  const rows = await prisma.$queryRaw<Array<{ buildingId: string; total: Prisma.Decimal | null }>>(Prisma.sql`
    SELECT p.buildingId, SUM(a.amount) AS total
    FROM payments p
    STRAIGHT_JOIN payment_allocations a ON a.paymentId = p.id
    STRAIGHT_JOIN rent_charges c ON c.id = a.rentChargeId
    WHERE p.orgId = ${scope.orgId} AND p.businessDate BETWEEN ${scope.from} AND ${scope.to}
      AND c.period > LAST_DAY(p.businessDate)
      ${scope.buildingId ? Prisma.sql`AND p.buildingId = ${scope.buildingId}` : Prisma.empty}
    GROUP BY p.buildingId`);
  const credit = await prisma.payment.groupBy({
    by: ['buildingId'], where: { orgId: scope.orgId, type: 'PAYMENT', status: 'POSTED', businessDate: { gte: scope.from, lte: scope.to }, ...placeFilter(scope) },
    _sum: { unallocatedAmount: true },
  });
  const out = new Map<string, Money>();
  for (const r of rows) out.set(r.buildingId, money(r.total));
  for (const c of credit) out.set(c.buildingId, (out.get(c.buildingId) ?? ZERO).plus(money(c._sum.unallocatedAmount)));
  return out;
}

export interface OccupancyRow {
  total: number;
  occupied: number;
  vacant: number;
  reserved: number;
  maintenance: number;
  inactive: number;
  /** occupied ÷ rentable rooms (inactive rooms are not rentable). */
  rate: number | null;
}

export async function occupancyByGroup(orgId: string, by: 'buildingId' | 'floorId', f: { buildingId?: string; floorId?: string }): Promise<Map<string, OccupancyRow>> {
  const rows = await prisma.room.groupBy({
    by: [by, 'status'], where: { building: { orgId }, ...(f.buildingId ? { buildingId: f.buildingId } : {}), ...(f.floorId ? { floorId: f.floorId } : {}) }, _count: { _all: true },
  });
  const out = new Map<string, OccupancyRow>();
  for (const r of rows) {
    const key = r[by];
    const o = out.get(key) ?? { total: 0, occupied: 0, vacant: 0, reserved: 0, maintenance: 0, inactive: 0, rate: null };
    const n = r._count._all;
    o.total += n;
    if (r.status === 'OCCUPIED') o.occupied += n;
    else if (r.status === 'VACANT') o.vacant += n;
    else if (r.status === 'RESERVED') o.reserved += n;
    else if (r.status === 'MAINTENANCE') o.maintenance += n;
    else o.inactive += n;
    out.set(key, o);
  }
  for (const o of out.values()) o.rate = occupancyRate(o);
  return out;
}

export function occupancyRate(o: { total: number; occupied: number; inactive: number }): number | null {
  const rentable = o.total - o.inactive;
  return rentable > 0 ? o.occupied / rentable : null;
}

export function sumOccupancy(rows: OccupancyRow[]): OccupancyRow {
  const t: OccupancyRow = { total: 0, occupied: 0, vacant: 0, reserved: 0, maintenance: 0, inactive: 0, rate: null };
  for (const r of rows) {
    t.total += r.total; t.occupied += r.occupied; t.vacant += r.vacant; t.reserved += r.reserved; t.maintenance += r.maintenance; t.inactive += r.inactive;
  }
  t.rate = occupancyRate(t);
  return t;
}

const pct = (part: Money, whole: Money): number | null => (whole.isZero() ? null : part.dividedBy(whole).toNumber());

function financialCells(r: FinancialRow) {
  return { expected: r.expected, collected: r.collected, waived: r.waived, outstanding: r.outstanding, cashReceived: r.cashReceived, expenses: r.expenses, net: r.net, collectionRate: pct(r.collected, r.expected) };
}

const FIN_COLUMNS = [
  col('expected', 'Expected rent', 'money'), col('collected', 'Collected', 'money'), col('waived', 'Waived', 'money'),
  col('outstanding', 'Outstanding', 'money'), col('collectionRate', 'Collection %', 'percent'), col('expenses', 'Expenses', 'money'),
  col('net', 'Net income', 'money'), col('cashReceived', 'Cash received', 'money'),
];

const FIN_NOTE =
  'Expected, Collected and Outstanding relate to rent billed for the months in the report period. Net income = Collected − Expenses. ' +
  '"Cash received" is all money received in the period, including arrears from earlier months and advance payments, net of reversals. Security deposits are not included.';

// ───────────────────────── Reconciliation ─────────────────────────

export interface ReconciliationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Automated consistency checks. Any failing check is shown to administrators as a
 * warning on dashboards and printed on reports.
 */
/**
 * The same checks, reused for a minute per organization and period: the dashboard and reports run them on every
 * view, and with tens of thousands of tenants recomputing them each time would slow every page down.
 */
export function reconcileCached(orgId: string, from: Date, to: Date): Promise<ReconciliationCheck[]> {
  const key = `${orgId}|${isoDate(from)}|${isoDate(to)}`;
  const hit = reconcileCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.checks as Promise<ReconciliationCheck[]>;
  const checks = reconcile(orgId, from, to);
  reconcileCache.set(key, { at: Date.now(), checks });
  checks.catch(() => reconcileCache.delete(key));
  if (reconcileCache.size > 200) reconcileCache.delete(reconcileCache.keys().next().value!);
  return checks;
}

export async function reconcile(orgId: string, from: Date, to: Date): Promise<ReconciliationCheck[]> {
  const checks: ReconciliationCheck[] = [];
  const count = async (sql: Prisma.Sql) => Number((await prisma.$queryRaw<Array<{ n: bigint | number }>>(sql))[0]?.n ?? 0);

  // The ledger checks cover the records this report is built from (its months and its payment days), so they stay
  // fast however many years of history the organization has.
  const pFrom = startOfMonth(from);
  const pTo = startOfMonth(to);
  const [chargeMismatch, paymentMismatch, badStatus, occupancyMismatch] = await Promise.all([
    count(Prisma.sql`
      SELECT COUNT(*) AS n FROM (
        SELECT c.id FROM rent_charges c LEFT JOIN payment_allocations a ON a.rentChargeId = c.id
        WHERE c.orgId = ${orgId} AND c.period BETWEEN ${pFrom} AND ${pTo} GROUP BY c.id, c.amountPaid HAVING c.amountPaid <> COALESCE(SUM(a.amount), 0)) x`),
    count(Prisma.sql`
      SELECT COUNT(*) AS n FROM (
        SELECT p.id FROM payments p LEFT JOIN payment_allocations a ON a.paymentId = p.id
        WHERE p.orgId = ${orgId} AND p.businessDate BETWEEN ${from} AND ${to} GROUP BY p.id, p.allocatedAmount HAVING p.allocatedAmount <> COALESCE(SUM(a.amount), 0)) x`),
    count(Prisma.sql`
      SELECT COUNT(*) AS n FROM rent_charges
      WHERE orgId = ${orgId} AND period BETWEEN ${pFrom} AND ${pTo}
        AND ((status = 'PAID' AND balance <> 0) OR (status IN ('UNPAID', 'OVERDUE', 'PARTIAL') AND balance <= 0) OR balance <> amountDue - amountPaid - amountWaived)`),
    count(Prisma.sql`
      SELECT COUNT(*) AS n FROM rooms r JOIN buildings b ON b.id = r.buildingId
      LEFT JOIN contracts c ON c.roomId = r.id AND c.status IN ('ACTIVE', 'EXPIRING', 'EXPIRED')
      WHERE b.orgId = ${orgId} AND ((r.status = 'OCCUPIED' AND c.id IS NULL) OR (r.status <> 'OCCUPIED' AND c.id IS NOT NULL))`),
  ]);
  checks.push({ name: 'Rent charges equal their payment allocations', ok: chargeMismatch === 0, detail: chargeMismatch ? `${chargeMismatch} rent charge(s) show a paid amount that differs from the payments allocated to them.` : 'Every charge\'s paid amount equals the sum of its allocations.' });
  checks.push({ name: 'Payments equal their allocations', ok: paymentMismatch === 0, detail: paymentMismatch ? `${paymentMismatch} payment(s) have an allocated amount that differs from their allocation lines.` : 'Every payment is fully accounted for (allocated + advance credit = amount).' });
  checks.push({ name: 'Charge status matches balance', ok: badStatus === 0, detail: badStatus ? `${badStatus} rent charge(s) have a status that contradicts their balance.` : 'No paid charge shows a balance and no open charge is fully settled.' });
  checks.push({ name: 'Room status matches contracts', ok: occupancyMismatch === 0, detail: occupancyMismatch ? `${occupancyMismatch} room(s) have an occupancy status that does not match their contracts.` : 'Every occupied room has exactly one active contract.' });

  // Building reports must equal the sum of their rooms; the consolidated report must equal the sum of buildings.
  const scope: Scope = { orgId, from, to };
  const [byBuilding, byRoom, rooms] = await Promise.all([
    financialByGroup(scope, 'buildingId'), financialByGroup(scope, 'roomId'),
    prisma.room.findMany({ where: { building: { orgId } }, select: { id: true, buildingId: true } }),
  ]);
  const roomBuilding = new Map(rooms.map((r) => [r.id, r.buildingId]));
  const fromRooms = new Map<string, FinancialRow[]>();
  for (const [roomId, row] of byRoom) {
    if (!roomId) continue;
    const b = roomBuilding.get(roomId);
    if (b) fromRooms.set(b, [...(fromRooms.get(b) ?? []), row]);
  }
  const drift: string[] = [];
  for (const [buildingId, row] of byBuilding) {
    if (!buildingId) continue;
    const s = addRows(fromRooms.get(buildingId) ?? []);
    if (!s.expected.equals(row.expected) || !s.collected.equals(row.collected) || !s.outstanding.equals(row.outstanding) || !s.cashReceived.equals(row.cashReceived)) drift.push(buildingId);
  }
  checks.push({ name: 'Building totals equal the sum of their rooms', ok: drift.length === 0, detail: drift.length ? `${drift.length} building(s) have totals that differ from the sum of their rooms.` : 'Each building\'s expected, collected and outstanding equal the sum of its rooms.' });

  const [chargeTotal, cashTotal, expenseTotal] = await Promise.all([
    prisma.rentCharge.aggregate({ where: { orgId, status: { not: 'VOID' }, period: { gte: startOfMonth(from), lte: startOfMonth(to) } }, _sum: { amountDue: true, amountPaid: true, balance: true } }),
    prisma.payment.aggregate({ where: { orgId, businessDate: { gte: from, lte: to } }, _sum: { amount: true } }),
    prisma.expense.aggregate({ where: { orgId, status: 'APPROVED', expenseDate: { gte: from, lte: to } }, _sum: { amount: true } }),
  ]);
  const all = addRows([...byBuilding.values()]);
  const consolidatedOk = all.expected.equals(money(chargeTotal._sum.amountDue)) && all.collected.equals(money(chargeTotal._sum.amountPaid))
    && all.outstanding.equals(money(chargeTotal._sum.balance)) && all.cashReceived.equals(money(cashTotal._sum.amount)) && all.expenses.equals(money(expenseTotal._sum.amount));
  checks.push({ name: 'Consolidated totals equal the sum of the buildings', ok: consolidatedOk, detail: consolidatedOk ? 'Organization totals equal the sum of all building rows.' : 'Organization-wide totals differ from the sum of the building rows.' });
  return checks;
}

// ───────────────────────── Report builders ─────────────────────────

interface Ctx {
  actor: Actor;
  orgId: string;
  today: Date;
  p: ReportParams;
  scope: Scope;
  buildings: Array<{ id: string; name: string; code: string }>;
}

type Built = Pick<Report, 'summary' | 'tables'> & Partial<Pick<Report, 'warnings' | 'notes' | 'signatures' | 'scope' | 'period'>>;

async function floorsOf(ctx: Ctx) {
  return prisma.floor.findMany({
    where: { building: { orgId: ctx.orgId }, ...(ctx.p.buildingId ? { buildingId: ctx.p.buildingId } : {}), ...(ctx.p.floorId ? { id: ctx.p.floorId } : {}) },
    include: { building: { select: { name: true } } }, orderBy: [{ building: { name: 'asc' } }, { level: 'asc' }],
  });
}

async function buildingReport(ctx: Ctx): Promise<Built> {
  if (!ctx.p.buildingId) throw badRequest('Select a building for the building report, or use the consolidated report for all buildings.', 'BUILDING_REQUIRED');
  const byRoom = ctx.p.groupBy === 'room' || Boolean(ctx.p.roomId) || Boolean(ctx.p.floorId);
  const [totalMap, occ, floors, advance, expByCat, maintenance] = await Promise.all([
    financialByGroup(ctx.scope, 'buildingId'),
    occupancyByGroup(ctx.orgId, 'floorId', ctx.p),
    floorsOf(ctx),
    advanceInRange(ctx.scope),
    prisma.expense.groupBy({ by: ['categoryId'], where: { orgId: ctx.orgId, status: 'APPROVED', expenseDate: { gte: ctx.p.from, lte: ctx.p.to }, ...placeFilter(ctx.scope) }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.maintenanceRequest.groupBy({ by: ['status'], where: { orgId: ctx.orgId, ...placeFilter(ctx.scope), reportedOn: { lte: ctx.p.to } }, _count: { _all: true } }),
  ]);
  const total = addRows([...totalMap.values()]);
  const occTotal = sumOccupancy([...occ.values()]);
  const tenants = await prisma.contract.count({ where: { orgId: ctx.orgId, status: { in: [...OCCUPYING_STATUSES] }, ...placeFilter(ctx.scope) } });
  const categories = await prisma.expenseCategory.findMany({ where: { orgId: ctx.orgId } });

  const tables: ReportTable[] = [];
  if (!byRoom) {
    const byFloor = await financialByGroup(ctx.scope, 'floorId');
    const rows = floors.map((f) => {
      const o = occ.get(f.id) ?? sumOccupancy([]);
      return { floor: f.name, rooms: o.total, occupied: o.occupied, vacant: o.vacant, ...financialCells(byFloor.get(f.id) ?? emptyRow()) };
    });
    const unassigned = byFloor.get(null);
    if (unassigned && !unassigned.expenses.isZero()) rows.push({ floor: 'Building-wide (no floor)', rooms: 0, occupied: 0, vacant: 0, ...financialCells(unassigned) });
    tables.push({
      title: 'By floor', columns: [col('floor', 'Floor'), col('rooms', 'Rooms', 'number'), col('occupied', 'Occupied', 'number'), col('vacant', 'Vacant', 'number'), ...FIN_COLUMNS],
      rows, totals: { floor: 'TOTAL', rooms: occTotal.total, occupied: occTotal.occupied, vacant: occTotal.vacant, ...financialCells(total) },
    });
  }
  const byRoomMap = await financialByGroup(ctx.scope, 'roomId');
  const rooms = await prisma.room.findMany({
    where: { building: { orgId: ctx.orgId }, ...placeFilter({ ...ctx.scope, roomId: undefined }), ...(ctx.p.roomId ? { id: ctx.p.roomId } : {}) },
    include: { floor: { select: { name: true, level: true } }, contracts: { where: { status: { in: [...OCCUPYING_STATUSES] } }, select: { tenant: { select: { fullName: true } } } } },
    orderBy: [{ floor: { level: 'asc' } }, { number: 'asc' }],
  });
  const roomRows: Array<Record<string, unknown>> = rooms.map((r) => ({ floor: r.floor.name, room: r.number, status: r.status, tenant: r.contracts[0]?.tenant.fullName ?? '', monthlyRent: r.monthlyRent, ...financialCells(byRoomMap.get(r.id) ?? emptyRow()) }));
  const unassignedRoom = byRoomMap.get(null);
  if (unassignedRoom && !unassignedRoom.expenses.isZero()) roomRows.push({ floor: '', room: 'Not tied to a room', status: '', tenant: '', monthlyRent: null, ...financialCells(unassignedRoom) });
  tables.push({
    title: 'By room', columns: [col('floor', 'Floor'), col('room', 'Room'), col('status', 'Status', 'status'), col('tenant', 'Tenant'), col('monthlyRent', 'Monthly rent', 'money'), ...FIN_COLUMNS],
    rows: roomRows, totals: { floor: 'TOTAL', ...financialCells(total) },
  });
  tables.push({
    title: 'Expenses by category', columns: [col('category', 'Category'), col('count', 'Entries', 'number'), col('amount', 'Amount', 'money')],
    rows: expByCat.map((e) => ({ category: categories.find((c) => c.id === e.categoryId)?.name ?? '—', count: e._count._all, amount: money(e._sum.amount) })).sort((a, b) => b.amount.comparedTo(a.amount)),
    totals: { category: 'TOTAL', amount: total.expenses },
  });
  const openMaint = maintenance.filter((m) => !['COMPLETED', 'CANCELLED'].includes(m.status)).reduce((a, m) => a + m._count._all, 0);

  return {
    summary: [
      { label: 'Total floors', value: floors.length, type: 'number' }, { label: 'Total rooms', value: occTotal.total, type: 'number' },
      { label: 'Occupied rooms', value: occTotal.occupied, type: 'number' }, { label: 'Vacant rooms', value: occTotal.vacant, type: 'number' },
      { label: 'Reserved rooms', value: occTotal.reserved, type: 'number' }, { label: 'Rooms under maintenance', value: occTotal.maintenance, type: 'number' },
      { label: 'Occupancy rate', value: occTotal.rate, type: 'percent' }, { label: 'Tenants', value: tenants, type: 'number' },
      { label: 'Total expected rent', value: total.expected, type: 'money' }, { label: 'Total collected', value: total.collected, type: 'money' },
      { label: 'Total outstanding', value: total.outstanding, type: 'money' }, { label: 'Waived', value: total.waived, type: 'money' },
      { label: 'Collection rate', value: pct(total.collected, total.expected), type: 'percent' }, { label: 'Total expenses', value: total.expenses, type: 'money' },
      { label: 'Net income', value: total.net, type: 'money' }, { label: 'Cash received in period', value: total.cashReceived, type: 'money' },
      { label: 'Advance payments in period', value: advance, type: 'money' }, { label: 'Open maintenance issues', value: openMaint, type: 'number' },
    ],
    tables, notes: [FIN_NOTE, 'Organization-wide expenses are not included in a building report; see the consolidated report.'], signatures: true,
  };
}

async function consolidatedReport(ctx: Ctx): Promise<Built> {
  const scope: Scope = { orgId: ctx.orgId, from: ctx.p.from, to: ctx.p.to };
  const [fin, occ, tenantCounts, methods, payByMethod, expByCat, categories, maint, invoices, arrears, advance, maintCost] = await Promise.all([
    financialByGroup(scope, 'buildingId'),
    occupancyByGroup(ctx.orgId, 'buildingId', {}),
    prisma.contract.groupBy({ by: ['buildingId'], where: { orgId: ctx.orgId, status: { in: [...OCCUPYING_STATUSES] } }, _count: { _all: true } }),
    prisma.paymentMethod.findMany({ where: { orgId: ctx.orgId }, orderBy: { sortOrder: 'asc' } }),
    prisma.payment.groupBy({ by: ['buildingId', 'methodId'], where: { orgId: ctx.orgId, businessDate: { gte: ctx.p.from, lte: ctx.p.to } }, _sum: { amount: true } }),
    prisma.expense.groupBy({ by: ['buildingId', 'categoryId'], where: { orgId: ctx.orgId, status: 'APPROVED', expenseDate: { gte: ctx.p.from, lte: ctx.p.to } }, _sum: { amount: true } }),
    prisma.expenseCategory.findMany({ where: { orgId: ctx.orgId }, orderBy: { name: 'asc' } }),
    prisma.maintenanceRequest.groupBy({ by: ['buildingId', 'status'], where: { orgId: ctx.orgId }, _count: { _all: true } }),
    prisma.invoice.groupBy({ by: ['buildingId', 'status'], where: { orgId: ctx.orgId, issueDate: { gte: ctx.p.from, lte: ctx.p.to } }, _count: { _all: true } }),
    prisma.rentCharge.groupBy({ by: ['buildingId'], where: { orgId: ctx.orgId, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, overdueFrom: { lt: ctx.today }, balance: { gt: 0 } }, _sum: { balance: true }, _count: { _all: true } }),
    advanceInRange(scope),
    prisma.expense.groupBy({ by: ['buildingId'], where: { orgId: ctx.orgId, status: 'APPROVED', maintenanceRequestId: { not: null }, expenseDate: { gte: ctx.p.from, lte: ctx.p.to } }, _sum: { amount: true } }),
  ]);
  const B = ctx.buildings;
  const finRows = B.map((b) => ({ building: b.name, ...financialCells(fin.get(b.id) ?? emptyRow()) }));
  const orgWide = fin.get(null);
  if (orgWide && !orgWide.expenses.isZero()) finRows.push({ building: 'Organization-wide (not tied to a building)', ...financialCells(orgWide) });
  const total = addRows([...fin.values()]);
  const occTotal = sumOccupancy([...occ.values()]);
  const tenantsOf = (id: string) => tenantCounts.find((t) => t.buildingId === id)?._count._all ?? 0;
  const methodCols = methods.filter((m) => m.isActive || payByMethod.some((p) => p.methodId === m.id));
  const maintOpen = (id: string) => maint.filter((m) => m.buildingId === id && !['COMPLETED', 'CANCELLED'].includes(m.status)).reduce((a, m) => a + m._count._all, 0);
  const maintDone = (id: string) => maint.find((m) => m.buildingId === id && m.status === 'COMPLETED')?._count._all ?? 0;
  const inv = (id: string, statuses: string[]) => invoices.filter((i) => i.buildingId === id && statuses.includes(i.status)).reduce((a, i) => a + i._count._all, 0);
  const usedCategories = categories.filter((c) => expByCat.some((e) => e.categoryId === c.id));
  const expCell = (buildingId: string | null, categoryId: string) => money(expByCat.find((e) => e.buildingId === buildingId && e.categoryId === categoryId)?._sum.amount);

  const tables: ReportTable[] = [
    { title: 'Financial summary by building', columns: [col('building', 'Building'), ...FIN_COLUMNS], rows: finRows, totals: { building: 'TOTAL', ...financialCells(total) } },
    {
      title: 'Occupancy and tenants',
      columns: [col('building', 'Building'), col('total', 'Rooms', 'number'), col('occupied', 'Occupied', 'number'), col('vacant', 'Vacant', 'number'), col('reserved', 'Reserved', 'number'), col('maintenance', 'Maintenance', 'number'), col('rate', 'Occupancy %', 'percent'), col('tenants', 'Tenants', 'number')],
      rows: B.map((b) => ({ building: b.name, ...(occ.get(b.id) ?? sumOccupancy([])), tenants: tenantsOf(b.id) })),
      totals: { building: 'TOTAL', ...occTotal, tenants: tenantCounts.reduce((a, t) => a + t._count._all, 0) },
    },
    {
      title: 'Arrears (overdue as of today)', columns: [col('building', 'Building'), col('charges', 'Overdue charges', 'number'), col('balance', 'Overdue balance', 'money')],
      rows: B.map((b) => { const a = arrears.find((x) => x.buildingId === b.id); return { building: b.name, charges: a?._count._all ?? 0, balance: money(a?._sum.balance) }; }),
      totals: { building: 'TOTAL', charges: arrears.reduce((a, x) => a + x._count._all, 0), balance: sum(arrears.map((a) => a._sum.balance)) },
    },
    {
      title: 'Cash received by payment method', columns: [col('building', 'Building'), ...methodCols.map((m) => col(m.id, m.name, 'money')), col('total', 'Total', 'money')],
      rows: B.map((b) => ({ building: b.name, ...Object.fromEntries(methodCols.map((m) => [m.id, money(payByMethod.find((p) => p.buildingId === b.id && p.methodId === m.id)?._sum.amount)])), total: (fin.get(b.id) ?? emptyRow()).cashReceived })),
      totals: { building: 'TOTAL', ...Object.fromEntries(methodCols.map((m) => [m.id, sum(payByMethod.filter((p) => p.methodId === m.id).map((p) => p._sum.amount))])), total: total.cashReceived },
    },
    {
      title: 'Expenses by category', columns: [col('category', 'Category'), ...B.map((b) => col(b.id, b.name, 'money')), col('org', 'Organization-wide', 'money'), col('total', 'Total', 'money')],
      rows: usedCategories.map((c) => ({ category: c.name, ...Object.fromEntries(B.map((b) => [b.id, expCell(b.id, c.id)])), org: expCell(null, c.id), total: sum(expByCat.filter((e) => e.categoryId === c.id).map((e) => e._sum.amount)) })),
      totals: { category: 'TOTAL', ...Object.fromEntries(B.map((b) => [b.id, (fin.get(b.id) ?? emptyRow()).expenses])), org: (orgWide ?? emptyRow()).expenses, total: total.expenses },
    },
    {
      title: 'Maintenance', columns: [col('building', 'Building'), col('open', 'Open issues', 'number'), col('completed', 'Completed (all time)', 'number'), col('cost', 'Maintenance cost in period', 'money')],
      rows: B.map((b) => ({ building: b.name, open: maintOpen(b.id), completed: maintDone(b.id), cost: money(maintCost.find((m) => m.buildingId === b.id)?._sum.amount) })),
      totals: { building: 'TOTAL', open: B.reduce((a, b) => a + maintOpen(b.id), 0), completed: B.reduce((a, b) => a + maintDone(b.id), 0), cost: sum(maintCost.map((m) => m._sum.amount)) },
    },
    {
      title: 'Invoice / EBM status (payments in period)', columns: [col('building', 'Building'), col('issued', 'Issued', 'number'), col('pending', 'Pending / generated', 'number'), col('failed', 'Failed', 'number'), col('cancelled', 'Cancelled', 'number')],
      rows: B.map((b) => ({ building: b.name, issued: inv(b.id, ['ISSUED']), pending: inv(b.id, ['PENDING', 'GENERATED']), failed: inv(b.id, ['FAILED']), cancelled: inv(b.id, ['CANCELLED']) })),
      totals: { building: 'TOTAL', issued: B.reduce((a, b) => a + inv(b.id, ['ISSUED']), 0), pending: B.reduce((a, b) => a + inv(b.id, ['PENDING', 'GENERATED']), 0), failed: B.reduce((a, b) => a + inv(b.id, ['FAILED']), 0), cancelled: B.reduce((a, b) => a + inv(b.id, ['CANCELLED']), 0) },
    },
  ];
  return {
    scope: 'All buildings',
    summary: [
      { label: 'Buildings', value: B.length, type: 'number' }, { label: 'Total rooms', value: occTotal.total, type: 'number' },
      { label: 'Occupied rooms', value: occTotal.occupied, type: 'number' }, { label: 'Vacant rooms', value: occTotal.vacant, type: 'number' },
      { label: 'Occupancy rate', value: occTotal.rate, type: 'percent' }, { label: 'Tenants', value: tenantCounts.reduce((a, t) => a + t._count._all, 0), type: 'number' },
      { label: 'Total expected rent', value: total.expected, type: 'money' }, { label: 'Total collected', value: total.collected, type: 'money' },
      { label: 'Total outstanding', value: total.outstanding, type: 'money' }, { label: 'Collection rate', value: pct(total.collected, total.expected), type: 'percent' },
      { label: 'Total expenses', value: total.expenses, type: 'money' }, { label: 'Net income', value: total.net, type: 'money' },
      { label: 'Cash received in period', value: total.cashReceived, type: 'money' }, { label: 'Advance payments in period', value: advance, type: 'money' },
    ],
    tables, notes: [FIN_NOTE], signatures: true,
  };
}

async function monthlyRentReport(ctx: Ctx): Promise<Built> {
  const months: Date[] = [];
  for (let m = startOfMonth(ctx.p.from); m <= startOfMonth(ctx.p.to) && months.length < 24; m = addMonths(m, 1)) months.push(m);
  const place = placeFilter(ctx.scope);
  const B = ctx.p.buildingId ? ctx.buildings.filter((b) => b.id === ctx.p.buildingId) : ctx.buildings;
  const tables: ReportTable[] = [];
  const overall: Array<Record<string, unknown>> = [];
  for (const month of months) {
    const where = { orgId: ctx.orgId, period: month, status: { not: 'VOID' as const }, ...place };
    const scope: Scope = { ...ctx.scope, from: month, to: endOfMonth(month) };
    const [sums, statuses, advance] = await Promise.all([
      prisma.rentCharge.groupBy({ by: ['buildingId'], where, _sum: { amountDue: true, amountPaid: true, amountWaived: true, balance: true } }),
      prisma.rentCharge.groupBy({ by: ['buildingId', 'status'], where, _count: { _all: true }, _sum: { amountPaid: true } }),
      advanceByBuilding({ ...scope, buildingId: ctx.p.buildingId }),
    ]);
    const n = (id: string, st: string[]) => statuses.filter((s) => s.buildingId === id && st.includes(s.status)).reduce((a, s) => a + s._count._all, 0);
    const rows = B.map((b) => {
      const s = sums.find((x) => x.buildingId === b.id);
      const expected = money(s?._sum.amountDue);
      const collected = money(s?._sum.amountPaid);
      return {
        building: b.name, expected, collected,
        partial: sum(statuses.filter((x) => x.buildingId === b.id && x.status === 'PARTIAL').map((x) => x._sum.amountPaid)),
        waived: money(s?._sum.amountWaived), outstanding: money(s?._sum.balance), advance: advance.get(b.id) ?? ZERO,
        paidTenants: n(b.id, ['PAID']), partialTenants: n(b.id, ['PARTIAL']), unpaidTenants: n(b.id, ['UNPAID', 'OVERDUE']), collectionRate: pct(collected, expected),
      };
    });
    const tot = {
      building: 'TOTAL', expected: sum(rows.map((r) => r.expected)), collected: sum(rows.map((r) => r.collected)), partial: sum(rows.map((r) => r.partial)),
      waived: sum(rows.map((r) => r.waived)), outstanding: sum(rows.map((r) => r.outstanding)), advance: sum(rows.map((r) => r.advance)),
      paidTenants: rows.reduce((a, r) => a + r.paidTenants, 0), partialTenants: rows.reduce((a, r) => a + r.partialTenants, 0), unpaidTenants: rows.reduce((a, r) => a + r.unpaidTenants, 0),
      collectionRate: pct(sum(rows.map((r) => r.collected)), sum(rows.map((r) => r.expected))),
    };
    overall.push({ ...tot, building: undefined, month: periodLabel(month) });
    tables.push({
      title: periodLabel(month),
      columns: [
        col('building', 'Building'), col('expected', 'Expected rent', 'money'), col('collected', 'Collected', 'money'), col('partial', 'Of which partial payments', 'money'),
        col('outstanding', 'Outstanding', 'money'), col('waived', 'Waived', 'money'), col('advance', 'Advance payments received', 'money'),
        col('paidTenants', 'Paid', 'number'), col('partialTenants', 'Partially paid', 'number'), col('unpaidTenants', 'Unpaid', 'number'), col('collectionRate', 'Collection %', 'percent'),
      ],
      rows, totals: tot,
    });
  }
  if (months.length > 1) {
    tables.unshift({
      title: 'Month by month',
      columns: [col('month', 'Month'), col('expected', 'Expected rent', 'money'), col('collected', 'Collected', 'money'), col('outstanding', 'Outstanding', 'money'), col('advance', 'Advance payments', 'money'), col('paidTenants', 'Paid', 'number'), col('partialTenants', 'Partial', 'number'), col('unpaidTenants', 'Unpaid', 'number'), col('collectionRate', 'Collection %', 'percent')],
      rows: overall,
    });
  }
  const last = overall[overall.length - 1] ?? {};
  return {
    summary: [
      { label: 'Expected rent', value: sum(overall.map((o) => o.expected as Money)), type: 'money' }, { label: 'Collected rent', value: sum(overall.map((o) => o.collected as Money)), type: 'money' },
      { label: 'Outstanding', value: sum(overall.map((o) => o.outstanding as Money)), type: 'money' }, { label: 'Advance payments', value: sum(overall.map((o) => o.advance as Money)), type: 'money' },
      { label: 'Collection rate', value: pct(sum(overall.map((o) => o.collected as Money)), sum(overall.map((o) => o.expected as Money))), type: 'percent' },
      { label: `Paid tenants (${months.length > 1 ? 'latest month' : 'month'})`, value: last.paidTenants ?? 0, type: 'number' },
      { label: 'Partially paid tenants', value: last.partialTenants ?? 0, type: 'number' }, { label: 'Unpaid tenants', value: last.unpaidTenants ?? 0, type: 'number' },
    ],
    tables, notes: ['"Collected" is what has been paid towards each month\'s rent, whenever it was received. "Advance payments received" is money received during the month for later months.'], signatures: true,
  };
}

/**
 * One month, one section per building: who paid, how much, when, and who still owes —
 * room by room — with the building's totals, cash received, advances and expenses.
 */
async function buildingMonthlyReport(ctx: Ctx): Promise<Built> {
  const month = startOfMonth(ctx.p.from);
  const monthEnd = endOfMonth(month);
  const B = ctx.p.buildingId ? ctx.buildings.filter((b) => b.id === ctx.p.buildingId) : ctx.buildings;
  const overview: Array<Record<string, unknown>> = [];
  const sections: ReportTable[] = [];
  for (const b of B) {
    const scope: Scope = { orgId: ctx.orgId, from: month, to: monthEnd, buildingId: b.id };
    const [rooms, charges, paidUp, fin, advance, occ, expenses] = await Promise.all([
      prisma.room.findMany({
        where: { buildingId: b.id }, orderBy: [{ floor: { level: 'asc' } }, { number: 'asc' }],
        include: { floor: { select: { name: true } }, contracts: { where: { status: { in: [...OCCUPYING_STATUSES] } }, select: { tenant: { select: { fullName: true, phone: true } } } } },
      }),
      prisma.rentCharge.findMany({
        where: { orgId: ctx.orgId, buildingId: b.id, period: month, status: { not: 'VOID' } },
        orderBy: { createdAt: 'asc' },
        include: {
          tenant: { select: { fullName: true, phone: true } },
          allocations: { where: { amount: { gt: 0 } }, include: { payment: { select: { businessDate: true, receipt: { select: { receiptNumber: true } } } } } },
        },
      }),
      // "Paid until": the last month each contract has fully paid, including months paid in advance.
      prisma.rentCharge.groupBy({ by: ['contractId'], where: { orgId: ctx.orgId, buildingId: b.id, status: 'PAID' }, _max: { period: true } }),
      financialByGroup(scope, 'buildingId'),
      advanceInRange(scope),
      occupancyByGroup(ctx.orgId, 'buildingId', { buildingId: b.id }),
      prisma.expense.findMany({
        where: { orgId: ctx.orgId, buildingId: b.id, status: 'APPROVED', expenseDate: { gte: month, lte: monthEnd } }, orderBy: { expenseDate: 'asc' },
        include: { category: { select: { name: true } }, room: { select: { number: true } } },
      }),
    ]);
    const paidUntil = new Map(paidUp.map((p) => [p.contractId, p._max.period]));
    const roomOf = new Map(rooms.map((r) => [r.id, r]));
    const rows = charges.map((c) => {
      const until = paidUntil.get(c.contractId);
      const r = roomOf.get(c.roomId);
      return {
        floor: r?.floor.name ?? '', room: r?.number ?? '', level: rooms.findIndex((x) => x.id === c.roomId), tenant: c.tenant.fullName, phone: c.tenant.phone,
        rent: c.amountDue, paid: c.amountPaid, balance: c.balance, status: c.status, dueDate: c.dueDate,
        paidOn: [...new Set(c.allocations.map((a) => isoDate(a.payment.businessDate)))].map((d) => longDate(new Date(`${d}T00:00:00Z`))).join(', '),
        receipts: [...new Set(c.allocations.map((a) => a.payment.receipt?.receiptNumber).filter(Boolean))].join(', '),
        paidUntil: until ? periodLabel(until) : '',
      };
    }).sort((a, b) => a.level - b.level);
    const paidRows = rows.filter((r) => r.status === 'PAID' || r.status === 'WAIVED');
    const unpaidRows = rows.filter((r) => !(r.status === 'PAID' || r.status === 'WAIVED'));
    const t = fin.get(b.id) ?? emptyRow();
    const o = occ.get(b.id) ?? sumOccupancy([]);
    const count = (st: string[]) => charges.filter((c) => st.includes(c.status)).length;
    overview.push({
      building: b.name, rooms: o.total, occupied: o.occupied, vacant: o.vacant,
      expected: t.expected, collected: t.collected, outstanding: t.outstanding, collectionRate: pct(t.collected, t.expected),
      paidTenants: count(['PAID', 'WAIVED']), partialTenants: count(['PARTIAL']), unpaidTenants: count(['UNPAID', 'OVERDUE']),
      cashReceived: t.cashReceived, advance, expenses: t.expenses, net: t.net,
    });
    sections.push({
      title: `${b.name} — tenants who paid`,
      columns: [col('floor', 'Floor'), col('room', 'Room'), col('tenant', 'Tenant'), col('phone', 'Phone'), col('rent', 'Rent expected', 'money'), col('paid', 'Money received', 'money'), col('paidOn', 'Paid on'), col('receipts', 'Receipt(s)'), col('paidUntil', 'Paid until')],
      rows: paidRows, totals: { floor: 'TOTAL', rent: sum(paidRows.map((r) => r.rent)), paid: sum(paidRows.map((r) => r.paid)) },
    });
    sections.push({
      title: `${b.name} — tenants who did not pay (or paid only part)`,
      columns: [col('floor', 'Floor'), col('room', 'Room'), col('tenant', 'Tenant'), col('phone', 'Phone'), col('rent', 'Rent expected', 'money'), col('paid', 'Money received', 'money'), col('balance', 'Still owed', 'money'), col('status', 'Status', 'status'), col('dueDate', 'Due date', 'date'), col('paidOn', 'Paid on')],
      rows: unpaidRows, totals: { floor: 'TOTAL', rent: sum(unpaidRows.map((r) => r.rent)), paid: sum(unpaidRows.map((r) => r.paid)), balance: sum(unpaidRows.map((r) => r.balance)) },
    });
    sections.push({
      title: `${b.name} — expenses`,
      columns: [col('date', 'Date', 'date'), col('number', 'No.'), col('category', 'Category'), col('room', 'Room'), col('description', 'Description'), col('amount', 'Amount', 'money')],
      rows: expenses.map((e) => ({ date: e.expenseDate, number: e.number, category: e.category.name, room: e.room?.number ?? '', description: e.description, amount: e.amount })),
      totals: { date: 'TOTAL', amount: t.expenses },
    });
  }
  const total = (k: string) => sum(overview.map((o) => o[k] as Money));
  const n = (k: string) => overview.reduce((a, o) => a + (o[k] as number), 0);
  const tot = {
    building: 'TOTAL', rooms: n('rooms'), occupied: n('occupied'), vacant: n('vacant'), expected: total('expected'), collected: total('collected'), outstanding: total('outstanding'),
    collectionRate: pct(total('collected'), total('expected')), paidTenants: n('paidTenants'), partialTenants: n('partialTenants'), unpaidTenants: n('unpaidTenants'),
    cashReceived: total('cashReceived'), advance: total('advance'), expenses: total('expenses'), net: total('net'),
  };
  return {
    period: periodLabel(month),
    summary: [
      { label: 'Money expected this month', value: tot.expected, type: 'money' }, { label: 'Money received for this month', value: tot.collected, type: 'money' },
      { label: 'Still to collect', value: tot.outstanding, type: 'money' }, { label: 'Collection rate', value: tot.collectionRate, type: 'percent' },
      { label: 'All money received in the month', value: tot.cashReceived, type: 'money' }, { label: 'Of which paid in advance', value: tot.advance, type: 'money' },
      { label: 'Expenses', value: tot.expenses, type: 'money' }, { label: 'Net income', value: tot.net, type: 'money' },
      { label: 'Tenants who paid', value: tot.paidTenants, type: 'number' }, { label: 'Paid only part', value: tot.partialTenants, type: 'number' }, { label: 'Did not pay at all', value: tot.unpaidTenants, type: 'number' },
      { label: 'Occupied rooms', value: `${tot.occupied} of ${tot.rooms}`, type: 'text' },
    ],
    tables: [
      {
        title: 'Buildings', columns: [col('building', 'Building'), col('rooms', 'Rooms', 'number'), col('occupied', 'Occupied', 'number'), col('expected', 'Money expected', 'money'), col('collected', 'Money received', 'money'), col('outstanding', 'Still to collect', 'money'), col('collectionRate', 'Collection %', 'percent'), col('paidTenants', 'Paid', 'number'), col('partialTenants', 'Partial', 'number'), col('unpaidTenants', 'Unpaid', 'number'), col('cashReceived', 'All money received', 'money'), col('advance', 'In advance', 'money'), col('expenses', 'Expenses', 'money'), col('net', 'Net income', 'money')],
        rows: overview, totals: tot,
      },
      ...sections,
    ],
    notes: [
      '"Money received for this month" is what has been paid towards this month\'s rent, whenever it was received. "All money received in the month" also includes old debts and months paid in advance.',
      '"Paid until" is the last month the tenant has fully paid, including months paid in advance.',
    ],
    signatures: true,
  };
}

async function dailyCollectionReport(ctx: Ctx): Promise<Built> {
  const where: Prisma.PaymentWhereInput = {
    orgId: ctx.orgId, businessDate: { gte: ctx.p.from, lte: ctx.p.to }, ...placeFilter(ctx.scope),
    ...(ctx.p.tenantId ? { tenantId: ctx.p.tenantId } : {}), ...(ctx.p.methodId ? { methodId: ctx.p.methodId } : {}),
  };
  const [payments, methods] = await Promise.all([
    prisma.payment.findMany({
      where, orderBy: [{ paidAt: 'asc' }],
      include: { tenant: { select: { fullName: true } }, room: { select: { number: true } }, building: { select: { name: true } }, method: true, receipt: { select: { receiptNumber: true } }, recordedBy: { select: { fullName: true } }, reverses: { select: { receipt: { select: { receiptNumber: true } } } } },
    }),
    prisma.paymentMethod.findMany({ where: { orgId: ctx.orgId }, orderBy: { sortOrder: 'asc' } }),
  ]);
  const rows = payments.map((p) => ({
    date: p.businessDate, time: p.paidAt, tenant: p.tenant.fullName, building: p.building.name, room: p.room.number, amount: p.amount, method: p.method.name,
    receipt: p.type === 'REVERSAL' ? `Reversal of ${p.reverses?.receipt?.receiptNumber ?? '—'}` : (p.receipt?.receiptNumber ?? ''),
    reference: p.reference ?? '', recordedBy: p.recordedBy.fullName,
    verified: p.type === 'REVERSAL' ? 'REVERSAL' : p.status === 'REVERSED' ? 'REVERSED' : p.verifiedAt ? 'VERIFIED' : 'PENDING',
  }));
  const byMethod = methods.map((m) => ({ method: m.name, count: payments.filter((p) => p.methodId === m.id).length, amount: sum(payments.filter((p) => p.methodId === m.id).map((p) => p.amount)) })).filter((m) => m.count > 0 || methods.find((x) => x.name === m.method)?.isActive);
  const grand = sum(payments.map((p) => p.amount));
  const unverified = payments.filter((p) => p.type === 'PAYMENT' && p.status === 'POSTED' && !p.verifiedAt).length;
  return {
    summary: [
      ...byMethod.map((m) => ({ label: m.method, value: m.amount, type: 'money' as const })),
      { label: 'Grand total', value: grand, type: 'money' }, { label: 'Transactions', value: payments.length, type: 'number' },
      { label: 'Awaiting verification', value: unverified, type: 'number' },
    ],
    tables: [
      { title: 'Totals by payment method', columns: [col('method', 'Payment method'), col('count', 'Transactions', 'number'), col('amount', 'Amount', 'money')], rows: byMethod, totals: { method: 'GRAND TOTAL', count: payments.length, amount: grand } },
      {
        title: 'Transactions',
        columns: [col('date', 'Date', 'date'), col('time', 'Recorded', 'datetime'), col('receipt', 'Receipt'), col('tenant', 'Tenant'), col('building', 'Building'), col('room', 'Room'), col('method', 'Method'), col('reference', 'Reference'), col('amount', 'Amount', 'money'), col('recordedBy', 'Recorded by'), col('verified', 'Verification', 'status')],
        rows, totals: { date: 'TOTAL', amount: grand },
      },
    ],
    notes: ['Reversals are shown as negative amounts on the day they were posted. Security deposits are not part of rent collections.'], signatures: true,
  };
}

async function arrearsReport(ctx: Ctx): Promise<Built> {
  const charges = await prisma.rentCharge.findMany({
    where: {
      orgId: ctx.orgId, balance: { gt: 0 }, status: ctx.p.paymentStatus ? (ctx.p.paymentStatus as never) : { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: ctx.today },
      ...(ctx.p.overdueOnly ? { overdueFrom: { lt: ctx.today } } : {}), ...placeFilter(ctx.scope), ...(ctx.p.tenantId ? { tenantId: ctx.p.tenantId } : {}), ...(ctx.p.contractStatus ? { contract: { status: ctx.p.contractStatus as never } } : {}),
    },
    include: { building: { select: { name: true } }, floor: { select: { name: true, level: true } }, room: { select: { number: true } }, tenant: { select: { id: true, fullName: true, phone: true } }, contract: { select: { status: true, monthlyRent: true } } },
  });
  const rows = charges.map((c) => ({
    building: c.building.name, floor: c.floor.name, room: c.room.number, tenant: c.tenant.fullName, phone: c.tenant.phone ?? '', monthlyRent: c.contract.monthlyRent,
    month: periodLabel(c.period), period: c.period, amountDue: c.amountDue, amountPaid: c.amountPaid, balance: c.balance, dueDate: c.dueDate,
    daysOverdue: Math.max(0, daysBetween(c.dueDate, ctx.today)), contractStatus: c.contract.status, tenantId: c.tenant.id,
  }));
  const sorters: Record<string, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
    balance: (a, b) => money(b.balance).comparedTo(a.balance),
    oldest: (a, b) => a.period.getTime() - b.period.getTime(),
    days: (a, b) => b.daysOverdue - a.daysOverdue,
    building: (a, b) => a.building.localeCompare(b.building) || a.room.localeCompare(b.room, undefined, { numeric: true }),
    floor: (a, b) => a.building.localeCompare(b.building) || a.floor.localeCompare(b.floor) || a.room.localeCompare(b.room, undefined, { numeric: true }),
  };
  rows.sort(sorters[ctx.p.sort ?? 'balance'] ?? sorters.balance);
  const total = sum(rows.map((r) => r.balance));
  const tenants = new Set(rows.map((r) => r.tenantId));
  const weighted = rows.reduce((a, r) => a + r.daysOverdue, 0);
  const byTenant = new Map<string, { tenant: string; phone: string; building: string; room: string; months: number; balance: Money; oldest: Date }>();
  for (const r of rows) {
    const t = byTenant.get(r.tenantId + r.room) ?? { tenant: r.tenant, phone: r.phone, building: r.building, room: r.room, months: 0, balance: ZERO, oldest: r.period };
    t.months += 1;
    t.balance = t.balance.plus(r.balance);
    if (r.period < t.oldest) t.oldest = r.period;
    byTenant.set(r.tenantId + r.room, t);
  }
  return {
    period: `Position as of ${longDate(ctx.today)}`,
    summary: [
      { label: 'Total arrears', value: total, type: 'money' }, { label: 'Tenants owing', value: tenants.size, type: 'number' },
      { label: 'Unpaid months', value: rows.length, type: 'number' }, { label: 'Average days overdue', value: rows.length ? Math.round(weighted / rows.length) : 0, type: 'number' },
    ],
    tables: [
      {
        title: 'Arrears by tenant', columns: [col('tenant', 'Tenant'), col('phone', 'Phone'), col('building', 'Building'), col('room', 'Room'), col('months', 'Months owing', 'number'), col('oldestLabel', 'Oldest debt'), col('balance', 'Total balance', 'money')],
        rows: [...byTenant.values()].sort((a, b) => b.balance.comparedTo(a.balance)).map((t) => ({ ...t, oldestLabel: periodLabel(t.oldest) })), totals: { tenant: 'TOTAL', balance: total },
      },
      {
        title: 'Arrears by month',
        columns: [col('building', 'Building'), col('floor', 'Floor'), col('room', 'Room'), col('tenant', 'Tenant'), col('phone', 'Phone'), col('monthlyRent', 'Monthly rent', 'money'), col('month', 'Billing month'), col('amountDue', 'Amount due', 'money'), col('amountPaid', 'Amount paid', 'money'), col('balance', 'Balance', 'money'), col('daysOverdue', 'Days overdue', 'number'), col('contractStatus', 'Contract', 'status')],
        rows, totals: { building: 'TOTAL', amountDue: sum(rows.map((r) => r.amountDue)), amountPaid: sum(rows.map((r) => r.amountPaid)), balance: total },
      },
    ],
    notes: [ctx.p.overdueOnly ? 'Days overdue are counted from the due date. Only rent whose grace period has passed is listed.' : 'Days overdue are counted from the due date. Only rent whose due date has passed is listed.'],
  };
}

async function occupancyReport(ctx: Ctx): Promise<Built> {
  const [byBuilding, byFloor, floors, rooms] = await Promise.all([
    occupancyByGroup(ctx.orgId, 'buildingId', ctx.p), occupancyByGroup(ctx.orgId, 'floorId', ctx.p), floorsOf(ctx),
    prisma.room.findMany({
      where: { building: { orgId: ctx.orgId }, ...(ctx.p.buildingId ? { buildingId: ctx.p.buildingId } : {}), ...(ctx.p.floorId ? { floorId: ctx.p.floorId } : {}), ...(ctx.p.roomId ? { id: ctx.p.roomId } : {}) },
      include: { building: { select: { name: true } }, floor: { select: { name: true, level: true } }, contracts: { where: { status: { in: [...OCCUPYING_STATUSES] } }, select: { contractNumber: true, endDate: true, leaseStart: true, tenant: { select: { fullName: true } } } } },
      orderBy: [{ building: { name: 'asc' } }, { floor: { level: 'asc' } }, { number: 'asc' }],
    }),
  ]);
  const B = ctx.p.buildingId ? ctx.buildings.filter((b) => b.id === ctx.p.buildingId) : ctx.buildings;
  const total = sumOccupancy([...byBuilding.values()]);
  const occCols = [col('total', 'Total rooms', 'number'), col('occupied', 'Occupied', 'number'), col('vacant', 'Vacant', 'number'), col('reserved', 'Reserved', 'number'), col('maintenance', 'Maintenance', 'number'), col('inactive', 'Inactive', 'number'), col('rate', 'Occupancy %', 'percent')];
  const vacantRent = sum(rooms.filter((r) => r.status === 'VACANT').map((r) => r.monthlyRent));
  return {
    period: `Position as of ${longDate(ctx.today)}`,
    summary: [
      { label: 'Total rooms', value: total.total, type: 'number' }, { label: 'Occupied', value: total.occupied, type: 'number' }, { label: 'Vacant', value: total.vacant, type: 'number' },
      { label: 'Reserved', value: total.reserved, type: 'number' }, { label: 'Maintenance', value: total.maintenance, type: 'number' }, { label: 'Occupancy rate', value: total.rate, type: 'percent' },
      { label: 'Monthly rent of vacant rooms', value: vacantRent, type: 'money' },
    ],
    tables: [
      { title: 'By building', columns: [col('building', 'Building'), ...occCols], rows: B.map((b) => ({ building: b.name, ...(byBuilding.get(b.id) ?? sumOccupancy([])) })), totals: { building: 'TOTAL', ...total } },
      { title: 'By floor', columns: [col('building', 'Building'), col('floor', 'Floor'), ...occCols], rows: floors.map((f) => ({ building: f.building.name, floor: f.name, ...(byFloor.get(f.id) ?? sumOccupancy([])) })) },
      {
        title: 'By room', columns: [col('building', 'Building'), col('floor', 'Floor'), col('room', 'Room'), col('type', 'Type'), col('status', 'Status', 'status'), col('monthlyRent', 'Monthly rent', 'money'), col('tenant', 'Tenant'), col('contract', 'Contract'), col('endDate', 'Contract ends', 'date')],
        rows: rooms.map((r) => ({ building: r.building.name, floor: r.floor.name, room: r.number, type: r.roomType, status: r.status, monthlyRent: r.monthlyRent, tenant: r.contracts[0]?.tenant.fullName ?? '', contract: r.contracts[0]?.contractNumber ?? '', endDate: r.contracts[0]?.leaseStart ? r.contracts[0].endDate : null })),
      },
    ],
    notes: ['Occupancy rate = occupied rooms ÷ rentable rooms (inactive rooms are excluded).'],
  };
}

async function paymentsReport(ctx: Ctx): Promise<Built> {
  const payments = await prisma.payment.findMany({
    where: { orgId: ctx.orgId, businessDate: { gte: ctx.p.from, lte: ctx.p.to }, ...placeFilter(ctx.scope), ...(ctx.p.tenantId ? { tenantId: ctx.p.tenantId } : {}), ...(ctx.p.methodId ? { methodId: ctx.p.methodId } : {}) },
    orderBy: { paidAt: 'asc' }, take: 20000,
    include: { tenant: { select: { fullName: true } }, room: { select: { number: true } }, floor: { select: { name: true } }, building: { select: { name: true } }, method: { select: { name: true } }, receipt: { select: { receiptNumber: true } }, invoice: { select: { status: true, ebmReference: true } }, recordedBy: { select: { fullName: true } }, verifiedBy: { select: { fullName: true } }, allocations: { include: { rentCharge: { select: { period: true } } } } },
  });
  const rows = payments.map((p) => ({
    date: p.businessDate, receipt: p.receipt?.receiptNumber ?? (p.type === 'REVERSAL' ? 'REVERSAL' : ''), tenant: p.tenant.fullName, building: p.building.name, floor: p.floor.name, room: p.room.number,
    method: p.method.name, reference: p.reference ?? '', amount: p.amount, allocated: p.allocatedAmount, advance: p.unallocatedAmount,
    months: [...new Set(p.allocations.filter((a) => money(a.amount).greaterThan(0)).map((a) => periodLabel(a.rentCharge.period)))].join(', '),
    status: p.type === 'REVERSAL' ? 'REVERSAL' : p.status, recordedBy: p.recordedBy.fullName, verifiedBy: p.verifiedBy?.fullName ?? '', ebm: p.invoice?.ebmReference ?? '', ebmStatus: p.invoice?.status ?? '',
  }));
  const total = sum(payments.map((p) => p.amount));
  return {
    summary: [{ label: 'Net amount received', value: total, type: 'money' }, { label: 'Transactions', value: payments.length, type: 'number' }, { label: 'Reversed payments', value: payments.filter((p) => p.status === 'REVERSED').length, type: 'number' }],
    tables: [{
      title: 'Payments',
      columns: [col('date', 'Date', 'date'), col('receipt', 'Receipt'), col('tenant', 'Tenant'), col('building', 'Building'), col('floor', 'Floor'), col('room', 'Room'), col('method', 'Method'), col('reference', 'Reference'), col('amount', 'Amount', 'money'), col('allocated', 'Allocated to rent', 'money'), col('advance', 'Unallocated advance', 'money'), col('months', 'Billing period(s)'), col('status', 'Status', 'status'), col('recordedBy', 'Recorded by'), col('verifiedBy', 'Verified by'), col('ebm', 'EBM reference'), col('ebmStatus', 'EBM status', 'status')],
      rows, totals: { date: 'TOTAL', amount: total, allocated: sum(payments.map((p) => p.allocatedAmount)), advance: sum(payments.map((p) => p.unallocatedAmount)) },
    }],
  };
}

async function rentLedgerReport(ctx: Ctx): Promise<Built> {
  const charges = await prisma.rentCharge.findMany({
    where: {
      orgId: ctx.orgId, period: { gte: startOfMonth(ctx.p.from), lte: startOfMonth(ctx.p.to) }, ...placeFilter(ctx.scope), ...(ctx.p.tenantId ? { tenantId: ctx.p.tenantId } : {}),
      ...(ctx.p.paymentStatus ? { status: ctx.p.paymentStatus as never } : { status: { not: 'VOID' } }), ...(ctx.p.contractStatus ? { contract: { status: ctx.p.contractStatus as never } } : {}),
    },
    orderBy: [{ period: 'asc' }], take: 20000,
    include: { tenant: { select: { fullName: true } }, room: { select: { number: true } }, floor: { select: { name: true } }, building: { select: { name: true } }, contract: { select: { contractNumber: true } } },
  });
  const rows = charges.map((c) => ({ month: periodLabel(c.period), building: c.building.name, floor: c.floor.name, room: c.room.number, tenant: c.tenant.fullName, contract: c.contract.contractNumber, baseAmount: c.baseAmount, adjustment: c.adjustmentAmount, amountDue: c.amountDue, amountPaid: c.amountPaid, waived: c.amountWaived, balance: c.balance, dueDate: c.dueDate, status: c.status }));
  return {
    summary: [
      { label: 'Amount due', value: sum(charges.map((c) => c.amountDue)), type: 'money' }, { label: 'Amount paid', value: sum(charges.map((c) => c.amountPaid)), type: 'money' },
      { label: 'Waived', value: sum(charges.map((c) => c.amountWaived)), type: 'money' }, { label: 'Balance', value: sum(charges.map((c) => c.balance)), type: 'money' }, { label: 'Charges', value: charges.length, type: 'number' },
    ],
    tables: [{
      title: 'Rent charges',
      columns: [col('month', 'Month'), col('building', 'Building'), col('floor', 'Floor'), col('room', 'Room'), col('tenant', 'Tenant'), col('contract', 'Contract'), col('baseAmount', 'Rent', 'money'), col('adjustment', 'Adjustment', 'money'), col('amountDue', 'Due', 'money'), col('amountPaid', 'Paid', 'money'), col('waived', 'Waived', 'money'), col('balance', 'Balance', 'money'), col('dueDate', 'Due date', 'date'), col('status', 'Status', 'status')],
      rows, totals: { month: 'TOTAL', amountDue: sum(charges.map((c) => c.amountDue)), amountPaid: sum(charges.map((c) => c.amountPaid)), waived: sum(charges.map((c) => c.amountWaived)), balance: sum(charges.map((c) => c.balance)) },
    }],
  };
}

async function expenseReport(ctx: Ctx): Promise<Built> {
  const expenses = await prisma.expense.findMany({
    where: { orgId: ctx.orgId, expenseDate: { gte: ctx.p.from, lte: ctx.p.to }, ...placeFilter(ctx.scope), status: { in: ['APPROVED', 'SUBMITTED'] } },
    orderBy: { expenseDate: 'asc' }, take: 20000,
    include: { building: { select: { name: true } }, floor: { select: { name: true } }, room: { select: { number: true } }, category: { select: { name: true } }, method: { select: { name: true } }, recordedBy: { select: { fullName: true } }, approvedBy: { select: { fullName: true } }, maintenance: { select: { number: true } } },
  });
  const approved = expenses.filter((e) => e.status === 'APPROVED');
  const total = sum(approved.map((e) => e.amount));
  const group = (key: (e: (typeof approved)[number]) => string) => {
    const m = new Map<string, { count: number; amount: Money }>();
    for (const e of approved) {
      const k = key(e);
      const g = m.get(k) ?? { count: 0, amount: ZERO };
      g.count += 1;
      g.amount = g.amount.plus(e.amount);
      m.set(k, g);
    }
    return [...m.entries()].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.amount.comparedTo(a.amount));
  };
  return {
    summary: [
      { label: 'Approved expenses', value: total, type: 'money' }, { label: 'Entries', value: approved.length, type: 'number' },
      { label: 'Awaiting approval', value: sum(expenses.filter((e) => e.status === 'SUBMITTED').map((e) => e.amount)), type: 'money' },
      { label: 'Maintenance-related', value: sum(approved.filter((e) => e.maintenanceRequestId).map((e) => e.amount)), type: 'money' },
    ],
    tables: [
      { title: 'By building', columns: [col('name', 'Building'), col('count', 'Entries', 'number'), col('amount', 'Amount', 'money')], rows: group((e) => e.building?.name ?? 'Organization-wide'), totals: { name: 'TOTAL', count: approved.length, amount: total } },
      { title: 'By category', columns: [col('name', 'Category'), col('count', 'Entries', 'number'), col('amount', 'Amount', 'money')], rows: group((e) => e.category.name), totals: { name: 'TOTAL', count: approved.length, amount: total } },
      {
        title: 'Expense entries',
        columns: [col('date', 'Date', 'date'), col('number', 'No.'), col('building', 'Building'), col('location', 'Floor / room'), col('category', 'Category'), col('description', 'Description'), col('supplier', 'Supplier'), col('method', 'Method'), col('reference', 'Reference'), col('amount', 'Amount', 'money'), col('status', 'Status', 'status'), col('maintenance', 'Maintenance'), col('recordedBy', 'Recorded by'), col('approvedBy', 'Approved by')],
        rows: expenses.map((e) => ({ date: e.expenseDate, number: e.number, building: e.building?.name ?? 'Organization-wide', location: [e.floor?.name, e.room?.number].filter(Boolean).join(' / '), category: e.category.name, description: e.description, supplier: e.supplier ?? '', method: e.method?.name ?? '', reference: e.reference ?? '', amount: e.amount, status: e.status, maintenance: e.maintenance?.number ?? '', recordedBy: e.recordedBy.fullName, approvedBy: e.approvedBy?.fullName ?? '' })),
        totals: { date: 'TOTAL (approved)', amount: total },
      },
    ],
    notes: ['Totals include approved expenses only. Entries awaiting approval are listed but not counted.'], signatures: true,
  };
}

async function maintenanceReport(ctx: Ctx): Promise<Built> {
  const requests = await prisma.maintenanceRequest.findMany({
    where: { orgId: ctx.orgId, reportedOn: { gte: ctx.p.from, lte: ctx.p.to }, ...placeFilter(ctx.scope) }, orderBy: { reportedOn: 'asc' }, take: 20000,
    include: { building: { select: { name: true } }, floor: { select: { name: true } }, room: { select: { number: true } }, assignedTo: { select: { fullName: true } }, expenses: { where: { status: 'APPROVED' }, select: { amount: true } } },
  });
  const rows = requests.map((r) => ({ number: r.number, reportedOn: r.reportedOn, building: r.building.name, location: [r.floor?.name, r.room?.number].filter(Boolean).join(' / '), title: r.title, priority: r.priority, status: r.status, assignedTo: r.assignedTo?.fullName ?? '', supplier: r.supplier ?? '', estimatedCost: r.estimatedCost, actualCost: r.actualCost, expensed: sum(r.expenses.map((e) => e.amount)), completedOn: r.completedOn }));
  const byBuilding = new Map<string, { building: string; requests: number; open: number; expensed: Money }>();
  for (const r of rows) {
    const g = byBuilding.get(r.building) ?? { building: r.building, requests: 0, open: 0, expensed: ZERO };
    g.requests += 1;
    if (!['COMPLETED', 'CANCELLED'].includes(r.status)) g.open += 1;
    g.expensed = g.expensed.plus(r.expensed);
    byBuilding.set(r.building, g);
  }
  return {
    summary: [
      { label: 'Requests', value: rows.length, type: 'number' }, { label: 'Open', value: rows.filter((r) => !['COMPLETED', 'CANCELLED'].includes(r.status)).length, type: 'number' },
      { label: 'Completed', value: rows.filter((r) => r.status === 'COMPLETED').length, type: 'number' }, { label: 'Cost recorded as expenses', value: sum(rows.map((r) => r.expensed)), type: 'money' },
    ],
    tables: [
      { title: 'By building', columns: [col('building', 'Building'), col('requests', 'Requests', 'number'), col('open', 'Open', 'number'), col('expensed', 'Cost (approved expenses)', 'money')], rows: [...byBuilding.values()].sort((a, b) => b.expensed.comparedTo(a.expensed)), totals: { building: 'TOTAL', requests: rows.length, expensed: sum(rows.map((r) => r.expensed)) } },
      {
        title: 'Requests', columns: [col('number', 'No.'), col('reportedOn', 'Reported', 'date'), col('building', 'Building'), col('location', 'Floor / room'), col('title', 'Issue'), col('priority', 'Priority', 'status'), col('status', 'Status', 'status'), col('assignedTo', 'Assigned to'), col('supplier', 'Supplier'), col('estimatedCost', 'Estimated', 'money'), col('actualCost', 'Actual', 'money'), col('expensed', 'Expensed', 'money'), col('completedOn', 'Completed', 'date')],
        rows, totals: { number: 'TOTAL', estimatedCost: sum(rows.map((r) => r.estimatedCost)), actualCost: sum(rows.map((r) => r.actualCost)), expensed: sum(rows.map((r) => r.expensed)) },
      },
    ],
  };
}

async function latePayersReport(ctx: Ctx): Promise<Built> {
  const rows = await prisma.$queryRaw<Array<{ tenantId: string; fullName: string; phone: string; late: bigint; billed: bigint; balance: Prisma.Decimal | null }>>(Prisma.sql`
    SELECT t.id AS tenantId, t.fullName, t.phone,
      COUNT(DISTINCT CASE WHEN (c.balance > 0 AND c.overdueFrom < ${ctx.today}) OR lp.rentChargeId IS NOT NULL THEN c.id END) AS late,
      COUNT(DISTINCT c.id) AS billed,
      (SELECT SUM(o.balance) FROM rent_charges o WHERE o.tenantId = t.id AND o.status IN ('UNPAID', 'PARTIAL', 'OVERDUE')) AS balance
    FROM rent_charges c
    JOIN tenants t ON t.id = c.tenantId
    LEFT JOIN (
      SELECT DISTINCT a.rentChargeId FROM payment_allocations a
      JOIN payments p ON p.id = a.paymentId JOIN rent_charges rc ON rc.id = a.rentChargeId
      WHERE a.amount > 0 AND p.status = 'POSTED' AND p.businessDate > rc.overdueFrom
    ) lp ON lp.rentChargeId = c.id
    WHERE c.orgId = ${ctx.orgId} AND c.status <> 'VOID' AND c.period BETWEEN ${startOfMonth(ctx.p.from)} AND ${startOfMonth(ctx.p.to)}
      ${ctx.p.buildingId ? Prisma.sql`AND c.buildingId = ${ctx.p.buildingId}` : Prisma.empty}
    GROUP BY t.id, t.fullName, t.phone
    HAVING late >= 2
    ORDER BY late DESC, t.fullName`);
  return {
    summary: [{ label: 'Tenants with repeated late payment', value: rows.length, type: 'number' }],
    tables: [{
      title: 'Tenants who paid late (or are still overdue) for 2 or more months',
      columns: [col('tenant', 'Tenant'), col('phone', 'Phone'), col('late', 'Months paid late', 'number'), col('billed', 'Months billed', 'number'), col('balance', 'Current balance', 'money')],
      rows: rows.map((r) => ({ tenant: r.fullName, phone: r.phone, late: Number(r.late), billed: Number(r.billed), balance: money(r.balance) })),
    }],
    notes: ['A month counts as late when a payment for it was received after the grace period ended, or it is still unpaid past the grace period.'],
  };
}

async function tenantsExport(ctx: Ctx): Promise<Built> {
  const tenants = await prisma.tenant.findMany({
    where: { orgId: ctx.orgId, ...(ctx.p.buildingId ? { contracts: { some: { buildingId: ctx.p.buildingId, status: { in: [...OCCUPYING_STATUSES] } } } } : {}) }, orderBy: { fullName: 'asc' }, take: 20000,
    include: { contracts: { where: { status: { in: [...OCCUPYING_STATUSES] } }, include: { room: { select: { number: true } }, building: { select: { name: true } }, floor: { select: { name: true } } } } },
  });
  const balances = await prisma.rentCharge.groupBy({ by: ['tenantId'], where: { orgId: ctx.orgId, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] } }, _sum: { balance: true } });
  const bal = new Map(balances.map((b) => [b.tenantId, money(b._sum.balance)]));
  return {
    period: `As of ${longDate(ctx.today)}`,
    summary: [{ label: 'Tenants', value: tenants.length, type: 'number' }, { label: 'Active', value: tenants.filter((t) => t.status === 'ACTIVE').length, type: 'number' }],
    tables: [{
      title: 'Tenants',
      columns: [col('name', 'Full name'), col('idNumber', 'ID / passport'), col('phone', 'Phone'), col('email', 'E-mail'), col('business', 'Business'), col('status', 'Status', 'status'), col('building', 'Building'), col('floor', 'Floor'), col('room', 'Room'), col('rent', 'Monthly rent', 'money'), col('balance', 'Outstanding', 'money')],
      rows: tenants.map((t) => ({ name: t.fullName, idNumber: t.idNumber, phone: t.phone, email: t.email ?? '', business: t.businessName ?? '', status: t.status, building: t.contracts.map((c) => c.building.name).join(', '), floor: t.contracts.map((c) => c.floor.name).join(', '), room: t.contracts.map((c) => c.room.number).join(', '), rent: sum(t.contracts.map((c) => c.monthlyRent)), balance: bal.get(t.id) ?? ZERO })),
    }],
  };
}

async function contractsExport(ctx: Ctx): Promise<Built> {
  const contracts = await prisma.contract.findMany({
    where: { orgId: ctx.orgId, ...placeFilter(ctx.scope), ...(ctx.p.tenantId ? { tenantId: ctx.p.tenantId } : {}), ...(ctx.p.contractStatus ? { status: ctx.p.contractStatus as never } : { status: { not: 'DRAFT' } }) },
    orderBy: { endDate: 'asc' }, take: 20000,
    include: { tenant: { select: { fullName: true, phone: true } }, room: { select: { number: true } }, floor: { select: { name: true } }, building: { select: { name: true } } },
  });
  const renewed = contracts.filter((c) => c.renewedFromId).length;
  const ended = contracts.filter((c) => ['RENEWED', 'TERMINATED'].includes(c.status)).length;
  return {
    period: `As of ${longDate(ctx.today)}`,
    summary: [
      { label: 'Contracts', value: contracts.length, type: 'number' }, { label: 'Expiring / expired', value: contracts.filter((c) => ['EXPIRING', 'EXPIRED'].includes(c.status)).length, type: 'number' },
      { label: 'Renewal rate (renewed ÷ ended)', value: ended ? contracts.filter((c) => c.status === 'RENEWED').length / ended : null, type: 'percent' }, { label: 'Contracts created by renewal', value: renewed, type: 'number' },
    ],
    tables: [{
      title: 'Contracts',
      columns: [col('number', 'Contract'), col('lease', 'Signed contract'), col('tenant', 'Tenant'), col('phone', 'Phone'), col('building', 'Building'), col('floor', 'Floor'), col('room', 'Room'), col('start', 'Start', 'date'), col('end', 'End', 'date'), col('daysLeft', 'Days to end', 'number'), col('rent', 'Monthly rent', 'money'), col('deposit', 'Deposit required', 'money'), col('status', 'Status', 'status')],
      rows: contracts.map((c) => ({ number: c.contractNumber, lease: c.leaseStart ? 'Yes' : 'Not yet', tenant: c.tenant.fullName, phone: c.tenant.phone, building: c.building.name, floor: c.floor.name, room: c.room.number, start: c.startDate, end: c.terminatedOn ?? (c.leaseStart ? c.endDate : null), daysLeft: c.leaseStart && ['ACTIVE', 'EXPIRING', 'EXPIRED'].includes(c.status) ? daysBetween(ctx.today, c.endDate) : null, rent: c.monthlyRent, deposit: c.depositAmount, status: c.status })),
    }],
  };
}

const BUILDERS: Record<ReportType, (ctx: Ctx) => Promise<Built>> = {
  building: buildingReport, consolidated: consolidatedReport, 'monthly-rent': monthlyRentReport, 'building-monthly': buildingMonthlyReport, 'daily-collection': dailyCollectionReport,
  arrears: arrearsReport, occupancy: occupancyReport, payments: paymentsReport, 'rent-ledger': rentLedgerReport, expenses: expenseReport,
  maintenance: maintenanceReport, 'late-payers': latePayersReport, tenants: tenantsExport,
  rooms: async (ctx) => {
    const built = await occupancyReport(ctx);
    return { ...built, tables: built.tables.filter((t) => t.title === 'By room').map((t) => ({ ...t, title: 'Rooms' })) };
  },
  contracts: contractsExport,
};

/** The letterhead of a report: the building's own company for a one-building report, otherwise the organization. */
async function reportIssuer(org: Awaited<ReturnType<typeof getOrg>>, buildingId: string | undefined): Promise<ReportIssuer> {
  const asUrl = (l: { data: Buffer; mime: string } | null) => (l ? `data:${l.mime};base64,${l.data.toString('base64')}` : null);
  if (buildingId) {
    const b = await prisma.building.findUniqueOrThrow({ where: { id: buildingId } });
    const place = [b.village && `Umudugudu wa ${b.village}`, b.cell && `Akagari ka ${b.cell}`, b.sector && `Umurenge wa ${b.sector}`, b.district && `Akarere ka ${b.district}`].filter(Boolean).join(', ');
    return {
      // A building without its own company details is named after itself — never after another building's company.
      name: b.companyName || b.name, building: b.name, tin: b.tin, phone: b.phone, email: b.email,
      address: place || b.address, logo: asUrl(await templateLogo(b.contractTemplate)),
    };
  }
  // Across buildings: the organization; its logo is that of the building it owns directly (same company name), if any.
  const own = await prisma.building.findFirst({ where: { orgId: org.id, companyName: org.name, contractTemplate: { not: null } }, select: { contractTemplate: true } });
  return { name: org.name, building: null, tin: org.tin, phone: org.phone, email: org.email, address: org.address, logo: asUrl(await templateLogo(own?.contractTemplate)) };
}

/** Builds a report from live data and records who generated it. */
export async function generateReport(actor: Actor, type: ReportType, p: ReportParams, format: 'screen' | 'pdf' | 'xlsx' = 'screen'): Promise<Report> {
  if (p.to < p.from) throw badRequest('The report end date is before its start date.', 'INVALID_DATES');
  if (daysBetween(p.from, p.to) > 366 * 5) throw badRequest('Choose a report period of at most five years.', 'INVALID_DATES');
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  const buildings = await prisma.building.findMany({ where: { orgId: actor.orgId }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } });
  const building = p.buildingId ? buildings.find((b) => b.id === p.buildingId) : undefined;
  if (p.buildingId && !building) throw notFound('Building');
  const [floor, room, tenant] = await Promise.all([
    p.floorId ? prisma.floor.findFirst({ where: { id: p.floorId, building: { orgId: actor.orgId } } }) : null,
    p.roomId ? prisma.room.findFirst({ where: { id: p.roomId, building: { orgId: actor.orgId } } }) : null,
    p.tenantId ? prisma.tenant.findFirst({ where: { id: p.tenantId, orgId: actor.orgId } }) : null,
  ]);
  if (p.floorId && !floor) throw notFound('Floor');
  if (p.roomId && !room) throw notFound('Room');
  if (p.tenantId && !tenant) throw notFound('Tenant');
  // A floor or room filter pins the building, so buildings can never be mixed by an inconsistent filter.
  const buildingId = room?.buildingId ?? floor?.buildingId ?? p.buildingId;
  const params: ReportParams = { ...p, buildingId: type === 'consolidated' ? undefined : buildingId };
  const scope: Scope = { orgId: actor.orgId, from: p.from, to: p.to, buildingId: params.buildingId, floorId: p.floorId, roomId: p.roomId, tenantId: p.tenantId };
  const built = await BUILDERS[type]({ actor, orgId: actor.orgId, today, p: params, scope, buildings });
  const issuer = await reportIssuer(org, params.buildingId);

  const warnings = [...(built.warnings ?? [])];
  if (REPORT_TYPES[type].financial) {
    for (const check of await reconcileCached(actor.orgId, p.from, p.to)) if (!check.ok) warnings.push(`Reconciliation warning — ${check.detail}`);
  }
  const scopeParts = [
    buildings.find((b) => b.id === params.buildingId)?.name ?? (type === 'building' ? '' : 'All buildings'),
    floor ? floor.name : '', room ? `Room ${room.number}` : '', tenant ? `Tenant: ${tenant.fullName}` : '',
  ].filter(Boolean);
  const sameMonth = isoDate(p.from) === isoDate(startOfMonth(p.from)) && isoDate(p.to) === isoDate(endOfMonth(p.from));
  const period = built.period ?? (isoDate(p.from) === isoDate(p.to) ? longDate(p.from) : sameMonth ? periodLabel(p.from) : `${longDate(p.from)} – ${longDate(p.to)}`);

  await audit(prisma, actor, {
    action: 'REPORT_GENERATED', entityType: 'Report', entityId: type,
    summary: `${REPORT_TYPES[type].title} generated (${format}) — ${scopeParts.join(', ')} — ${period}`,
    newValue: { type, format, from: isoDate(p.from), to: isoDate(p.to), buildingId: params.buildingId ?? 'ALL', floorId: p.floorId, roomId: p.roomId, tenantId: p.tenantId, methodId: p.methodId, paymentStatus: p.paymentStatus, contractStatus: p.contractStatus, groupBy: p.groupBy, sort: p.sort },
  });
  return {
    // A report on one building carries that building's own company name; reports across buildings carry the organization's.
    type, title: REPORT_TYPES[type].title, organization: issuer.name, scope: built.scope ?? scopeParts.join(' · '), period,
    generatedAt: new Date().toISOString(), preparedBy: actor.name, currency: org.currency, summary: built.summary, tables: built.tables,
    warnings, notes: built.notes ?? [], signatures: built.signatures ?? false, isDemoData: org.isDemo, issuer,
  };
}

// ───────────────────────── Dashboard & daily operations ─────────────────────────

export async function dashboard(actor: Actor, buildingId?: string) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  const monthStart = startOfMonth(today);
  const monthEnd = endOfMonth(today);
  const yesterday = addDays(today, -1);
  const place = buildingId ? { buildingId } : {};
  const scope: Scope = { orgId: actor.orgId, from: monthStart, to: monthEnd, buildingId };
  const seesMoney = actor.permissions.has('report.financial') || actor.permissions.has('payment.view');

  const [buildings, floors, occ, tenants, fin, yesterdayCash, todayCash, dueToday, overdue, partial, expiring, missingEbm, openMaint, critical, pendingExpenses, pendingApprovals, unverified, nextMonth, checks] = await Promise.all([
    prisma.building.count({ where: { orgId: actor.orgId, status: 'ACTIVE', ...(buildingId ? { id: buildingId } : {}) } }),
    prisma.floor.count({ where: { building: { orgId: actor.orgId }, ...place } }),
    occupancyByGroup(actor.orgId, 'buildingId', { buildingId }),
    prisma.contract.count({ where: { orgId: actor.orgId, status: { in: [...OCCUPYING_STATUSES] }, ...place } }),
    financialByGroup(scope, 'buildingId'),
    prisma.payment.aggregate({ where: { orgId: actor.orgId, businessDate: yesterday, ...place }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { orgId: actor.orgId, businessDate: today, ...place }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.rentCharge.aggregate({ where: { orgId: actor.orgId, dueDate: today, balance: { gt: 0 }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, ...place }, _sum: { balance: true }, _count: { _all: true } }),
    prisma.rentCharge.aggregate({ where: { orgId: actor.orgId, overdueFrom: { lt: today }, balance: { gt: 0 }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, ...place }, _sum: { balance: true }, _count: { _all: true } }),
    prisma.rentCharge.aggregate({ where: { orgId: actor.orgId, status: 'PARTIAL', ...place }, _sum: { balance: true }, _count: { _all: true } }),
    prisma.contract.count({ where: { orgId: actor.orgId, status: { in: ['EXPIRING', 'EXPIRED'] }, ...place } }),
    prisma.invoice.count({ where: missingEbmWhere(actor.orgId, buildingId) }),
    prisma.maintenanceRequest.count({ where: { orgId: actor.orgId, status: { notIn: ['COMPLETED', 'CANCELLED'] }, ...place } }),
    prisma.maintenanceRequest.count({ where: { orgId: actor.orgId, status: { notIn: ['COMPLETED', 'CANCELLED'] }, priority: 'CRITICAL', ...place } }),
    prisma.expense.count({ where: { orgId: actor.orgId, status: 'SUBMITTED', ...place } }),
    prisma.approvalRequest.count({ where: { orgId: actor.orgId, status: 'SUBMITTED' } }),
    prisma.payment.count({ where: { orgId: actor.orgId, type: 'PAYMENT', status: 'POSTED', verifiedAt: null, ...place } }),
    expectedRentForMonth(actor.orgId, addMonths(monthStart, 1), buildingId),
    actor.permissions.has('report.financial') ? reconcileCached(actor.orgId, monthStart, monthEnd) : Promise.resolve([]),
  ]);
  const o = sumOccupancy([...occ.values()]);
  const total = addRows([...fin.values()]);
  const overdueDays = await prisma.$queryRaw<Array<{ avgDays: Prisma.Decimal | number | null }>>(Prisma.sql`
    SELECT AVG(DATEDIFF(${today}, dueDate)) AS avgDays FROM rent_charges
    WHERE orgId = ${actor.orgId} AND balance > 0 AND overdueFrom < ${today} AND status IN ('UNPAID', 'PARTIAL', 'OVERDUE')
    ${buildingId ? Prisma.sql`AND buildingId = ${buildingId}` : Prisma.empty}`);

  const allBuildings = await prisma.building.findMany({ where: { orgId: actor.orgId, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const [recentPayments, recentTenants, recentContracts, recentExpenses, recentMaintenance] = await Promise.all([
    actor.permissions.has('payment.view')
      ? prisma.payment.findMany({ where: { orgId: actor.orgId, ...place }, orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, type: true, amount: true, paidAt: true, tenant: { select: { fullName: true } }, room: { select: { number: true } }, method: { select: { name: true } }, receipt: { select: { receiptNumber: true } } } })
      : [],
    actor.permissions.has('tenant.view') ? prisma.tenant.findMany({ where: { orgId: actor.orgId }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, fullName: true, createdAt: true, status: true } }) : [],
    actor.permissions.has('contract.view')
      ? prisma.contract.findMany({ where: { orgId: actor.orgId, status: { not: 'DRAFT' }, ...place }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, contractNumber: true, createdAt: true, status: true, tenant: { select: { fullName: true } }, room: { select: { number: true } } } })
      : [],
    actor.permissions.has('expense.view')
      ? prisma.expense.findMany({ where: { orgId: actor.orgId, ...place }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, number: true, description: true, amount: true, status: true, expenseDate: true, category: { select: { name: true } } } })
      : [],
    actor.permissions.has('maintenance.view')
      ? prisma.maintenanceRequest.findMany({ where: { orgId: actor.orgId, ...place }, orderBy: { updatedAt: 'desc' }, take: 5, select: { id: true, number: true, title: true, status: true, priority: true, updatedAt: true, room: { select: { number: true } }, building: { select: { name: true } } } })
      : [],
  ]);

  return {
    today: isoDate(today), month: periodLabel(monthStart), isDemoData: org.isDemo, currency: org.currency,
    property: { buildings, floors, rooms: o.total, occupied: o.occupied, vacant: o.vacant, reserved: o.reserved, maintenance: o.maintenance, tenants, occupancyRate: o.rate },
    financial: seesMoney
      ? {
          expected: total.expected, collected: total.collected, outstanding: total.outstanding, waived: total.waived, expenses: total.expenses, net: total.net,
          cashReceived: total.cashReceived, collectionRate: pct(total.collected, total.expected), collectedYesterday: money(yesterdayCash._sum.amount), paymentsYesterday: yesterdayCash._count._all,
          collectedToday: money(todayCash._sum.amount), paymentsToday: todayCash._count._all, dueToday: money(dueToday._sum.balance), dueTodayCount: dueToday._count._all,
          totalOverdue: money(overdue._sum.balance), averageDaysOverdue: overdueDays[0]?.avgDays == null ? null : Math.round(Number(overdueDays[0].avgDays)), expectedNextMonth: nextMonth,
          byBuilding: allBuildings.filter((b) => !buildingId || b.id === buildingId).map((b) => ({ id: b.id, name: b.name, ...financialCells(fin.get(b.id) ?? emptyRow()), occupancy: occ.get(b.id) ?? sumOccupancy([]) })),
        }
      : null,
    alerts: {
      overdueTenants: overdue._count._all, overdueAmount: seesMoney ? money(overdue._sum.balance) : null, partialPayments: partial._count._all,
      contractsExpiring: expiring, missingEbm, openMaintenance: openMaint, criticalMaintenance: critical, vacantRooms: o.vacant,
      pendingExpenses, pendingApprovals, unverifiedPayments: unverified,
    },
    recent: { payments: recentPayments, tenants: recentTenants, contracts: recentContracts, expenses: recentExpenses, maintenance: recentMaintenance },
    reconciliation: checks,
  };
}

/** One screen answering "what needs attention today?" */
export async function dailyOperations(actor: Actor, buildingId?: string) {
  const org = await getOrg(actor.orgId);
  const today = businessDate(org.timezone);
  const place = buildingId ? { buildingId } : {};
  const monthStart = startOfMonth(today);
  const sel = { tenant: { select: { id: true, fullName: true, phone: true } }, room: { select: { id: true, number: true } }, building: { select: { name: true } } };
  const [paidToday, methods, unpaid, pendingVerification, overdue, expiring, vacant, maintenance, missing] = await Promise.all([
    prisma.payment.findMany({ where: { orgId: actor.orgId, businessDate: today, ...place }, orderBy: { paidAt: 'desc' }, take: 100, include: { ...sel, method: { select: { name: true } }, receipt: { select: { receiptNumber: true } }, recordedBy: { select: { fullName: true } } } }),
    prisma.payment.groupBy({ by: ['methodId'], where: { orgId: actor.orgId, businessDate: today, ...place }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.rentCharge.findMany({ where: { orgId: actor.orgId, period: monthStart, balance: { gt: 0 }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, ...place }, orderBy: { balance: 'desc' }, take: 100, include: { ...sel, contract: { select: { id: true } } } }),
    prisma.payment.findMany({ where: { orgId: actor.orgId, type: 'PAYMENT', status: 'POSTED', verifiedAt: null, ...place }, orderBy: { paidAt: 'asc' }, take: 50, include: { ...sel, method: { select: { name: true } }, receipt: { select: { receiptNumber: true } }, recordedBy: { select: { fullName: true } } } }),
    prisma.rentCharge.findMany({ where: { orgId: actor.orgId, overdueFrom: { lt: today }, balance: { gt: 0 }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, ...place }, orderBy: { dueDate: 'asc' }, take: 100, include: { ...sel, contract: { select: { id: true } } } }),
    prisma.contract.findMany({ where: { orgId: actor.orgId, status: { in: ['EXPIRING', 'EXPIRED'] }, ...place }, orderBy: { endDate: 'asc' }, take: 50, include: sel }),
    prisma.room.findMany({ where: { building: { orgId: actor.orgId }, status: 'VACANT', ...place }, orderBy: [{ building: { name: 'asc' } }, { number: 'asc' }], take: 100, select: { id: true, number: true, monthlyRent: true, building: { select: { name: true } }, floor: { select: { name: true } } } }),
    prisma.maintenanceRequest.findMany({ where: { orgId: actor.orgId, status: { notIn: ['COMPLETED', 'CANCELLED'] }, ...place }, orderBy: [{ priority: 'desc' }, { reportedOn: 'asc' }], take: 50, select: { id: true, number: true, title: true, priority: true, status: true, reportedOn: true, building: { select: { name: true } }, room: { select: { number: true } } } }),
    prisma.invoice.findMany({ where: missingEbmWhere(actor.orgId, buildingId), orderBy: { issueDate: 'asc' }, take: 50, select: { id: true, invoiceNumber: true, amount: true, issueDate: true, status: true, tenant: { select: { id: true, fullName: true } }, payment: { select: { id: true, receipt: { select: { receiptNumber: true } } } } } }),
  ]);
  const methodNames = await prisma.paymentMethod.findMany({ where: { orgId: actor.orgId }, orderBy: { sortOrder: 'asc' } });
  return {
    today: isoDate(today), month: periodLabel(monthStart),
    collectedToday: sum(paidToday.map((p) => p.amount)),
    byMethod: methodNames.map((m) => ({ method: m.name, amount: money(methods.find((x) => x.methodId === m.id)?._sum.amount), count: methods.find((x) => x.methodId === m.id)?._count._all ?? 0 })).filter((m) => m.count > 0),
    paidToday, unpaidThisMonth: unpaid.map((c) => ({ ...c, isOverdue: c.overdueFrom < today })), unpaidThisMonthTotal: sum(unpaid.map((c) => c.balance)),
    pendingVerification,
    overdue: overdue.map((c) => ({ ...c, daysOverdue: daysBetween(c.dueDate, today) })), overdueTotal: sum(overdue.map((c) => c.balance)),
    contractsExpiring: expiring.map((c) => ({ ...c, daysLeft: daysBetween(today, c.endDate) })), vacantRooms: vacant, openMaintenance: maintenance, missingEbm: missing,
  };
}
