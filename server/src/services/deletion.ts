import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../config.js';
import { inTransaction, lockRoom, prisma, type Tx } from '../db.js';
import { conflict, notFound } from '../errors.js';
import type { Actor } from '../http/context.js';
import { logger } from '../logger.js';
import { audit } from './audit.js';

/**
 * Permanent deletion of records created by mistake. Rooms, floors and tenants can only be deleted
 * when they have NO financial or occupancy history: once a contract, rent charge, payment, deposit,
 * expense or maintenance record exists, they are part of the books and are kept, and the reason is
 * explained to the user with the safe alternative (mark inactive / former). A building is the
 * exception: deleting it removes it together with all of its history (see deleteBuilding).
 * Every deletion is written to the audit log with the full deleted record.
 */

interface History {
  contracts: number;
  charges: number;
  payments: number;
  deposits: number;
  expenses: number;
  maintenance: number;
  reservations: number;
}

function describe(h: History): string {
  const parts: Array<[number, string]> = [
    [h.contracts, 'contract'], [h.payments, 'payment'], [h.charges, 'rent charge'], [h.deposits, 'deposit transaction'],
    [h.expenses, 'expense'], [h.maintenance, 'maintenance request'], [h.reservations, 'reservation'],
  ];
  return parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ');
}
const hasHistory = (h: History) => Object.values(h).some((n) => n > 0);

async function roomsHistory(tx: Tx, roomIds: string[]): Promise<History> {
  const [contracts, charges, payments, expenses, maintenance, reservations] = await Promise.all([
    tx.contract.count({ where: { roomId: { in: roomIds }, status: { not: 'DRAFT' } } }),
    tx.rentCharge.count({ where: { roomId: { in: roomIds } } }),
    tx.payment.count({ where: { roomId: { in: roomIds } } }),
    tx.expense.count({ where: { roomId: { in: roomIds } } }),
    tx.maintenanceRequest.count({ where: { roomId: { in: roomIds } } }),
    tx.reservation.count({ where: { roomId: { in: roomIds } } }),
  ]);
  return { contracts, charges, payments, deposits: 0, expenses, maintenance, reservations };
}

/** Deletes rooms (assumed checked) with their draft contracts, rent-rate rows and documents. */
async function removeRooms(tx: Tx, roomIds: string[]) {
  if (!roomIds.length) return;
  await tx.contract.deleteMany({ where: { roomId: { in: roomIds }, status: 'DRAFT' } });
  await tx.roomRentRate.deleteMany({ where: { roomId: { in: roomIds } } });
  await tx.room.deleteMany({ where: { id: { in: roomIds } } });
}

async function removeDocuments(orgId: string, entityType: string, ids: string[]) {
  if (!ids.length) return;
  const docs = await prisma.document.findMany({ where: { orgId, entityType, entityId: { in: ids } } });
  await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
  for (const d of docs) await unlink(join(resolve(config.STORAGE_DIR), d.storedName)).catch((err) => logger.warn({ err, file: d.storedName }, 'document file not removed'));
}

export async function deleteRoom(actor: Actor, id: string) {
  const room = await inTransaction(async (tx) => {
    await lockRoom(tx, id);
    const room = await tx.room.findFirst({ where: { id, building: { orgId: actor.orgId } }, include: { building: { select: { name: true } }, floor: { select: { name: true } } } });
    if (!room) throw notFound('Room');
    const h = await roomsHistory(tx, [id]);
    if (hasHistory(h)) {
      throw conflict(`Room ${room.number} cannot be deleted because it has history (${describe(h)}). Rent and payment records must be kept. To stop using the room, edit it and set its status to Inactive.`, 'HAS_HISTORY', h);
    }
    await removeRooms(tx, [id]);
    await audit(tx, actor, { action: 'ROOM_DELETED', entityType: 'Room', entityId: id, summary: `Room ${room.number} (${room.floor.name}, ${room.building.name}) deleted — it had never been let`, oldValue: room });
    return room;
  });
  await removeDocuments(actor.orgId, 'Room', [id]);
  return room;
}

export async function deleteFloor(actor: Actor, id: string) {
  await inTransaction(async (tx) => {
    const floor = await tx.floor.findFirst({ where: { id, building: { orgId: actor.orgId } }, include: { building: { select: { name: true } }, rooms: { select: { id: true, number: true } } } });
    if (!floor) throw notFound('Floor');
    const roomIds = floor.rooms.map((r) => r.id);
    const h = await roomsHistory(tx, roomIds);
    h.expenses += await tx.expense.count({ where: { floorId: id, roomId: null } });
    h.maintenance += await tx.maintenanceRequest.count({ where: { floorId: id, roomId: null } });
    if (hasHistory(h)) throw conflict(`${floor.name} cannot be deleted because its rooms have history (${describe(h)}). Rent and payment records must be kept.`, 'HAS_HISTORY', h);
    await removeRooms(tx, roomIds);
    await tx.floor.delete({ where: { id } });
    await audit(tx, actor, { action: 'FLOOR_DELETED', entityType: 'Floor', entityId: id, summary: `${floor.name} (${floor.building.name}) deleted with ${roomIds.length} unused room(s): ${floor.rooms.map((r) => r.number).join(', ') || 'none'}`, oldValue: floor });
  });
}

/**
 * Permanently deletes a building with EVERYTHING recorded against it: floors, rooms, contracts,
 * rent charges, payments (with allocations, receipts and invoices), deposits, expenses, maintenance,
 * reservations, approvals and documents. Tenants whose only tenancy was in this building are deleted
 * too; tenants who also rent elsewhere are kept. The database's append-only delete guards allow this
 * only while @rpms_purge = 1 is set on the transaction's connection (migration 20261120000000).
 */
export async function deleteBuilding(actor: Actor, id: string) {
  const removed = await inTransaction(async (tx) => {
    const building = await tx.building.findFirst({ where: { id, orgId: actor.orgId }, include: { floors: { select: { id: true, name: true } }, rooms: { select: { id: true, number: true } } } });
    if (!building) throw notFound('Building');
    const roomIds = building.rooms.map((r) => r.id);
    const floorIds = building.floors.map((f) => f.id);
    const pick = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

    const contractIds = pick(await tx.contract.findMany({ where: { buildingId: id }, select: { id: true } }));
    const paymentIds = pick(await tx.payment.findMany({ where: { OR: [{ buildingId: id }, { contractId: { in: contractIds } }] }, select: { id: true } }));
    const chargeIds = pick(await tx.rentCharge.findMany({ where: { OR: [{ buildingId: id }, { contractId: { in: contractIds } }] }, select: { id: true } }));
    const maintenanceIds = pick(await tx.maintenanceRequest.findMany({ where: { buildingId: id }, select: { id: true } }));
    const expenseIds = pick(await tx.expense.findMany({
      where: { OR: [{ buildingId: id }, { floorId: { in: floorIds } }, { roomId: { in: roomIds } }, { maintenanceRequestId: { in: maintenanceIds } }] }, select: { id: true },
    }));
    const depositIds = pick(await tx.depositTransaction.findMany({ where: { contractId: { in: contractIds } }, select: { id: true } }));
    const invoiceIds = pick(await tx.invoice.findMany({ where: { OR: [{ buildingId: id }, { paymentId: { in: paymentIds } }] }, select: { id: true } }));
    // Tenants who rented only here: nothing in any other building.
    const tenantIds = pick(await tx.tenant.findMany({
      where: {
        orgId: actor.orgId,
        contracts: { some: { buildingId: id }, none: { buildingId: { not: id } } },
        payments: { none: { buildingId: { not: id } } },
      },
      select: { id: true },
    }));

    const counts = { contracts: contractIds.length, payments: paymentIds.length, charges: chargeIds.length, expenses: expenseIds.length, deposits: depositIds.length, maintenance: maintenanceIds.length, tenants: tenantIds.length };
    const entityIds = [id, ...floorIds, ...roomIds, ...contractIds, ...paymentIds, ...chargeIds, ...maintenanceIds, ...expenseIds, ...depositIds, ...invoiceIds, ...tenantIds];

    await tx.$executeRawUnsafe('SET @rpms_purge = 1');
    try {
      await tx.paymentAllocation.deleteMany({ where: { OR: [{ paymentId: { in: paymentIds } }, { rentChargeId: { in: chargeIds } }] } });
      await tx.receipt.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
      await tx.payment.deleteMany({ where: { id: { in: paymentIds }, reversesId: { not: null } } }); // reversals before the payments they reverse
      await tx.payment.deleteMany({ where: { id: { in: paymentIds } } });
      await tx.rentCharge.deleteMany({ where: { id: { in: chargeIds } } });
      await tx.depositTransaction.deleteMany({ where: { id: { in: depositIds } } });
      await tx.rentAdjustment.deleteMany({ where: { contractId: { in: contractIds } } });
      await tx.contractRentRate.deleteMany({ where: { contractId: { in: contractIds } } });
      await tx.messageLog.deleteMany({ where: { OR: [{ contractId: { in: contractIds } }, { tenantId: { in: tenantIds } }] } });
      await tx.expense.deleteMany({ where: { id: { in: expenseIds } } });
      await tx.maintenanceRequest.deleteMany({ where: { id: { in: maintenanceIds } } });
      await tx.reservation.deleteMany({ where: { roomId: { in: roomIds } } });
      await tx.reservation.updateMany({ where: { tenantId: { in: tenantIds } }, data: { tenantId: null } });
      await tx.approvalRequest.deleteMany({ where: { entityId: { in: entityIds } } });
      await tx.notification.deleteMany({ where: { entityId: { in: entityIds } } });
      await tx.contract.updateMany({ where: { renewedFromId: { in: contractIds } }, data: { renewedFromId: null } });
      await tx.contract.deleteMany({ where: { id: { in: contractIds } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } });
      await tx.roomRentRate.deleteMany({ where: { roomId: { in: roomIds } } });
      await tx.room.deleteMany({ where: { id: { in: roomIds } } });
      await tx.floor.deleteMany({ where: { buildingId: id } });
      await tx.building.delete({ where: { id } });
    } finally {
      // The connection goes back to the pool: never leave the guards switched off on it.
      await tx.$executeRawUnsafe('SET @rpms_purge = NULL');
    }

    const history = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ');
    await audit(tx, actor, {
      action: 'BUILDING_DELETED', entityType: 'Building', entityId: id,
      summary: `Building ${building.name} deleted with ${building.floors.length} floor(s), ${roomIds.length} room(s)${history ? ` and all its history (${history})` : ''}`,
      oldValue: { ...building, deleted: counts },
    });
    return { entityIds };
  });
  await removeDocumentsFor(actor.orgId, removed.entityIds);
}

async function removeDocumentsFor(orgId: string, entityIds: string[]) {
  if (!entityIds.length) return;
  const docs = await prisma.document.findMany({ where: { orgId, entityId: { in: entityIds } } });
  await prisma.document.deleteMany({ where: { id: { in: docs.map((d) => d.id) } } });
  for (const d of docs) await unlink(join(resolve(config.STORAGE_DIR), d.storedName)).catch((err) => logger.warn({ err, file: d.storedName }, 'document file not removed'));
}

export async function deleteTenant(actor: Actor, id: string) {
  await inTransaction(async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id, orgId: actor.orgId } });
    if (!tenant) throw notFound('Tenant');
    const [contracts, charges, payments, deposits, reservations] = await Promise.all([
      tx.contract.count({ where: { tenantId: id, status: { not: 'DRAFT' } } }),
      tx.rentCharge.count({ where: { tenantId: id } }),
      tx.payment.count({ where: { tenantId: id } }),
      tx.depositTransaction.count({ where: { contract: { tenantId: id } } }),
      tx.reservation.count({ where: { tenantId: id, status: 'ACTIVE' } }),
    ]);
    const h: History = { contracts, charges, payments, deposits, expenses: 0, maintenance: 0, reservations };
    if (hasHistory(h)) {
      throw conflict(`${tenant.fullName} cannot be deleted because they have history (${describe(h)}). Their rent and payment records must be kept. If they have left, terminate the contract; the tenant is then shown as Former.`, 'HAS_HISTORY', h);
    }
    await tx.contract.deleteMany({ where: { tenantId: id, status: 'DRAFT' } });
    await tx.reservation.updateMany({ where: { tenantId: id }, data: { tenantId: null } });
    await tx.messageLog.deleteMany({ where: { tenantId: id } });
    await tx.tenant.delete({ where: { id } });
    await audit(tx, actor, { action: 'TENANT_DELETED', entityType: 'Tenant', entityId: id, summary: `Tenant ${tenant.fullName} (ID ${tenant.idNumber}) deleted — no contracts or payments`, oldValue: tenant });
  });
  await removeDocuments(actor.orgId, 'Tenant', [id]);
}
