import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addDays, addMonths, endOfMonth, isoDate } from '../src/lib/dates.js';
import { activateContract, correctContractDates, createContract, deleteDraftContract, refreshContractStatuses, renewContract, terminateContract } from '../src/services/contracts.js';
import { depositHeld, recordDepositPayment } from '../src/services/deposits.js';
import { contractCredit } from '../src/services/payments.js';
import { reconcile } from '../src/services/reports.js';
import { setTenantStatus } from '../src/services/tenants.js';
import { charges, createWorld, d, endOfThisMonth, failure, lease, makeBuilding, makeTenant, monthsAgo, num, pay, thisMonth, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;
const rooms = () => b.floors.flatMap((f) => f.rooms);

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'CT', 2, 6);
});

describe('contract validity', () => {
  it('rejects an end date before the start date', async () => {
    const tenant = await makeTenant(w);
    const err = await failure(createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: rooms()[0]!.id, startDate: today(), endDate: addDays(today(), -1), activate: true }));
    expect(err.code).toBe('INVALID_DATES');
    // …and the database holds the same line if the service is bypassed.
    const { contract } = await lease(w, rooms()[0]!.id);
    expect((await failure(prisma.contract.update({ where: { id: contract.id }, data: { endDate: addDays(contract.startDate, -5) } }))).status).toBe(409);
  });

  it('rejects overlapping contracts for the same room', async () => {
    const room = rooms()[1]!;
    const { contract } = await lease(w, room.id, 3);
    await terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: today(), reason: 'Moved' });
    const next = await makeTenant(w);
    const overlapping = { tenantId: next.id, roomId: room.id, startDate: monthsAgo(1), endDate: addMonths(today(), 6), activate: true };
    expect((await failure(createContract(w.actors.MANAGEMENT, overlapping))).code).toBe('CONTRACT_OVERLAP');
    // Database-level guard for the same rule.
    const direct = prisma.contract.create({ data: { ...contract, id: undefined, contractNumber: 'OVERLAP-1', tenantId: next.id, status: 'TERMINATED', terminatedOn: today(), createdAt: undefined, updatedAt: undefined } });
    expect((await failure(direct)).message).toMatch(/overlap/i);
  });

  it('keeps a draft from occupying the room until it is activated', async () => {
    const room = rooms()[2]!;
    const tenant = await makeTenant(w);
    const draft = await createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: room.id, startDate: thisMonth(), endDate: endOfMonth(addMonths(thisMonth(), 5)), activate: false });
    expect(draft.status).toBe('DRAFT');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('VACANT');
    expect(await charges(draft.id)).toHaveLength(0);
    expect((await failure(pay(w, 'CASHIER', draft.id, 1000))).code).toBe('CONTRACT_DRAFT');

    const active = await activateContract(w.actors.MANAGEMENT, draft.id);
    expect(active.status).toBe('ACTIVE');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('OCCUPIED');
    expect(await charges(draft.id)).toHaveLength(1);
    expect((await failure(deleteDraftContract(w.actors.MANAGEMENT, draft.id))).status).toBe(409);
    expect((await failure(prisma.contract.delete({ where: { id: draft.id } }))).message).toMatch(/only draft contracts can be deleted/i);
  });

  it('refuses a contract for a blacklisted tenant', async () => {
    const tenant = await makeTenant(w);
    expect((await failure(setTenantStatus(w.actors.PROPERTY_STAFF, tenant.id, 'BLACKLISTED', 'x'))).status).toBe(403);
    await setTenantStatus(w.actors.MANAGEMENT, tenant.id, 'BLACKLISTED', 'Repeated bounced cheques');
    const err = await failure(createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: rooms()[3]!.id, startDate: today(), endDate: addDays(today(), 90), activate: true }));
    expect(err.code).toBe('TENANT_BLACKLISTED');
  });
});

describe('expiry and renewal', () => {
  it('flags contracts that are expiring soon and marks ended ones expired — the room stays occupied', async () => {
    const soonRoom = rooms()[4]!;
    const endedRoom = rooms()[5]!;
    const t1 = await makeTenant(w);
    const t2 = await makeTenant(w);
    const soon = await createContract(w.actors.MANAGEMENT, { tenantId: t1.id, roomId: soonRoom.id, startDate: monthsAgo(5), endDate: addDays(today(), 12), activate: true });
    const ended = await createContract(w.actors.MANAGEMENT, { tenantId: t2.id, roomId: endedRoom.id, startDate: monthsAgo(6), endDate: addDays(today(), -3), activate: true });
    const far = (await lease(w, rooms()[6]!.id)).contract;

    const result = await refreshContractStatuses(w.orgId, today(), 30);
    expect(result).toMatchObject({ expiring: 1, expired: 1 });
    const status = async (id: string) => (await prisma.contract.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(soon.id), await status(ended.id), await status(far.id)]).toEqual(['EXPIRING', 'EXPIRED', 'ACTIVE']);
    // An expired contract has not vacated the room: nobody else can be moved in.
    expect((await prisma.room.findUniqueOrThrow({ where: { id: endedRoom.id } })).status).toBe('OCCUPIED');
    const other = await makeTenant(w);
    expect((await failure(createContract(w.actors.MANAGEMENT, { tenantId: other.id, roomId: endedRoom.id, startDate: today(), endDate: addDays(today(), 90), activate: true }))).code).toBe('ROOM_OCCUPIED');
    // No rent is billed beyond the contract end date.
    const last = (await charges(ended.id)).at(-1)!;
    expect(last.period.getTime()).toBeLessThanOrEqual(ended.endDate.getTime());
  });

  it('renews into a new contract that starts the day after the old one ends', async () => {
    const room = rooms()[7]!;
    const tenant = await makeTenant(w);
    const old = await createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: room.id, startDate: monthsAgo(4), endDate: addDays(today(), -1), activate: true, depositAmount: d(50000) });
    await recordDepositPayment(w.actors.ACCOUNTANT, { contractId: old.id, amount: d(50000), methodId: w.methods.CASH! });
    await refreshContractStatuses(w.orgId, today(), 30);

    expect((await failure(renewContract(w.actors.MANAGEMENT, old.id, { endDate: addDays(today(), -2) }))).code).toBe('INVALID_DATES');
    expect((await failure(renewContract(w.actors.MANAGEMENT, old.id, { endDate: addMonths(today(), 12), monthlyRent: d(999999) }))).code).toBe('REASON_REQUIRED');
    const renewed = await renewContract(w.actors.MANAGEMENT, old.id, { endDate: endOfMonth(addMonths(today(), 11)), monthlyRent: d(room.rent + 10000), rentChangeReason: 'Renewal terms' });

    const before = await prisma.contract.findUniqueOrThrow({ where: { id: old.id } });
    expect(before.status).toBe('RENEWED');
    expect([renewed.status, isoDate(renewed.startDate), renewed.renewedFromId, renewed.tenantId]).toEqual(['ACTIVE', isoDate(today()), old.id, tenant.id]);
    expect(await prisma.contract.count({ where: { roomId: room.id, status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED'] } } })).toBe(1);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('OCCUPIED');
    // Old charges keep the old rent; the new contract bills the new rent.
    // (The month in which the contract changes over is split between the two by days.)
    const oldCharges = await charges(old.id);
    expect(num(oldCharges[0]!.amountDue)).toBe(room.rent);
    expect(oldCharges.every((c) => num(c.amountDue) <= room.rent)).toBe(true);
    const dim = endOfMonth(today()).getUTCDate();
    const share = dim - today().getUTCDate() + 1;
    expect((await charges(renewed.id)).map((c) => num(c.amountDue))).toEqual([Math.round(((room.rent + 10000) * share) / dim)]);
    // The deposit follows the tenancy.
    expect([num(await depositHeld(prisma, old.id)), num(await depositHeld(prisma, renewed.id))]).toEqual([0, 50000]);
    expect((await failure(renewContract(w.actors.MANAGEMENT, old.id, { endDate: addMonths(today(), 12) }))).code).toBe('NOT_ACTIVE');
  });
});

describe('termination (move-out)', () => {
  it('records the move-out, final balance and room condition, and can send the room to maintenance', async () => {
    const room = rooms()[8]!;
    const { contract } = await lease(w, room.id, 1, { depositAmount: d(60000) });
    await recordDepositPayment(w.actors.ACCOUNTANT, { contractId: contract.id, amount: d(60000), methodId: w.methods.CASH! });
    await pay(w, 'CASHIER', contract.id, room.rent);

    expect((await failure(terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: addDays(today(), 5), reason: 'x' }))).code).toBe('INVALID_DATES');
    expect((await failure(terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: today(), reason: 'x', depositDeduction: d(999999), deductionReason: 'damage' }))).code).toBe('DEPOSIT_EXCEEDED');
    const done = await terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: today(), reason: 'End of business', roomCondition: 'Broken shelf', needsMaintenance: true, depositDeduction: d(15000), deductionReason: 'Broken shelf' });

    expect([done.status, isoDate(done.terminatedOn!), done.terminationReason, done.roomCondition, num(done.finalBalance)]).toEqual(['TERMINATED', isoDate(today()), 'End of business', 'Broken shelf', room.rent]);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('MAINTENANCE');
    expect(await prisma.maintenanceRequest.count({ where: { roomId: room.id, status: 'REPORTED' } })).toBe(1);
    expect(num(await depositHeld(prisma, contract.id))).toBe(45000);
    expect((await failure(terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: today(), reason: 'again' }))).code).toBe('NOT_ACTIVE');
    // Arrears of a former tenant can still be collected after move-out.
    await pay(w, 'CASHIER', contract.id, room.rent);
    expect((await charges(contract.id)).every((c) => c.status === 'PAID')).toBe(true);
  });

  it('un-bills pre-paid future months on move-out and holds the money as credit — nothing is lost', async () => {
    const room = rooms()[9]!;
    const { contract } = await lease(w, room.id);
    await pay(w, 'ACCOUNTANT', contract.id, room.rent * 3, { overpayment: 'ADVANCE' });
    await terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: today(), reason: 'Left early' });

    const live = await charges(contract.id);
    expect(live.map((c) => [isoDate(c.period), c.status])).toEqual([[isoDate(thisMonth()), 'PAID']]);
    expect(await prisma.rentCharge.count({ where: { contractId: contract.id, status: 'VOID' } })).toBe(2);
    expect(num(await contractCredit(prisma, contract.id))).toBe(room.rent * 2);
    const payment = await prisma.payment.findFirstOrThrow({ where: { contractId: contract.id } });
    expect([num(payment.amount), num(payment.allocatedAmount), num(payment.unallocatedAmount)]).toEqual([room.rent * 3, room.rent, room.rent * 2]);
    expect((await reconcile(w.orgId, monthsAgo(6), endOfThisMonth())).filter((c) => !c.ok)).toEqual([]);
  });
});

describe('correcting the start date (rent counted from the day the tenant starts working)', () => {
  it('re-bills from the corrected start: earlier months are voided and what was paid for them becomes credit', async () => {
    const room = rooms()[10]!;
    const { contract } = await lease(w, room.id, 2);
    await pay(w, 'ACCOUNTANT', contract.id, room.rent * 3);
    expect((await charges(contract.id)).map((c) => c.status)).toEqual(['PAID', 'PAID', 'PAID']);

    const start = addDays(thisMonth(), 14);
    const end = endOfMonth(addMonths(start, 12));
    await correctContractDates(w.actors.MANAGEMENT, contract.id, { startDate: start, endDate: end, reason: 'Tenant started working on the 15th' });

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect([isoDate(after.startDate), isoDate(after.endDate)]).toEqual([isoDate(start), isoDate(end)]);
    // Only this month is billed now, prorated from the 15th; the money paid for the two earlier months is credit.
    const daysInMonth = endOfThisMonth().getUTCDate();
    const prorated = Math.round((room.rent * (daysInMonth - 14)) / daysInMonth);
    const live = await charges(contract.id);
    expect(live.map((c) => [isoDate(c.period), num(c.amountDue), c.status])).toEqual([[isoDate(thisMonth()), prorated, 'PAID']]);
    expect(isoDate(live[0]!.dueDate)).toBe(isoDate(start));
    expect(num(await contractCredit(prisma, contract.id))).toBe(room.rent * 3 - prorated);
    expect(await prisma.auditLog.count({ where: { action: 'CONTRACT_DATES_CORRECTED', entityId: contract.id } })).toBe(1);
    expect((await reconcile(w.orgId, monthsAgo(6), endOfThisMonth())).filter((c) => !c.ok)).toEqual([]);
  });

  it('refuses dates that overlap the previous contract of the room, or that are not valid', async () => {
    const room = rooms()[11]!;
    const { contract } = await lease(w, room.id, 0, { endDate: endOfThisMonth() });
    const renewed = await renewContract(w.actors.MANAGEMENT, contract.id, { endDate: endOfMonth(addMonths(thisMonth(), 6)) });
    const overlap = await failure(correctContractDates(w.actors.MANAGEMENT, renewed.id, { startDate: thisMonth(), endDate: renewed.endDate, reason: 'Wrong' }));
    expect(overlap.code).toBe('DATES_OVERLAP');
    expect(overlap.message).toContain(contract.contractNumber);
    expect((await failure(correctContractDates(w.actors.MANAGEMENT, renewed.id, { startDate: renewed.endDate, endDate: renewed.startDate, reason: 'Wrong' }))).code).toBe('INVALID_DATES');
    expect((await failure(correctContractDates(w.actors.MANAGEMENT, contract.id, { startDate: thisMonth(), endDate: endOfThisMonth(), reason: 'Closed' }))).code).toBe('NOT_ACTIVE');
  });
});
