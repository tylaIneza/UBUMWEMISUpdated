import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { addDays, endOfMonth } from '../src/lib/dates.js';
import { createContract, terminateContract } from '../src/services/contracts.js';
import { createMaintenance, updateMaintenance } from '../src/services/maintenance.js';
import { changeRoomRent, createReservation, createRoom, endReservation, updateRoom } from '../src/services/property.js';
import { createWorld, d, failure, lease, makeBuilding, makeTenant, pay, thisMonth, today, type BuildingFixture, type World } from './helpers.js';

let w: World;
let b: BuildingFixture;

beforeAll(async () => {
  w = await createWorld();
  b = await makeBuilding(w, 'RM', 2, 4);
});

describe('room registration', () => {
  it('records the rent, creates the first rent-rate version and starts vacant', async () => {
    const room = await prisma.room.findUniqueOrThrow({ where: { id: b.floors[0]!.rooms[0]!.id }, include: { rentRates: true } });
    expect(room.status).toBe('VACANT');
    expect(Number(room.monthlyRent)).toBe(b.floors[0]!.rooms[0]!.rent);
    expect(room.rentRates).toHaveLength(1);
    expect(room.rentRates[0]!.effectiveTo).toBeNull();
  });

  it('rejects a duplicate room number in the same building', async () => {
    const err = await failure(createRoom(w.actors.SUPER_ADMIN, { buildingId: b.id, floorId: b.floors[1]!.id, number: b.floors[0]!.rooms[0]!.number.toLowerCase(), monthlyRent: d(1000) }));
    expect(err.code).toBe('DUPLICATE_ROOM');
  });

  it('allows the same room number in a different building', async () => {
    const other = await makeBuilding(w, 'RM2', 1, 0);
    await expect(createRoom(w.actors.SUPER_ADMIN, { buildingId: other.id, floorId: other.floors[0]!.id, number: b.floors[0]!.rooms[0]!.number, monthlyRent: d(1000) })).resolves.toBeTruthy();
  });

  it('rejects a floor that belongs to another building', async () => {
    const other = await makeBuilding(w, 'RM3', 1, 0);
    const err = await failure(createRoom(w.actors.SUPER_ADMIN, { buildingId: b.id, floorId: other.floors[0]!.id, number: 'X1', monthlyRent: d(1000) }));
    expect(err.code).toBe('FLOOR_MISMATCH');
  });
});

describe('occupancy rules', () => {
  const room = () => b.floors[0]!.rooms[1]!;

  it('loads the room rent into the contract automatically and occupies the room', async () => {
    const { contract } = await lease(w, room().id);
    expect(Number(contract.monthlyRent)).toBe(room().rent);
    expect(Number(contract.roomRentAtSigning)).toBe(room().rent);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room().id } })).status).toBe('OCCUPIED');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: contract.tenantId } })).status).toBe('ACTIVE');
  });

  it('blocks assigning an occupied room to another tenant', async () => {
    const other = await makeTenant(w);
    const err = await failure(createContract(w.actors.MANAGEMENT, { tenantId: other.id, roomId: room().id, startDate: today(), endDate: addDays(today(), 200), activate: true }));
    expect(err.code).toBe('ROOM_OCCUPIED');
    expect(err.message).toBe('This room is already occupied. An active contract already exists for this room.');
    expect(await prisma.contract.count({ where: { roomId: room().id } })).toBe(1);
  });

  it('is enforced by the database even if the service layer is bypassed', async () => {
    const existing = await prisma.contract.findFirstOrThrow({ where: { roomId: room().id } });
    const other = await makeTenant(w);
    const direct = prisma.contract.create({
      data: { ...existing, id: undefined, contractNumber: 'BYPASS-1', tenantId: other.id, startDate: addDays(existing.endDate, 30), endDate: addDays(existing.endDate, 60), renewedFromId: null, createdAt: undefined, updatedAt: undefined },
    });
    expect((await failure(direct)).code).toBe('ROOM_OCCUPIED');
  });

  it('does not let staff flip an occupied room to vacant by hand', async () => {
    const err = await failure(updateRoom(w.actors.MANAGEMENT, room().id, { status: 'VACANT' }));
    expect(err.code).toBe('ROOM_OCCUPIED');
  });

  it('vacates the room on termination, keeps all history, and allows reassignment', async () => {
    const contract = await prisma.contract.findFirstOrThrow({ where: { roomId: room().id } });
    await pay(w, 'CASHIER', contract.id, 40000);
    const ended = await terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: today(), reason: 'Business closed', roomCondition: 'Good' });
    expect(ended.status).toBe('TERMINATED');
    expect(Number(ended.finalBalance)).toBe(room().rent - 40000);
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room().id } })).status).toBe('VACANT');
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: contract.tenantId } })).status).toBe('FORMER');

    // A new tenant can take the room the day after the previous tenant moved out…
    const next = await makeTenant(w, 'Second Occupant');
    const start = addDays(today(), 1);
    const fresh = await createContract(w.actors.MANAGEMENT, { tenantId: next.id, roomId: room().id, startDate: start, endDate: endOfMonth(addDays(start, 300)), activate: true });
    expect(fresh.status).toBe('ACTIVE');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room().id } })).status).toBe('OCCUPIED');

    // …and the previous tenant's record is fully intact.
    const former = await prisma.tenant.findUniqueOrThrow({ where: { id: contract.tenantId }, include: { contracts: true, payments: true, charges: true } });
    expect(former.contracts).toHaveLength(1);
    expect(former.payments).toHaveLength(1);
    expect(Number(former.payments[0]!.amount)).toBe(40000);
    expect(former.charges.length).toBeGreaterThan(0);
  });

  it('rejects a new contract that starts before the previous tenant moved out', async () => {
    const r = b.floors[0]!.rooms[2]!;
    const { contract } = await lease(w, r.id, 2);
    await terminateContract(w.actors.MANAGEMENT, contract.id, { moveOutDate: today(), reason: 'Left' });
    const next = await makeTenant(w);
    const err = await failure(createContract(w.actors.MANAGEMENT, { tenantId: next.id, roomId: r.id, startDate: addDays(thisMonth(), -10), endDate: addDays(today(), 200), activate: true }));
    expect(err.code).toBe('CONTRACT_OVERLAP');
  });
});

describe('reservations and maintenance', () => {
  it('holds a reserved room for the prospective tenant only', async () => {
    const r = b.floors[1]!.rooms[0]!;
    const reserved = await makeTenant(w, 'Reserved Tenant');
    const other = await makeTenant(w);
    const reservation = await createReservation(w.actors.PROPERTY_STAFF, { roomId: r.id, tenantId: reserved.id, prospectName: reserved.fullName, reservedOn: today(), expiresOn: addDays(today(), 7) });
    expect((await prisma.room.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('RESERVED');

    const blocked = await failure(createContract(w.actors.MANAGEMENT, { tenantId: other.id, roomId: r.id, startDate: today(), endDate: addDays(today(), 100), activate: true }));
    expect(blocked.code).toBe('ROOM_RESERVED');
    expect((await failure(createReservation(w.actors.PROPERTY_STAFF, { roomId: r.id, prospectName: 'Someone else', reservedOn: today(), expiresOn: addDays(today(), 3) }))).code).toBe('ROOM_NOT_AVAILABLE');

    await createContract(w.actors.MANAGEMENT, { tenantId: reserved.id, roomId: r.id, startDate: today(), endDate: addDays(today(), 100), activate: true });
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe('CONVERTED');
  });

  it('frees the room when a reservation is cancelled', async () => {
    const r = b.floors[1]!.rooms[1]!;
    const reservation = await createReservation(w.actors.PROPERTY_STAFF, { roomId: r.id, prospectName: 'Walk-in', reservedOn: today(), expiresOn: addDays(today(), 3) });
    await endReservation(w.actors.PROPERTY_STAFF, w.orgId, reservation.id, 'CANCELLED');
    expect((await prisma.room.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('VACANT');
  });

  it('does not allow a room under maintenance to be let, and returns it to service when work completes', async () => {
    const r = b.floors[1]!.rooms[2]!;
    const request = await createMaintenance(w.actors.PROPERTY_STAFF, { buildingId: b.id, roomId: r.id, title: 'Repaint', markRoomUnderMaintenance: true });
    const tenant = await makeTenant(w);
    const err = await failure(createContract(w.actors.MANAGEMENT, { tenantId: tenant.id, roomId: r.id, startDate: today(), endDate: addDays(today(), 100), activate: true }));
    expect(err.code).toBe('ROOM_NOT_AVAILABLE');
    await updateMaintenance(w.actors.PROPERTY_STAFF, request.id, { status: 'IN_PROGRESS' });
    await updateMaintenance(w.actors.PROPERTY_STAFF, request.id, { status: 'COMPLETED', actualCost: d(50000) });
    expect((await prisma.room.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('VACANT');
    expect((await failure(updateMaintenance(w.actors.PROPERTY_STAFF, request.id, { status: 'IN_PROGRESS' }))).status).toBe(409);
  });
});

describe('room rent history', () => {
  it('versions rent instead of overwriting it, and refuses retroactive or historical edits', async () => {
    const r = b.floors[1]!.rooms[3]!;
    await lease(w, r.id); // a room that has been let keeps its rent history
    const tomorrow = addDays(today(), 1);
    await changeRoomRent(w.actors.MANAGEMENT, r.id, { amount: d(275000), effectiveFrom: tomorrow, reason: 'Annual review' });
    const rates = await prisma.roomRentRate.findMany({ where: { roomId: r.id }, orderBy: { effectiveFrom: 'asc' } });
    expect(rates).toHaveLength(2);
    expect(Number(rates[0]!.amount)).toBe(r.rent);
    expect(rates[0]!.effectiveTo?.getTime()).toBe(today().getTime());
    expect(Number(rates[1]!.amount)).toBe(275000);
    expect(rates[1]!.effectiveTo).toBeNull();
    // The new rent is not in force yet, so the room still shows today's rate.
    expect(Number((await prisma.room.findUniqueOrThrow({ where: { id: r.id } })).monthlyRent)).toBe(r.rent);

    expect((await failure(changeRoomRent(w.actors.MANAGEMENT, r.id, { amount: d(1), effectiveFrom: addDays(today(), -40), reason: 'backdate' }))).code).toBe('RETROACTIVE_RENT');
    // Historical rows are frozen at database level.
    const frozen = await failure(prisma.roomRentRate.update({ where: { id: rates[0]!.id }, data: { amount: 1 } }));
    expect(frozen.message).toMatch(/historical rent rates cannot be changed/i);
    expect((await failure(prisma.roomRentRate.delete({ where: { id: rates[0]!.id } }))).message).toMatch(/cannot be deleted/i);
    const log = await prisma.auditLog.findFirst({ where: { action: 'ROOM_RENT_CHANGED', entityId: r.id } });
    expect(log?.userId).toBe(w.actors.MANAGEMENT.userId);
  });
});
