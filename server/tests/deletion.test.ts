import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { createContract } from '../src/services/contracts.js';
import { deleteBuilding, deleteFloor, deleteRoom, deleteTenant } from '../src/services/deletion.js';
import { changeRoomRent, createBuilding, createFloor, createRoom, updateRoom } from '../src/services/property.js';
import { createWorld, d, failure, lease, loginAs, makeBuilding, makeTenant, pay, thisMonth, today, type World } from './helpers.js';
import { addMonths, endOfMonth } from '../src/lib/dates.js';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});

describe('deleting records created by mistake', () => {
  it('deletes an unused room, its rent rates and draft contracts, and audits it', async () => {
    const b = await makeBuilding(w, 'DL', 1, 2);
    const room = b.floors[0]!.rooms[0]!;
    const t = await makeTenant(w);
    await createContract(w.actors.MANAGEMENT, { tenantId: t.id, roomId: room.id, startDate: thisMonth(), endDate: endOfMonth(addMonths(thisMonth(), 5)), activate: false });
    await deleteRoom(w.actors.SUPER_ADMIN, room.id);
    expect(await prisma.room.count({ where: { id: room.id } })).toBe(0);
    expect(await prisma.roomRentRate.count({ where: { roomId: room.id } })).toBe(0);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'ROOM_DELETED', entityId: room.id } });
    expect((log.oldValue as { number: string }).number).toBe(room.number);
  });

  it('refuses to delete a room or floor that has rent history, and says why', async () => {
    const b = await makeBuilding(w, 'HX', 1, 2);
    const room = b.floors[0]!.rooms[0]!;
    const { contract } = await lease(w, room.id);
    await pay(w, 'CASHIER', contract.id, 1000);
    const err = await failure(deleteRoom(w.actors.SUPER_ADMIN, room.id));
    expect(err.code).toBe('HAS_HISTORY');
    expect(err.message).toMatch(/1 contract, 1 payment, 1 rent charge/);
    expect(err.message).toMatch(/set its status to Inactive/);
    expect((await failure(deleteFloor(w.actors.SUPER_ADMIN, b.floors[0]!.id))).code).toBe('HAS_HISTORY');
    expect(await prisma.room.count({ where: { buildingId: b.id } })).toBe(2);
    // The database also refuses to drop the rent history of a room that has been let.
    await expect(prisma.roomRentRate.deleteMany({ where: { roomId: room.id } })).rejects.toThrow(/has been let/);
  });

  it('deletes a whole unused building with its floors and rooms', async () => {
    const b = await makeBuilding(w, 'GONE', 2, 3);
    await deleteBuilding(w.actors.SUPER_ADMIN, b.id);
    expect(await prisma.building.count({ where: { id: b.id } })).toBe(0);
    expect(await prisma.floor.count({ where: { buildingId: b.id } })).toBe(0);
    expect(await prisma.room.count({ where: { buildingId: b.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'BUILDING_DELETED', entityId: b.id } })).toBe(1);
  });

  it('deletes a building that has history together with all of it, keeping tenants who rent elsewhere', async () => {
    const b = await makeBuilding(w, 'PURGE', 1, 2);
    const other = await makeBuilding(w, 'KEEP', 1, 1);
    const [r1, r2] = b.floors[0]!.rooms;
    const { contract: c1, tenant: onlyHere } = await lease(w, r1!.id);
    await pay(w, 'CASHIER', c1.id, 1000);
    const { contract: c2, tenant: alsoElsewhere } = await lease(w, r2!.id);
    await pay(w, 'CASHIER', c2.id, 500);
    await createContract(w.actors.MANAGEMENT, { tenantId: alsoElsewhere.id, roomId: other.floors[0]!.rooms[0]!.id, startDate: thisMonth(), endDate: endOfMonth(addMonths(thisMonth(), 5)), activate: false });
    const paymentsElsewhere = await prisma.payment.count({ where: { buildingId: { not: b.id } } });

    await deleteBuilding(w.actors.SUPER_ADMIN, b.id);

    expect(await prisma.building.count({ where: { id: b.id } })).toBe(0);
    expect(await prisma.room.count({ where: { buildingId: b.id } })).toBe(0);
    expect(await prisma.contract.count({ where: { buildingId: b.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { buildingId: b.id } })).toBe(0);
    expect(await prisma.rentCharge.count({ where: { buildingId: b.id } })).toBe(0);
    expect(await prisma.tenant.count({ where: { id: onlyHere.id } })).toBe(0);
    expect(await prisma.tenant.count({ where: { id: alsoElsewhere.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { buildingId: { not: b.id } } })).toBe(paymentsElsewhere);
    expect(await prisma.room.count({ where: { buildingId: other.id } })).toBe(1);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'BUILDING_DELETED', entityId: b.id } });
    expect(log.summary).toMatch(/2 contracts, 2 payments/);

    // Outside the building delete the database still refuses to drop financial records.
    const otherBuilding = await makeBuilding(w, 'GUARD', 1, 1);
    const { contract: c3 } = await lease(w, otherBuilding.floors[0]!.rooms[0]!.id);
    const p3 = await pay(w, 'CASHIER', c3.id, 700);
    await expect(prisma.payment.delete({ where: { id: p3.id } })).rejects.toThrow(/payments cannot be deleted/);
    await expect(prisma.rentCharge.deleteMany({ where: { contractId: c3.id } })).rejects.toThrow(/rent charges cannot be deleted/);
    await expect(prisma.contract.delete({ where: { id: c3.id } })).rejects.toThrow(/only draft contracts can be deleted/);
  });

  it('deletes a floor together with its unused rooms', async () => {
    const b = await makeBuilding(w, 'FL', 2, 2);
    await deleteFloor(w.actors.SUPER_ADMIN, b.floors[1]!.id);
    expect(await prisma.room.count({ where: { floorId: b.floors[1]!.id } })).toBe(0);
    expect(await prisma.floor.count({ where: { buildingId: b.id } })).toBe(1);
  });

  it('deletes a tenant with no contracts or payments, but never one with history', async () => {
    const fresh = await makeTenant(w);
    await deleteTenant(w.actors.SUPER_ADMIN, fresh.id);
    expect(await prisma.tenant.count({ where: { id: fresh.id } })).toBe(0);
    const b = await makeBuilding(w, 'TN', 1, 1);
    const { tenant } = await lease(w, b.floors[0]!.rooms[0]!.id);
    const err = await failure(deleteTenant(w.actors.SUPER_ADMIN, tenant.id));
    expect(err.code).toBe('HAS_HISTORY');
    expect(err.message).toMatch(/terminate the contract/);
    expect(await prisma.tenant.count({ where: { id: tenant.id } })).toBe(1);
  });

  it('lets an unused room have its rent corrected and be moved to another floor', async () => {
    const bld = await createBuilding(w.actors.SUPER_ADMIN, { code: 'MV', name: 'Move House' });
    const f1 = await createFloor(w.actors.SUPER_ADMIN, { buildingId: bld.id, name: 'One', level: 1 });
    const f2 = await createFloor(w.actors.SUPER_ADMIN, { buildingId: bld.id, name: 'Two', level: 2 });
    const room = await createRoom(w.actors.SUPER_ADMIN, { buildingId: bld.id, floorId: f1.id, number: 'M1', monthlyRent: d(50000) });
    await changeRoomRent(w.actors.SUPER_ADMIN, room.id, { amount: d(500000), effectiveFrom: today(), reason: 'Typo at registration' });
    const fixed = await prisma.room.findUniqueOrThrow({ where: { id: room.id }, include: { rentRates: true } });
    expect([Number(fixed.monthlyRent), fixed.rentRates.length, Number(fixed.rentRates[0]!.amount)]).toEqual([500000, 1, 500000]);
    await updateRoom(w.actors.SUPER_ADMIN, room.id, { floorId: f2.id });
    expect((await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).floorId).toBe(f2.id);
    // Once let, the room stays on its floor.
    await lease(w, room.id);
    expect((await failure(updateRoom(w.actors.SUPER_ADMIN, room.id, { floorId: f1.id }))).code).toBe('HAS_HISTORY');
  });

  it('allows deleting only to roles with the delete permission', async () => {
    const staff = await loginAs(w.emails.PROPERTY_STAFF);
    const cashier = await loginAs(w.emails.CASHIER);
    const t = await makeTenant(w);
    expect((await staff.del(`/tenants/${t.id}`)).status).toBe(403);
    expect((await cashier.del(`/tenants/${t.id}`)).status).toBe(403);
    const manager = await loginAs(w.emails.MANAGEMENT);
    expect((await manager.del(`/tenants/${t.id}`)).status).toBe(200);
  });
});
