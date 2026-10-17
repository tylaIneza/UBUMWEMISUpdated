import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addDays, isoDate } from '../src/lib/dates.js';
import { submitApproval } from '../src/services/approvals.js';
import { createExpense, decideExpense } from '../src/services/expenses.js';
import { EXCEL_HEADER_ROW, reportToExcel, reportToPdf } from '../src/services/exporters.js';
import { updateInvoice } from '../src/services/invoices.js';
import { createMaintenance } from '../src/services/maintenance.js';
import { dailyOperations, dashboard, generateReport, reconcile, type Report } from '../src/services/reports.js';
import { clearReconcileCache } from '../src/services/reconcileCache.js';
import { rentLedger } from '../src/services/tenants.js';
import { createWorld, d, endOfThisMonth, lease, loginAs, makeBuilding, monthsAgo, num, pay, thisMonth, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let B: BuildingFixture[];
/** What the test itself expects, computed independently of the reporting code. */
const expected = { b: [] as Array<{ expected: number; collected: number; cash: number; expenses: number; occupied: number; rooms: number }>, orgExpenses: 0 };

const table = (r: Report, title: string) => r.tables.find((t) => t.title === title)!;
const range = () => ({ from: thisMonth(), to: endOfThisMonth() });

beforeAll(async () => {
  w = await createWorld();
  B = [await makeBuilding(w, 'A', 2, 3, 100000), await makeBuilding(w, 'B', 2, 2, 200000), await makeBuilding(w, 'C', 1, 4, 50000)];
  const acct = w.actors.ACCOUNTANT;
  for (const [i, b] of B.entries()) {
    const rooms = b.floors.flatMap((f) => f.rooms);
    const e = { expected: 0, collected: 0, cash: 0, expenses: 0, occupied: 0, rooms: rooms.length };
    // Let all rooms but the last. Tenant 0 pays in full, tenant 1 pays part, the rest pay nothing.
    for (const [j, room] of rooms.slice(0, -1).entries()) {
      const { contract } = await lease(w, room.id);
      e.expected += room.rent;
      e.occupied += 1;
      const amount = j === 0 ? room.rent : j === 1 ? 30000 + i * 1000 : 0;
      if (amount) {
        const method = j === 0 ? { methodId: w.methods.BANK, reference: `BK-${i}-${j}` } : {};
        await pay(w, 'CASHIER', contract.id, amount, method);
        e.collected += amount;
        e.cash += amount;
      }
    }
    const cost = 40000 + i * 5000;
    const exp = await createExpense(acct, { scope: 'BUILDING', buildingId: b.id, categoryId: w.categories.Electricity!, description: 'Power', amount: d(cost), expenseDate: today() });
    await decideExpense(w.actors.MANAGEMENT, exp.id, 'APPROVED');
    e.expenses += cost;
    // A submitted-but-unapproved expense must NOT count.
    await createExpense(acct, { scope: 'BUILDING', buildingId: b.id, categoryId: w.categories.Water!, description: 'Pending', amount: d(999999), expenseDate: today() });
    expected.b.push(e);
  }
  const salaries = await createExpense(acct, { scope: 'ORGANIZATION', categoryId: w.categories.Salaries!, description: 'Salaries', amount: d(300000), expenseDate: today() });
  await decideExpense(w.actors.MANAGEMENT, salaries.id, 'APPROVED');
  expected.orgExpenses = 300000;
});

describe('building report', () => {
  it('reports each building from its own records only', async () => {
    for (const [i, b] of B.entries()) {
      const r = await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), buildingId: b.id });
      const v = (label: string) => r.summary.find((s) => s.label === label)!.value;
      const e = expected.b[i]!;
      expect([num(v('Total expected rent')), num(v('Total collected')), num(v('Total outstanding')), num(v('Total expenses')), num(v('Net income'))], `building ${i}`)
        .toEqual([e.expected, e.collected, e.expected - e.collected, e.expenses, e.collected - e.expenses]);
      expect([v('Total rooms'), v('Occupied rooms'), v('Vacant rooms'), v('Total floors')]).toEqual([e.rooms, e.occupied, e.rooms - e.occupied, b.floors.length]);
      expect(v('Occupancy rate')).toBeCloseTo(e.occupied / e.rooms, 10);
      expect(r.scope).toBe(`Building ${['A', 'B', 'C'][i]}`);
      expect(r.warnings).toEqual([]);
    }
  });

  it('equals the sum of its floors and the sum of its rooms', async () => {
    const r = await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), buildingId: B[0]!.id });
    for (const title of ['By floor', 'By room']) {
      const t = table(r, title);
      for (const key of ['expected', 'collected', 'outstanding', 'expenses', 'net', 'cashReceived']) {
        const rows = t.rows.reduce((a, row) => a + num(row[key]), 0);
        expect(rows, `${title} ${key}`).toBe(num(t.totals![key]));
      }
      expect(num(t.totals!.expected)).toBe(expected.b[0]!.expected);
    }
  });

  it('narrows correctly to one floor and one room without mixing in others', async () => {
    const floor = B[0]!.floors[0]!;
    const byFloor = await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), floorId: floor.id });
    const floorRooms = table(byFloor, 'By room').rows;
    expect(floorRooms.map((r) => r.room)).toEqual(floor.rooms.map((r) => r.number));
    expect(byFloor.scope).toContain('Building A');

    const room = floor.rooms[1]!;
    const byRoom = await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), roomId: room.id });
    const rows = table(byRoom, 'By room').rows;
    expect(rows).toHaveLength(1);
    expect([num(rows[0]!.expected), num(rows[0]!.collected), num(rows[0]!.outstanding)]).toEqual([room.rent, 30000, room.rent - 30000]);
  });
});

describe('consolidated report', () => {
  it('equals the sum of the three building reports (plus organization-wide expenses)', async () => {
    const all = await generateReport(w.actors.MANAGEMENT, 'consolidated', range());
    const t = table(all, 'Financial summary by building');
    const sums = { expected: 0, collected: 0, outstanding: 0, expenses: 0, net: 0, cashReceived: 0 };
    for (const b of B) {
      const single = await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), buildingId: b.id });
      const tot = table(single, 'By room').totals!;
      const row = t.rows.find((r) => r.building === single.scope)!;
      for (const key of Object.keys(sums) as Array<keyof typeof sums>) {
        expect(num(row[key]), `${single.scope} ${key}`).toBe(num(tot[key]));
        sums[key] += num(tot[key]);
      }
    }
    const tot = t.totals!;
    expect(num(tot.expected)).toBe(sums.expected);
    expect(num(tot.collected)).toBe(sums.collected);
    expect(num(tot.outstanding)).toBe(sums.outstanding);
    expect(num(tot.cashReceived)).toBe(sums.cashReceived);
    expect(num(tot.expenses)).toBe(sums.expenses + expected.orgExpenses);
    expect(num(tot.net)).toBe(sums.net - expected.orgExpenses);
    // …and matches what the test computed by hand.
    expect(num(tot.expected)).toBe(expected.b.reduce((a, e) => a + e.expected, 0));
    expect(num(tot.collected)).toBe(expected.b.reduce((a, e) => a + e.collected, 0));
    expect(all.warnings).toEqual([]);
    expect(all.scope).toBe('All buildings');
  });

  it('breaks cash down by payment method and totals back to cash received', async () => {
    const all = await generateReport(w.actors.MANAGEMENT, 'consolidated', range());
    const t = table(all, 'Cash received by payment method');
    const cash = t.columns.find((c) => c.label === 'Cash')!.key;
    const bank = t.columns.find((c) => c.label === 'Bank')!.key;
    expect(num(t.totals![bank])).toBe(B.reduce((a, b) => a + b.floors[0]!.rooms[0]!.rent, 0));
    expect(num(t.totals![cash]) + num(t.totals![bank])).toBe(num(t.totals!.total));
    expect(num(t.totals!.total)).toBe(expected.b.reduce((a, e) => a + e.cash, 0));
    const occ = table(all, 'Occupancy and tenants');
    expect([occ.totals!.total, occ.totals!.occupied, occ.totals!.tenants]).toEqual([14, 11, 11]);
  });

  it('ignores a building filter rather than silently reporting one building as "all"', async () => {
    const all = await generateReport(w.actors.MANAGEMENT, 'consolidated', { ...range(), buildingId: B[1]!.id });
    expect(table(all, 'Financial summary by building').rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe('monthly, arrears and daily reports', () => {
  it('monthly rent report: expected, collected, outstanding and paid/partial/unpaid counts per building', async () => {
    const r = await generateReport(w.actors.MANAGEMENT, 'monthly-rent', range());
    const t = r.tables[0]!;
    for (const [i, e] of expected.b.entries()) {
      const row = t.rows[i]!;
      expect([num(row.expected), num(row.collected), num(row.outstanding)]).toEqual([e.expected, e.collected, e.expected - e.collected]);
      expect([row.paidTenants, row.partialTenants, row.unpaidTenants]).toEqual([1, 1, e.occupied - 2]);
      expect(row.collectionRate).toBeCloseTo(e.collected / e.expected, 10);
    }
    expect(num(t.totals!.expected)).toBe(expected.b.reduce((a, e) => a + e.expected, 0));
    expect(t.totals!.paidTenants).toBe(3);
  });

  it('arrears report lists exactly what is owed, largest balance first', async () => {
    // Make some older debt so there is something past due.
    const spare = B[2]!.floors[0]!.rooms.at(-1)!;
    const { contract, tenant } = await lease(w, spare.id, 2);
    await pay(w, 'CASHIER', contract.id, 20000);
    const r = await generateReport(w.actors.MANAGEMENT, 'arrears', range());
    const rows = table(r, 'Arrears by month').rows.filter((x) => x.tenant === tenant.fullName);
    // Two months ago and last month are past due; this month only once its due date has passed.
    const pastDue = await prisma.rentCharge.count({ where: { contractId: contract.id, dueDate: { lt: today() } } });
    expect(rows.map((x) => [num(x.amountDue), num(x.amountPaid), num(x.balance)]).sort((a, b) => a[2]! - b[2]! || a[1]! - b[1]!))
      .toEqual([[spare.rent, 20000, spare.rent - 20000], ...Array.from({ length: pastDue - 1 }, () => [spare.rent, 0, spare.rent])]);
    expect(rows.every((x) => (x.daysOverdue as number) > 0 && x.phone === tenant.phone && x.room === spare.number)).toBe(true);
    const balances = table(r, 'Arrears by month').rows.map((x) => num(x.balance));
    expect(balances).toEqual([...balances].sort((a, b) => b - a));
    const open = await prisma.rentCharge.aggregate({ where: { orgId: w.orgId, balance: { gt: 0 }, status: { in: ['UNPAID', 'PARTIAL', 'OVERDUE'] }, dueDate: { lt: today() } }, _sum: { balance: true } });
    expect(num(r.summary.find((s) => s.label === 'Total arrears')!.value)).toBe(num(open._sum.balance));
    const oldest = await generateReport(w.actors.MANAGEMENT, 'arrears', { ...range(), sort: 'oldest', buildingId: B[2]!.id });
    expect(table(oldest, 'Arrears by month').rows[0]!.tenant).toBe(tenant.fullName);
    expect(table(oldest, 'Arrears by month').rows.every((x) => x.building === 'Building C')).toBe(true);
  });

  it('arrears report matches the Unpaid & overdue page, also with "overdue only"', async () => {
    const page = 1, pageSize = 200;
    for (const overdueOnly of [false, true]) {
      const r = await generateReport(w.actors.MANAGEMENT, 'arrears', { ...range(), overdueOnly });
      const list = await rentLedger(w.orgId, { owingOnly: true, overdueOnly }, { page, pageSize });
      const key = (tenant: unknown, balance: unknown) => `${String(tenant)}|${num(balance as never)}`;
      expect(table(r, 'Arrears by month').rows.map((x) => key(x.tenant, x.balance)).sort(), String(overdueOnly))
        .toEqual(list.items.map((c) => key(c.tenant.fullName, c.balance)).sort());
    }
  });

  it('daily collection report totals by method and shows reversals as negatives', async () => {
    const before = await generateReport(w.actors.MANAGEMENT, 'daily-collection', { from: today(), to: today() });
    const grand = (r: Report) => num(r.summary.find((s) => s.label === 'Grand total')!.value);
    const posted = await prisma.payment.aggregate({ where: { businessDate: today() }, _sum: { amount: true } });
    expect(grand(before)).toBe(num(posted._sum.amount));
    const methods = table(before, 'Totals by payment method');
    expect(methods.rows.reduce((a, m) => a + num(m.amount), 0)).toBe(grand(before));

    const victim = await prisma.payment.findFirstOrThrow({ where: { type: 'PAYMENT', status: 'POSTED' } });
    const req = await submitApproval(w.actors.MANAGEMENT, { type: 'PAYMENT_REVERSAL', entityType: 'Payment', entityId: victim.id, summary: 'rev', reason: 'Duplicate entry', payload: {} });
    expect(req.executed).toBe(true);
    const after = await generateReport(w.actors.MANAGEMENT, 'daily-collection', { from: today(), to: today() });
    expect(grand(after)).toBe(grand(before) - num(victim.amount));
    const lines = table(after, 'Transactions').rows;
    expect(lines.filter((l) => l.verified === 'REVERSAL').map((l) => num(l.amount))).toEqual([-num(victim.amount)]);
    expect(lines.filter((l) => l.verified === 'REVERSED')).toHaveLength(1);
    expect((await reconcile(w.orgId, monthsAgo(3), endOfThisMonth())).filter((c) => !c.ok)).toEqual([]);
  });
});

describe('expenses, maintenance and EBM', () => {
  it('links a maintenance cost to an expense and shows it in both reports', async () => {
    const room = B[0]!.floors[0]!.rooms[0]!;
    const request = await createMaintenance(w.actors.PROPERTY_STAFF, { buildingId: B[0]!.id, roomId: room.id, title: 'Burst pipe', priority: 'HIGH' });
    const cost = await createExpense(w.actors.ACCOUNTANT, { scope: 'ROOM', roomId: room.id, categoryId: w.categories.Repairs!, description: 'Pipe repair', amount: d(25000), expenseDate: today(), maintenanceRequestId: request.id });
    const before = await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), buildingId: B[0]!.id });
    await decideExpense(w.actors.MANAGEMENT, cost.id, 'APPROVED');
    const after = await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), buildingId: B[0]!.id });
    const exp = (r: Report) => num(r.summary.find((s) => s.label === 'Total expenses')!.value);
    expect(exp(after)).toBe(exp(before) + 25000);

    const maint = await generateReport(w.actors.MANAGEMENT, 'maintenance', range());
    expect(num(table(maint, 'Requests').rows.find((r) => r.number === request.number)!.expensed)).toBe(25000);
    const expenses = await generateReport(w.actors.MANAGEMENT, 'expenses', { ...range(), buildingId: B[0]!.id });
    const entry = table(expenses, 'Expense entries').rows.find((r) => r.description === 'Pipe repair')!;
    expect([entry.maintenance, entry.building, entry.location]).toEqual([request.number, 'Building A', `Floor 0 / ${room.number}`]);
    expect(num(expenses.summary.find((s) => s.label === 'Maintenance-related')!.value)).toBe(25000);
    // Voiding the expense removes it from the totals again; the record itself remains.
    await decideExpense(w.actors.MANAGEMENT, cost.id, 'VOID', 'Entered twice');
    expect(exp(await generateReport(w.actors.MANAGEMENT, 'building', { ...range(), buildingId: B[0]!.id }))).toBe(exp(before));
    expect((await prisma.expense.findUniqueOrThrow({ where: { id: cost.id } })).status).toBe('VOID');
  });

  it('refuses an expense whose scope does not match its location', async () => {
    const mismatch = prisma.expense.create({ data: { orgId: w.orgId, number: 'X-1', scope: 'ORGANIZATION', buildingId: B[0]!.id, categoryId: w.categories.Other!, description: 'x', amount: 5, expenseDate: today(), recordedById: w.actors.ACCOUNTANT.userId } });
    await expect(mismatch).rejects.toThrow();
  });

  it('counts payments with no EBM reference and clears the alert when one is recorded', async () => {
    const before = (await dashboard(w.actors.MANAGEMENT)).alerts.missingEbm;
    expect(before).toBeGreaterThan(0);
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { status: 'PENDING', payment: { status: 'POSTED' } } });
    await expect(updateInvoice(w.actors.ACCOUNTANT, invoice.id, { status: 'ISSUED' })).rejects.toThrow(/EBM reference/);
    await updateInvoice(w.actors.ACCOUNTANT, invoice.id, { status: 'ISSUED', ebmReference: 'EBM-TEST-1' });
    expect((await dashboard(w.actors.MANAGEMENT)).alerts.missingEbm).toBe(before - 1);
    const other = await prisma.invoice.findFirstOrThrow({ where: { status: 'PENDING', payment: { status: 'POSTED' } } });
    await expect(updateInvoice(w.actors.ACCOUNTANT, other.id, { status: 'ISSUED', ebmReference: 'EBM-TEST-1' })).rejects.toThrow();
  });
});

describe('dashboard and reconciliation', () => {
  it('computes dashboard figures from the database and respects the building filter', async () => {
    const all = await dashboard(w.actors.MANAGEMENT);
    const one = await dashboard(w.actors.MANAGEMENT, B[1]!.id);
    const charges = await prisma.rentCharge.aggregate({ where: { period: thisMonth(), status: { not: 'VOID' } }, _sum: { amountDue: true, amountPaid: true, balance: true } });
    expect([num(all.financial!.expected), num(all.financial!.collected), num(all.financial!.outstanding)]).toEqual([num(charges._sum.amountDue), num(charges._sum.amountPaid), num(charges._sum.balance)]);
    expect([one.property.rooms, one.property.occupied, one.property.buildings]).toEqual([expected.b[1]!.rooms, expected.b[1]!.occupied, 1]);
    expect(num(one.financial!.expected)).toBe(expected.b[1]!.expected);
    expect(all.financial!.byBuilding.reduce((a, b) => a + num(b.expected), 0)).toBe(num(all.financial!.expected));
    expect(all.reconciliation.every((c) => c.ok)).toBe(true);
    expect(all.isDemoData).toBe(false);
    const ops = await dailyOperations(w.actors.MANAGEMENT, B[1]!.id);
    expect(ops.unpaidThisMonth.every((c) => c.building.name === 'Building B')).toBe(true);
    expect(num(ops.collectedToday)).toBe(ops.paidToday.reduce((a, p) => a + num(p.amount), 0));
  });

  it('raises a reconciliation warning when the books do not agree', async () => {
    // Simulate corruption that bypasses the application (direct SQL with the integrity check disabled is not
    // possible, so desynchronise a room's status instead — the kind of drift the check exists to catch).
    const room = await prisma.room.findFirstOrThrow({ where: { status: 'OCCUPIED' } });
    await prisma.room.update({ where: { id: room.id }, data: { status: 'VACANT' } });
    const checks = await reconcile(w.orgId, thisMonth(), endOfThisMonth());
    expect(checks.find((c) => c.name === 'Room status matches contracts')).toMatchObject({ ok: false });
    clearReconcileCache(w.orgId); // the dashboard and reports reuse the checks for a minute
    const report = await generateReport(w.actors.MANAGEMENT, 'consolidated', range());
    expect(report.warnings.join(' ')).toMatch(/Reconciliation warning/);
    await prisma.room.update({ where: { id: room.id }, data: { status: 'OCCUPIED' } });
    expect((await reconcile(w.orgId, thisMonth(), endOfThisMonth())).every((c) => c.ok)).toBe(true);
  });

  it('cannot be desynchronised at ledger level: the database rejects an inconsistent charge', async () => {
    const charge = await prisma.rentCharge.findFirstOrThrow({ where: { status: 'PARTIAL' } });
    await expect(prisma.rentCharge.update({ where: { id: charge.id }, data: { status: 'PAID' } })).rejects.toThrow();
    await expect(prisma.rentCharge.update({ where: { id: charge.id }, data: { balance: 0 } })).rejects.toThrow();
    await expect(prisma.rentCharge.update({ where: { id: charge.id }, data: { amountPaid: { increment: 1 } } })).rejects.toThrow();
  });
});

describe('exports and report audit', () => {
  it('produces a real PDF and a real Excel workbook with the same totals as the screen', async () => {
    const report = await generateReport(w.actors.MANAGEMENT, 'consolidated', range());
    const pdf = await reportToPdf(report);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(3000);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await reportToExcel(report)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual(expect.arrayContaining(['Summary', 'Financial summary by building', 'Expenses by category']));
    const sheet = wb.getWorksheet('Financial summary by building')!;
    const header = (sheet.getRow(EXCEL_HEADER_ROW).values as unknown[]).slice(1);
    expect(header.slice(0, 3)).toEqual(['Building', 'Expected rent (RWF)', 'Collected (RWF)']);
    const last = sheet.getRow(sheet.rowCount);
    const totals = table(report, 'Financial summary by building').totals!;
    expect([last.getCell(1).value, last.getCell(2).value, last.getCell(3).value]).toEqual(['TOTAL', num(totals.expected), num(totals.collected)]);
    expect(typeof last.getCell(2).value).toBe('number');
    expect(last.getCell(2).numFmt).toContain('#,##0');
    const summary = wb.getWorksheet('Summary')!;
    expect(summary.getCell('B1').value).toBe('Test Properties');
    expect(sheet.getCell(1, 1).value).toBe('Test Properties');
  });

  it('serves exports over HTTP with the right content types and enforces export permission', async () => {
    const manager = await loginAs(w.emails.MANAGEMENT);
    const q = `from=${isoDate(thisMonth())}&to=${isoDate(endOfThisMonth())}`;
    for (const type of ['consolidated', 'arrears', 'daily-collection', 'monthly-rent', 'occupancy', 'payments', 'rent-ledger', 'expenses', 'maintenance', 'late-payers', 'tenants', 'rooms', 'contracts']) {
      const screen = await manager.get(`/reports/${type}?${q}`);
      expect(screen.status, type).toBe(200);
      const pdf = await manager.get(`/reports/${type}/export?format=pdf&${q}`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect([pdf.status, pdf.headers['content-type']], type).toEqual([200, 'application/pdf']);
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const xlsx = await manager.get(`/reports/building/export?format=xlsx&buildingId=${B[0]!.id}&${q}`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((await manager.get(`/reports/building?${q}`)).body.error.code).toBe('BUILDING_REQUIRED');
    expect((await manager.get(`/reports/nonsense?${q}`)).status).toBe(404);
    expect((await manager.get(`/reports/consolidated?from=2026-05-01&to=2026-01-01`)).status).toBe(400);
  });

  it('records who generated which report, with its filters', async () => {
    await generateReport(w.actors.ACCOUNTANT, 'arrears', { ...range(), buildingId: B[2]!.id }, 'pdf');
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REPORT_GENERATED', userId: w.actors.ACCOUNTANT.userId }, orderBy: { id: 'desc' } });
    expect(log.entityId).toBe('arrears');
    expect(log.newValue).toMatchObject({ type: 'arrears', format: 'pdf', buildingId: B[2]!.id, from: isoDate(thisMonth()) });
  });
});

describe('date-range handling', () => {
  it('assigns payments to the business day in the organization time zone', async () => {
    const room = B[1]!.floors[1]!.rooms.at(-1)!;
    const { contract } = await lease(w, room.id, 1);
    // 22:30 UTC is already the next calendar day in Kigali (UTC+2).
    const lateUtc = new Date(Date.UTC(today().getUTCFullYear(), today().getUTCMonth(), today().getUTCDate()) - 1.5 * 3_600_000);
    const p = await pay(w, 'CASHIER', contract.id, 1000, { paidAt: lateUtc });
    expect(isoDate(p.businessDate)).toBe(isoDate(today()));
    expect(isoDate(addDays(p.businessDate, -1))).toBe(lateUtc.toISOString().slice(0, 10));
  });
});
