/**
 * Final user-acceptance scenario (specification §93), driven entirely through the HTTP
 * API exactly as the web application uses it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addMonths, endOfMonth, isoDate } from '../src/lib/dates.js';
import { createWorld, endOfThisMonth, loginAs, num, tenantDetails, thisMonth, today, uid, unpaidThisMonth, type Session, type World } from './helpers.js';

let w: World;
let admin: Session;
let manager: Session;
let cashier: Session;

const buildings: Array<{ id: string; name: string; floors: Array<{ id: string; rooms: Array<{ id: string; number: string; rent: number }> }> }> = [];
const range = () => `from=${isoDate(thisMonth())}&to=${isoDate(endOfThisMonth())}`;
const ok = (res: { status: number; body: unknown }, status = 201) => {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
};

let room: { id: string; number: string; rent: number };
let tenantId: string;
let contractId: string;

beforeAll(async () => {
  w = await createWorld();
  admin = await loginAs(w.emails.SUPER_ADMIN);
  manager = await loginAs(w.emails.MANAGEMENT);
  cashier = await loginAs(w.emails.CASHIER);
});

describe('acceptance scenario', () => {
  it('creates 3 buildings, each with several floors and rooms that all have different rents', async () => {
    let rent = 150000;
    for (const [i, name] of ['Building 1', 'Building 2', 'Building 3'].entries()) {
      const building = ok(await admin.post('/buildings', { code: `B${i + 1}`, name }));
      const floors = [];
      for (let level = 0; level < 3; level += 1) {
        const floor = ok(await admin.post('/floors', { buildingId: building.id, name: `Floor ${level + 1}`, level }));
        const rooms = [];
        for (let n = 1; n <= 3; n += 1) {
          const number = `${level + 1}0${n}`;
          const created = ok(await admin.post('/rooms', { buildingId: building.id, floorId: floor.id, number, monthlyRent: rent, depositRequired: rent }));
          rooms.push({ id: created.id, number, rent });
          rent += 5000;
        }
        floors.push({ id: floor.id, rooms });
      }
      buildings.push({ id: building.id, name, floors });
    }
    const listed = ok(await admin.get('/buildings'), 200).items;
    expect(listed.map((b: any) => [b.name, b.floorCount, b.totalRooms])).toEqual([['Building 1', 3, 3 * 3], ['Building 2', 3, 9], ['Building 3', 3, 9]]);
    const rents = buildings.flatMap((b) => b.floors.flatMap((f) => f.rooms.map((r) => r.rent)));
    expect(new Set(rents).size).toBe(27);
    room = buildings[0]!.floors[0]!.rooms[0]!; // 150,000 RWF
  });

  it('registers a tenant and assigns an available room; the rent comes from the room', async () => {
    tenantId = ok(await manager.post('/tenants', { fullName: 'John Doe', idNumber: '1199080012345678', phone: '+250788111222', businessName: 'Doe Electronics', ...tenantDetails() })).id;
    const available = ok(await manager.get(`/rooms?available=true&buildingId=${buildings[0]!.id}&floorId=${buildings[0]!.floors[0]!.id}`), 200);
    expect(available.items.map((r: any) => r.number)).toEqual(['101', '102', '103']);
    // No rent is sent: the system takes it from the room.
    const contract = ok(await manager.post('/contracts', { tenantId, roomId: room.id, startDate: isoDate(thisMonth()), endDate: isoDate(endOfMonth(addMonths(thisMonth(), 11))) }));
    contractId = contract.id;
    expect([num(contract.monthlyRent), contract.status]).toEqual([150000, 'ACTIVE']);
    expect(contract.contractNumber).toMatch(/^CTR-\d{4}-\d{6}$/);
    // The room is no longer offered for assignment.
    const now = ok(await manager.get(`/rooms?available=true&floorId=${buildings[0]!.floors[0]!.id}`), 200);
    expect(now.items.map((r: any) => r.number)).toEqual(['102', '103']);
  });

  it('generated the monthly rent charge', async () => {
    const ledger = ok(await manager.get(`/rent/charges?contractId=${contractId}`), 200);
    expect(ledger.items).toHaveLength(1);
    expect([num(ledger.items[0].amountDue), num(ledger.items[0].balance), ledger.items[0].status, ledger.items[0].period.slice(0, 10)]).toEqual([150000, 150000, unpaidThisMonth(), isoDate(thisMonth())]);
  });

  it('records 50,000 then 100,000 and the ledger shows both payments and a zero balance', async () => {
    const pay = (amount: number) => cashier.post('/payments', { contractId, amount, methodId: w.methods.CASH, idempotencyKey: uid('uat') });
    const first = ok(await pay(50000));
    expect(first.receipt.receiptNumber).toMatch(/^REC-\d{4}-000001$/);
    let charge = ok(await manager.get(`/rent/charges?contractId=${contractId}`), 200).items[0];
    expect([num(charge.amountPaid), num(charge.balance), charge.status]).toEqual([50000, 100000, 'PARTIAL']);

    const preview = ok(await cashier.post('/payments/preview', { contractId, amount: 100000 }), 200);
    expect([num(preview.plan.outstandingBefore), num(preview.plan.lines[0].applied), num(preview.plan.outstandingAfter), preview.overpaid]).toEqual([100000, 100000, 0, false]);
    ok(await pay(100000));
    charge = ok(await manager.get(`/rent/charges?contractId=${contractId}`), 200).items[0];
    expect([num(charge.amountPaid), num(charge.balance), charge.status]).toEqual([150000, 0, 'PAID']);
    expect(charge.allocations.map((a: any) => [num(a.amount), a.payment.receipt.receiptNumber.slice(-6)])).toEqual([[50000, '000001'], [100000, '000002']]);
  });

  it('refuses to pay more than is outstanding unless it is explicitly an authorised advance', async () => {
    const body = { contractId, amount: 60000, methodId: w.methods.CASH, idempotencyKey: uid('uat') };
    const rejected = await cashier.post('/payments', body);
    expect([rejected.status, rejected.body.error.code]).toEqual([409, 'OVERPAYMENT']);
    expect(num(rejected.body.error.details.excess)).toBe(60000);
    expect((await cashier.post('/payments', { ...body, overpayment: 'ADVANCE' })).status).toBe(403);
    expect(ok(await manager.get(`/payments?contractId=${contractId}`), 200).total).toBe(2);

    const advance = ok(await manager.post('/payments', { ...body, idempotencyKey: uid('uat'), overpayment: 'ADVANCE' }));
    expect(advance.allocations.map((a: any) => [num(a.amount), a.rentCharge.period.slice(0, 10)])).toEqual([[60000, isoDate(addMonths(thisMonth(), 1))]]);
    const detail = ok(await manager.get(`/tenants/${tenantId}`), 200);
    expect(num(detail.financial.totalPaid)).toBe(210000);
  });

  it('blocks assigning another tenant to the occupied room', async () => {
    const other = ok(await manager.post('/tenants', { fullName: 'Jane Roe', idNumber: '1199170087654321', phone: '+250788333444', ...tenantDetails() }));
    const res = await manager.post('/contracts', { tenantId: other.id, roomId: room.id, startDate: isoDate(today()), endDate: isoDate(endOfMonth(addMonths(thisMonth(), 6))) });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ROOM_OCCUPIED', message: 'This room is already occupied. An active contract already exists for this room.' });
  });

  let secondContractId: string;
  it('terminates the first contract, the room becomes vacant, and a new tenant can be assigned', async () => {
    const ended = ok(await manager.post(`/contracts/${contractId}/terminate`, { moveOutDate: isoDate(today()), reason: 'Relocating', roomCondition: 'Clean' }), 200);
    expect(ended.status).toBe('TERMINATED');
    expect(ok(await manager.get(`/rooms/${room.id}`), 200).status).toBe('VACANT');
    const jane = ok(await manager.get('/tenants?q=Jane'), 200).items[0];
    const start = new Date(today().getTime() + 86_400_000);
    const second = ok(await manager.post('/contracts', { tenantId: jane.id, roomId: room.id, startDate: isoDate(start), endDate: isoDate(endOfMonth(addMonths(start, 11))) }));
    secondContractId = second.id;
    expect(ok(await manager.get(`/rooms/${room.id}`), 200)).toMatchObject({ status: 'OCCUPIED', currentContract: { id: second.id } });
  });

  it("keeps the previous tenant's complete history", async () => {
    const john = ok(await manager.get(`/tenants/${tenantId}`), 200);
    expect([john.status, john.contracts.length, john.contracts[0].status, john.currentContracts.length]).toEqual(['FORMER', 1, 'TERMINATED', 0]);
    const payments = ok(await manager.get(`/payments?tenantId=${tenantId}`), 200);
    expect(payments.items.map((p: any) => num(p.amount)).sort((a: number, b: number) => a - b)).toEqual([50000, 60000, 100000]);
    const roomDetail = ok(await manager.get(`/rooms/${room.id}`), 200);
    expect(roomDetail.contracts.map((c: any) => c.tenant.fullName).sort()).toEqual(['Jane Roe', 'John Doe']);
    const history = ok(await manager.get(`/timeline?entityType=Room&entityId=${room.id}`), 200).items.map((t: any) => t.action);
    expect(history).toEqual(expect.arrayContaining(['ROOM_CREATED', 'CONTRACT_CREATED', 'PAYMENT_RECORDED', 'ADVANCE_PAYMENT_RECORDED', 'CONTRACT_TERMINATED']));
    // The advance for next month was released as credit when the contract ended early (nothing lost).
    const contract = ok(await manager.get(`/contracts/${contractId}`), 200);
    expect([num(contract.summary.totalPaid), num(contract.summary.credit), num(contract.summary.outstanding)]).toEqual([150000, 60000, 0]);
    expect(secondContractId).toBeTruthy();
  });

  it('room, floor, building and all-building reports reconcile with each other', async () => {
    const b1 = buildings[0]!;
    const sumOf = (report: any, title: string) => report.tables.find((t: any) => t.title === title).totals;
    const roomReport = ok(await manager.get(`/reports/building?${range()}&roomId=${room.id}`), 200);
    const floorReport = ok(await manager.get(`/reports/building?${range()}&floorId=${b1.floors[0]!.id}`), 200);
    const buildingReport = ok(await manager.get(`/reports/building?${range()}&buildingId=${b1.id}`), 200);
    const allReport = ok(await manager.get(`/reports/consolidated?${range()}`), 200);

    const r = sumOf(roomReport, 'By room');
    const f = sumOf(floorReport, 'By room');
    const b = sumOf(buildingReport, 'By room');
    const all = sumOf(allReport, 'Financial summary by building');
    // The room changed tenant during the month: the outgoing tenant's month (paid) plus the incoming
    // tenant's share of the month by days (unpaid) — never two full months for one room.
    const incoming = ok(await manager.get(`/rent/charges?contractId=${secondContractId}`), 200).items[0];
    const days = new Date(today().getTime()).getUTCDate();
    const daysInMonth = endOfThisMonth().getUTCDate();
    expect(num(incoming.amountDue)).toBe(Math.round((150000 * (daysInMonth - days)) / daysInMonth));
    expect(num(incoming.amountDue)).toBeLessThan(150000);
    const due = num(incoming.amountDue);
    // Only this room has activity, so room, floor, building and all-building levels must show the same money.
    for (const level of [r, f, b, all]) expect([num(level.expected), num(level.collected), num(level.outstanding), num(level.cashReceived)]).toEqual([150000 + due, 150000, due, 210000]);
    const floorRows = buildingReport.tables.find((t: any) => t.title === 'By floor').rows;
    expect(floorRows.reduce((a: number, x: any) => a + num(x.collected), 0)).toBe(num(b.collected));
    const buildingRows = allReport.tables.find((t: any) => t.title === 'Financial summary by building').rows;
    expect(buildingRows.map((x: any) => num(x.collected))).toEqual([150000, 0, 0]);
    for (const report of [roomReport, floorReport, buildingReport, allReport]) expect(report.warnings).toEqual([]);
    expect(ok(await manager.get(`/dashboard/reconciliation?${range()}`), 200).every((c: any) => c.ok)).toBe(true);
  });

  let expenseId: string;
  it('creates an expense and it appears in the building expense report once approved', async () => {
    const b2 = buildings[1]!;
    const expense = ok(await manager.post('/expenses', { scope: 'BUILDING', buildingId: b2.id, categoryId: w.categories.Security, description: 'Night guard', amount: 120000, expenseDate: isoDate(today()) }));
    expenseId = expense.id;
    ok(await manager.post(`/expenses/${expense.id}/decision`, { decision: 'APPROVED' }), 200);
    const report = ok(await manager.get(`/reports/expenses?${range()}&buildingId=${b2.id}`), 200);
    expect(report.tables.find((t: any) => t.title === 'Expense entries').rows.map((x: any) => [x.description, num(x.amount), x.status])).toEqual([['Night guard', 120000, 'APPROVED']]);
    const building = ok(await manager.get(`/reports/building?${range()}&buildingId=${b2.id}`), 200);
    expect(num(building.summary.find((s: any) => s.label === 'Total expenses').value)).toBe(120000);
    const other = ok(await manager.get(`/reports/building?${range()}&buildingId=${buildings[2]!.id}`), 200);
    expect(num(other.summary.find((s: any) => s.label === 'Total expenses').value)).toBe(0);
  });

  it('creates maintenance, links its cost to an expense, and shows it in maintenance and financial reports', async () => {
    const b3 = buildings[2]!;
    const target = b3.floors[1]!.rooms[1]!;
    const request = ok(await manager.post('/maintenance', { buildingId: b3.id, roomId: target.id, title: 'Replace door', priority: 'HIGH', estimatedCost: 80000 }));
    const cost = ok(await manager.post('/expenses', { scope: 'ROOM', roomId: target.id, categoryId: w.categories.Repairs, description: 'New door', amount: 75000, expenseDate: isoDate(today()), maintenanceRequestId: request.id }));
    ok(await manager.post(`/expenses/${cost.id}/decision`, { decision: 'APPROVED' }), 200);
    ok(await manager.patch(`/maintenance/${request.id}`, { status: 'IN_PROGRESS' }), 200);
    ok(await manager.patch(`/maintenance/${request.id}`, { status: 'COMPLETED', actualCost: 75000 }), 200);

    const detail = ok(await manager.get(`/maintenance/${request.id}`), 200);
    expect([detail.status, num(detail.expensedCost), detail.expenses.length]).toEqual(['COMPLETED', 75000, 1]);
    const maint = ok(await manager.get(`/reports/maintenance?${range()}`), 200);
    expect(maint.tables.find((t: any) => t.title === 'Requests').rows.map((x: any) => [x.title, num(x.expensed), x.status])).toEqual([['Replace door', 75000, 'COMPLETED']]);
    const all = ok(await manager.get(`/reports/consolidated?${range()}`), 200);
    const fin = all.tables.find((t: any) => t.title === 'Financial summary by building');
    expect(fin.rows.map((x: any) => num(x.expenses))).toEqual([0, 120000, 75000]);
    expect([num(fin.totals.expenses), num(fin.totals.net)]).toEqual([195000, 150000 - 195000]);
    expect(num(all.tables.find((t: any) => t.title === 'Maintenance').totals.cost)).toBe(75000);
    expect(expenseId).toBeTruthy();
  });

  it('creates a user with limited permissions and blocks restricted operations', async () => {
    ok(await admin.post('/users', { email: 'limited@test.rw', fullName: 'Limited User', password: 'Limited-Pass-2026', roles: ['VIEWER'] }));
    const limited = await loginAs('limited@test.rw', 'Limited-Pass-2026');
    expect((await limited.get('/dashboard')).status).toBe(200);
    for (const [method, path, body] of [
      ['post', '/payments', { contractId, amount: 1000, methodId: w.methods.CASH, idempotencyKey: uid('lim') }],
      ['post', '/tenants', { fullName: 'A B', idNumber: 'ZZ123456', phone: '+250788999000' }],
      ['post', `/rooms/${room.id}/rent`, { amount: 1, effectiveFrom: isoDate(today()), reason: 'x' }],
      ['post', '/expenses', { scope: 'ORGANIZATION', categoryId: w.categories.Other, description: 'x', amount: 1, expenseDate: isoDate(today()) }],
      ['post', '/users', { email: 'x@test.rw', fullName: 'X', password: 'Whatever-Pass-1', roles: ['SUPER_ADMIN'] }],
      ['patch', '/settings/organization', { name: 'Mine now' }],
    ] as const) {
      const res = await limited[method](path, body);
      expect([res.status, res.body.error.code], path).toEqual([403, 'FORBIDDEN']);
    }
    expect(await prisma.user.count({ where: { email: 'x@test.rw' } })).toBe(0);
  });

  it('left a complete audit trail of the whole scenario', async () => {
    const logs = ok(await admin.get('/audit-logs?pageSize=200'), 200);
    const actions = new Set(logs.items.map((l: any) => l.action));
    for (const action of ['LOGIN', 'BUILDING_CREATED', 'FLOOR_CREATED', 'ROOM_CREATED', 'TENANT_CREATED', 'CONTRACT_CREATED', 'PAYMENT_RECORDED', 'ADVANCE_PAYMENT_RECORDED', 'CONTRACT_TERMINATED', 'EXPENSE_RECORDED', 'EXPENSE_APPROVED', 'MAINTENANCE_REPORTED', 'MAINTENANCE_COMPLETED', 'USER_CREATED', 'REPORT_GENERATED']) {
      expect(actions.has(action), action).toBe(true);
    }
    expect(logs.items.every((l: any) => l.createdAt && (l.userLabel || l.action === 'LOGIN_FAILED'))).toBe(true);
  });
});
