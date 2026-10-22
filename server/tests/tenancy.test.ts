import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addDays, addMonths, isoDate } from '../src/lib/dates.js';
import { contractDocument } from '../src/services/contractDocument.js';
import { correctContractDates, createContract, giveContract, OPEN_END, refreshContractStatuses, renewContract, terminateContract } from '../src/services/contracts.js';
import { contractCredit } from '../src/services/payments.js';
import { createTenant } from '../src/services/tenants.js';
import { charges, createWorld, failure, loginAs, makeBuilding, monthsAgo, num, pay, thisMonth, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;
const rooms = () => b.floors.flatMap((f) => f.rooms);

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'TN', 1, 6);
});

/** Registers a tenant with only a name and the room they rent from `startDate`, and returns their tenancy. */
async function rentWithoutContract(roomId: string, startDate: Date, fullName = 'Mukamana Grace') {
  const tenant = await createTenant(w.actors.MANAGEMENT, { fullName }, { roomId, startDate });
  return prisma.contract.findFirstOrThrow({ where: { tenantId: tenant.id } });
}

describe('renting a room without a contract', () => {
  it('needs only a name and a room: the room is occupied, rent is billed and payments are recorded', async () => {
    const room = rooms()[0]!;
    const tenancy = await rentWithoutContract(room.id, monthsAgo(2));
    expect([tenancy.status, tenancy.leaseStart, isoDate(tenancy.endDate)]).toEqual(['ACTIVE', null, isoDate(OPEN_END)]);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('OCCUPIED');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenancy.tenantId } })).status).toBe('ACTIVE');
    expect((await charges(tenancy.id)).map((c) => isoDate(c.period))).toEqual([monthsAgo(2), monthsAgo(1), thisMonth()].map(isoDate));
    await pay(w, 'CASHIER', tenancy.id, room.rent);
    expect((await charges(tenancy.id)).map((c) => c.status)[0]).toBe('PAID');
  });

  it('has nothing to print or renew, and never expires', async () => {
    const tenancy = await rentWithoutContract(rooms()[1]!.id, monthsAgo(1));
    expect((await failure(contractDocument(w.actors.MANAGEMENT, tenancy.id, 'docx'))).code).toBe('NO_CONTRACT');
    expect((await failure(renewContract(w.actors.MANAGEMENT, tenancy.id, { endDate: addMonths(today(), 12) }))).code).toBe('NO_CONTRACT');
    await refreshContractStatuses(w.orgId, today(), 60);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: tenancy.id } })).status).toBe('ACTIVE');
  });

  it('keeps the room from being given to anyone else', async () => {
    const room = rooms()[2]!;
    await rentWithoutContract(room.id, today());
    const other = await createTenant(w.actors.MANAGEMENT, { fullName: 'Someone Else' });
    expect((await failure(createContract(w.actors.MANAGEMENT, { tenantId: other.id, roomId: room.id, startDate: today(), endDate: addMonths(today(), 12), activate: true }))).code).toBe('ROOM_OCCUPIED');
  });

  it('moves the move-in day without giving the tenancy an end', async () => {
    const tenancy = await rentWithoutContract(rooms()[3]!.id, monthsAgo(1));
    const corrected = await correctContractDates(w.actors.MANAGEMENT, tenancy.id, { startDate: thisMonth(), endDate: addMonths(today(), 3), reason: 'Moved in this month' });
    expect([isoDate(corrected.startDate), isoDate(corrected.endDate), corrected.leaseStart]).toEqual([isoDate(thisMonth()), isoDate(OPEN_END), null]);
    expect((await charges(tenancy.id)).map((c) => isoDate(c.period))).toEqual([isoDate(thisMonth())]);
  });

  it('ends at move-out like any tenancy', async () => {
    const room = rooms()[4]!;
    const tenancy = await rentWithoutContract(room.id, monthsAgo(1));
    await terminateContract(w.actors.MANAGEMENT, tenancy.id, { moveOutDate: today(), reason: 'Left' });
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status).toBe('VACANT');
  });
});

describe('giving a contract later', () => {
  it('keeps every month billed and paid so far, and the contract runs from the chosen day', async () => {
    const room = rooms()[5]!;
    const tenancy = await rentWithoutContract(room.id, monthsAgo(2), 'Uwase Claire');
    await pay(w, 'MANAGEMENT', tenancy.id, room.rent * 4, { overpayment: 'ADVANCE' }); // three months billed so far, and next month paid in advance
    const before = await charges(tenancy.id);
    const start = addMonths(thisMonth(), 1);

    expect((await failure(giveContract(w.actors.MANAGEMENT, tenancy.id, { startDate: monthsAgo(3), endDate: addMonths(today(), 12) }))).code).toBe('INVALID_DATES');
    const given = await giveContract(w.actors.MANAGEMENT, tenancy.id, { startDate: start, endDate: addDays(addMonths(start, 12), -1) });
    expect([isoDate(given.startDate), isoDate(given.leaseStart!), isoDate(given.endDate), given.status]).toEqual([isoDate(monthsAgo(2)), isoDate(start), isoDate(addDays(addMonths(start, 12), -1)), 'ACTIVE']);
    expect((await charges(tenancy.id)).map((c) => [c.id, c.status])).toEqual(before.map((c) => [c.id, c.status]));
    expect(before.map((c) => c.status)).toEqual(['PAID', 'PAID', 'PAID', 'PAID']);
    expect(num(await contractCredit(prisma, tenancy.id))).toBe(0);
    expect((await failure(giveContract(w.actors.MANAGEMENT, tenancy.id, { startDate: start, endDate: addMonths(start, 12) }))).code).toBe('HAS_CONTRACT');
  });

  it('works over HTTP, and registration over HTTP needs only the name', async () => {
    const manager = await loginAs(w.emails.MANAGEMENT);
    const extra = await makeBuilding(w, 'TH', 1, 1);
    const created = await manager.post('/tenants', { fullName: 'Habimana Eric', roomId: extra.floors[0]!.rooms[0]!.id, startDate: isoDate(today()) });
    expect([created.status, created.body.idNumber, created.body.phone]).toEqual([201, null, null]);
    const tenancy = await prisma.contract.findFirstOrThrow({ where: { tenantId: created.body.id } });
    const res = await manager.post(`/contracts/${tenancy.id}/give`, { startDate: '2027-01-01', endDate: '2027-12-31' });
    expect([res.status, res.body.leaseStart?.slice(0, 10), res.body.endDate?.slice(0, 10)]).toEqual([200, '2027-01-01', '2027-12-31']);
    // A room without a move-in day is refused rather than guessed.
    expect((await manager.post('/tenants', { fullName: 'No Date', roomId: extra.floors[0]!.rooms[0]!.id })).body.error.details.fields.startDate).toBeTruthy();
  });
});
